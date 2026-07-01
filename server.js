/**
 * KLIP — Custom Video Downloader Backend v5
 * Engine: yt-dlp + ffmpeg
 * Key fix: --print instead of --dump-json for info
 * (--dump-json validates formats internally and fails on some videos;
 *  --print skips format selection entirely — much more reliable)
 */

const express    = require('express');
const cors       = require('cors');
const { spawn, execSync } = require('child_process');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─── AUTO-UPDATE yt-dlp ON STARTUP ─────────────────────── */
console.log('[INIT] Updating yt-dlp to latest…');
try {
  execSync('yt-dlp -U 2>&1', { timeout: 60000 });
  const ver = execSync('yt-dlp --version').toString().trim();
  console.log('[INIT] yt-dlp', ver, '✓');
} catch (e) {
  console.warn('[INIT] yt-dlp update skipped:', e.message.slice(0,80));
}

/* ─── COOKIES ────────────────────────────────────────────── */
let COOKIES_PATH = null;
if (process.env.YT_COOKIES) {
  COOKIES_PATH = path.join(os.tmpdir(), 'klip-cookies.txt');
  fs.writeFileSync(COOKIES_PATH, process.env.YT_COOKIES);
  console.log('[COOKIES] Loaded from env ✓');
} else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
  COOKIES_PATH = path.join(__dirname, 'cookies.txt');
  console.log('[COOKIES] Loaded from file ✓');
} else {
  console.log('[COOKIES] None — iOS client fallback');
}

/* ─── ANTI-BOT ARGS ──────────────────────────────────────── */
function antiBotArgs() {
  if (COOKIES_PATH) {
    // Cookies present → standard web client (most formats) + cookies
    return ['--cookies', COOKIES_PATH];
  }
  // No cookies → iOS client to bypass lighter bot checks
  return [
    '--extractor-args', 'youtube:player_client=ios',
    '--user-agent', 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iPhone OS 17_5_1 like Mac OS X)',
  ];
}

/* ─── HELPERS ────────────────────────────────────────────── */
function isYouTube(url) {
  try {
    const h = new URL(url).hostname;
    return ['youtube.com','www.youtube.com','youtu.be','music.youtube.com'].includes(h);
  } catch { return false; }
}
function fmtTime(sec) {
  if (!sec) return '0:00';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}
function fmtViews(n) {
  if (!n) return null;
  if (n>=1e9) return (n/1e9).toFixed(1)+'B views';
  if (n>=1e6) return (n/1e6).toFixed(1)+'M views';
  if (n>=1e3) return Math.round(n/1e3)+'K views';
  return n+' views';
}
function uid() { return Date.now()+'_'+Math.random().toString(36).slice(2,8); }
function findFile(p) {
  return fs.readdirSync(os.tmpdir()).filter(f=>f.startsWith(p))
    .map(f=>path.join(os.tmpdir(),f))[0]||null;
}
function cleanup(f) { try { if(f&&fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
function heightOf(f) {
  if (!f?.height) return null;
  return Math.min(f.height, f.width||f.height);
}
const BPS = {2160:35000,1440:16000,1080:8000,720:5000,480:2500,360:1000};
function estBytes(h,d) { return Math.round(((BPS[h]||1500)*1000/8)*(d||0)); }
function publicError(s) {
  if (/Sign in|bot|verif/i.test(s))    return 'This video is temporarily unavailable. Please try again shortly.';
  if (/Private video/i.test(s))         return 'This video is private.';
  if (/unavailable|removed/i.test(s))   return 'This video is unavailable or has been removed.';
  if (/age.?restrict/i.test(s))         return 'This video is age-restricted.';
  if (/429/i.test(s))                   return 'Too many requests — please wait a moment.';
  if (/copyright|blocked/i.test(s))     return 'This video is blocked for copyright reasons.';
  if (/format.*not available/i.test(s)) return 'This quality is unavailable — please try a lower resolution.';
  return 'Could not process this video. Please try a different link.';
}

/* ─── RATE LIMITER ───────────────────────────────────────── */
const RL = new Map();
function rateLimit(req,res,next) {
  const ip=req.ip||'', now=Date.now(), w=RL.get(ip)||{n:0,t:now};
  if(now-w.t>60000){w.n=0;w.t=now;} w.n++; RL.set(ip,w);
  if(w.n>6) return res.status(429).json({error:'Too many requests — wait a minute.'});
  next();
}

/* ─── POST /api/info ─────────────────────────────────────── */
// THE FIX: use --print with a JSON template instead of --dump-json.
// --dump-json internally validates the selected format, causing
// "format not available" on many videos. --print skips all
// format selection and just extracts raw metadata fields.
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isYouTube(url))
    return res.status(400).json({ error: 'Please enter a valid YouTube link.' });

  // Build a JSON string directly in the yt-dlp template.
  // %(field)j → JSON-encoded value (null if missing).
  // %(uploader|channel)j → uploader, falling back to channel name.
  const tpl = [
    '{"id":%(id)j',
    '"title":%(title)j',
    '"author":%(uploader|channel)j',
    '"thumbnail":%(thumbnail)j',
    '"duration":%(duration)j',
    '"view_count":%(view_count)j',
    '"formats":%(formats)j}'
  ].join(',');

  let out='', err='';
  const args = [
    '--print', tpl,
    '--no-warnings',
    '--skip-download',
    '--no-playlist',
    ...antiBotArgs(),
    url
  ];

  console.log('[INFO] Fetching:', url);
  const proc = spawn('yt-dlp', args);
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);

  proc.on('close', code => {
    if (code !== 0) {
      console.error('[INFO FAIL]', err.slice(-600));
      return res.status(404).json({ error: publicError(err) });
    }
    try {
      const v = JSON.parse(out.trim());
      const dur = v.duration || 0;

      // Build quality list from real formats
      const sizeMap = {};
      (v.formats||[]).forEach(f => {
        if (!f.vcodec||f.vcodec==='none') return;
        const h = heightOf(f); if (!h) return;
        const sz = f.filesize||f.filesize_approx||0;
        if (!sizeMap[h]||sz>sizeMap[h]) sizeMap[h]=sz;
      });

      let qualities = Object.keys(sizeMap).map(Number)
        .sort((a,b)=>b-a)
        .map(h=>({height:h, bytes:sizeMap[h]||estBytes(h,dur)}));

      if (!qualities.length)
        qualities=[1080,720,480,360].map(h=>({height:h,bytes:estBytes(h,dur)}));

      const audioSizes={};
      [320,256,128].forEach(k=>{audioSizes[k]=Math.round((k*1000/8)*dur);});

      console.log(`[INFO OK] "${v.title}" — up to ${qualities[0].height}p (${qualities.length} qualities)`);
      res.json({
        id:        v.id,
        title:     v.title,
        author:    v.author||'Unknown',
        thumbnail: v.thumbnail,
        duration:  fmtTime(dur),
        views:     fmtViews(v.view_count),
        isShort:   dur>0&&dur<=60,
        qualities,
        audioSizes
      });
    } catch(e) {
      console.error('[INFO PARSE]', e.message, '\nRAW OUTPUT:', out.slice(0,300));
      res.status(500).json({ error: 'Could not read video info — please try again.' });
    }
  });
  proc.on('error', e => {
    console.error('[INFO SPAWN]', e.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  });
});

/* ─── GET /api/download ──────────────────────────────────── */
app.get('/api/download', rateLimit, (req, res) => {
  const { url, quality, mode, bitrate } = req.query;
  if (!url||!isYouTube(decodeURIComponent(url)))
    return res.status(400).json({ error: 'Invalid link.' });

  const ytUrl=decodeURIComponent(url), isAudio=mode==='audio';
  const id=uid(), outTpl=path.join(os.tmpdir(),`klip-${id}.%(ext)s`);

  let args;
  if (isAudio) {
    const aqMap={'320':'0','256':'2','128':'5'};
    args=['-f','bestaudio/best',
      '--extract-audio','--audio-format','mp3',
      '--audio-quality',aqMap[bitrate]||'0',
      '--no-playlist','--no-warnings',
      ...antiBotArgs(),'-o',outTpl,ytUrl];
  } else {
    const h=parseInt(quality)||1080;
    // Permissive format chain — no [ext=mp4] restrictions
    const fmt=[
      `bestvideo[height<=${h}]+bestaudio`,
      `bestvideo[height<=${h}]`,
      `best[height<=${h}]`,
      'best'
    ].join('/');
    args=['-f',fmt,'--merge-output-format','mp4',
      '--no-playlist','--no-warnings',
      ...antiBotArgs(),'-o',outTpl,ytUrl];
  }

  const label=isAudio?`MP3 ${bitrate}k`:`${quality}p MP4`;
  console.log(`[DL START] ${label}`);

  const proc=spawn('yt-dlp',args);
  let stderr='';
  proc.stderr.on('data',d=>{stderr+=d;});

  proc.on('close',code=>{
    if(code!==0){
      console.error(`[DL FAIL] ${label}\n`,stderr.slice(-600));
      if(!res.headersSent) res.status(500).json({error:publicError(stderr)});
      return;
    }
    const outFile=findFile(`klip-${id}`);
    if(!outFile) return res.status(500).json({error:'File not created — try again.'});

    const stat=fs.statSync(outFile);
    const ext=path.extname(outFile).slice(1)||(isAudio?'mp3':'mp4');
    const ctype=ext==='mp3'?'audio/mpeg':'video/mp4';
    const fname=`klip-${isAudio?'audio':quality+'p'}.${ext}`;

    console.log(`[DL DONE] ${fname} — ${(stat.size/1048576).toFixed(1)} MB`);
    res.setHeader('Content-Disposition',`attachment; filename="${fname}"`);
    res.setHeader('Content-Type',ctype);
    res.setHeader('Content-Length',stat.size);

    const stream=fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('end',()=>cleanup(outFile));
    stream.on('error',()=>cleanup(outFile));
    req.on('close',()=>{stream.destroy();cleanup(outFile);});
  });
  proc.on('error',e=>{
    console.error('[DL SPAWN]',e.message);
    if(!res.headersSent) res.status(500).json({error:'Something went wrong — try again.'});
  });
});

/* ─── GET /api/health ────────────────────────────────────── */
app.get('/api/health',(req,res)=>{
  let ytdlp='not found',ffmpeg='not found';
  try{ytdlp=execSync('yt-dlp --version',{timeout:5000}).toString().trim();}catch{}
  try{ffmpeg=execSync('ffmpeg -version 2>&1',{timeout:5000}).toString().split('\n')[0];}catch{}
  res.json({status:'online',ytdlp,ffmpeg,
    cookies:COOKIES_PATH?'loaded ✓':'not set',
    uptime:Math.floor(process.uptime())+'s'});
});

/* ─── GET /api/debug?url=... ─────────────────────────────── */
app.get('/api/debug',(req,res)=>{
  const {url}=req.query;
  if(!url) return res.json({error:'Pass ?url=YOUTUBE_URL'});

  const botArgs=antiBotArgs();
  const tpl=[
    '{"id":%(id)j','"title":%(title)j','"author":%(uploader|channel)j',
    '"thumbnail":%(thumbnail)j','"duration":%(duration)j',
    '"view_count":%(view_count)j','"formats":%(formats)j}'
  ].join(',');

  const allArgs=['--print',tpl,'--no-warnings','--skip-download','--no-playlist',...botArgs,url];
  let out='',err='';
  const proc=spawn('yt-dlp',allArgs);
  proc.stdout.on('data',d=>out+=d);
  proc.stderr.on('data',d=>err+=d);
  proc.on('close',code=>{
    let parsed=null;
    try{
      const v=JSON.parse(out.trim());
      parsed={title:v.title,author:v.author,duration:v.duration,
        formatCount:v.formats?.length,
        topFormats:v.formats?.slice(0,5).map(f=>({
          id:f.format_id,height:f.height,
          vcodec:f.vcodec?.slice(0,10),acodec:f.acodec?.slice(0,10)
        }))};
    }catch(e){parsed={parseError:e.message,rawSlice:out.slice(0,200)};}
    res.json({
      exitCode:code, stderr:err.slice(-800),
      parsedInfo:parsed,
      cookies:COOKIES_PATH?'loaded ✓':'none',
      fullArgs:allArgs,   // ← shows EVERY arg actually passed to yt-dlp
      version:'v5'        // ← confirm new code is running
    });
  });
  proc.on('error',e=>res.json({spawnError:e.message}));
});

/* ─── START ──────────────────────────────────────────────── */
const PORT=process.env.PORT||3001;
app.listen(PORT,()=>{
  console.log(`
  ╔══════════════════════════════════════╗
  ║  KLIP v5 — Port ${PORT}               ║
  ║  Cookies : ${COOKIES_PATH?'YES ✓':'NO  (iOS fallback)'}           ║
  ║  Fix     : --print (no fmt select)  ║
  ╚══════════════════════════════════════╝`);
});
