/**
 * KLIP — Video Downloader Backend v7
 * Permanent fix: retry mechanism + multiple client fallbacks
 * No cookies dependency for normal videos
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

/* ─── AUTO-UPDATE ────────────────────────────────────────── */
console.log('[INIT] Updating yt-dlp…');
try {
  execSync('yt-dlp -U 2>&1', { timeout: 60000 });
  const ver = execSync('yt-dlp --version').toString().trim();
  console.log('[INIT] yt-dlp', ver, '✓');
} catch (e) { console.warn('[INIT]', e.message.slice(0, 80)); }

/* ─── COOKIES (optional — only for age-restricted content) ── */
let COOKIES_PATH = null;
if (process.env.YT_COOKIES) {
  COOKIES_PATH = path.join(os.tmpdir(), 'klip-cookies.txt');
  fs.writeFileSync(COOKIES_PATH, process.env.YT_COOKIES);
  console.log('[COOKIES] Env loaded (age-restricted support ✓)');
} else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
  COOKIES_PATH = path.join(__dirname, 'cookies.txt');
  console.log('[COOKIES] File loaded (age-restricted support ✓)');
} else {
  console.log('[COOKIES] None — normal videos work without cookies');
}

/* ─── yt-dlp PROMISE WRAPPER ─────────────────────────────── */
function ytdlp(args, timeoutMs = 60000) {
  return new Promise(resolve => {
    let out = '', err = '';
    const proc = spawn('yt-dlp', args);
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => resolve({ code, out, err }));
    proc.on('error', e  => resolve({ code: -1, out: '', err: e.message }));
    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  });
}

/* ─── ATTEMPT STRATEGIES ─────────────────────────────────── */
// Each strategy is tried in order until one succeeds.
// This makes the server permanently resilient:
//  - No cookies? tv_embedded handles it.
//  - Expired cookies? No-cookies strategies still work.
//  - tv_embedded blocked? ios or android_creator fallback.
function infoStrategies(url) {
  const base = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    // "b/w" = best, or if nothing else worst — ALWAYS matches something
    '-f', 'b/w',
  ];
  const strategies = [
    // 1. tv_embedded — minimal bot-check, works on cloud IPs
    [...base, '--extractor-args', 'youtube:player_client=tv_embedded', url],
    // 2. tv_embedded + ios fallback
    [...base, '--extractor-args', 'youtube:player_client=tv_embedded,ios', url],
    // 3. android_creator — different auth path
    [...base, '--extractor-args', 'youtube:player_client=android_creator', url],
    // 4. ios alone
    [...base, '--extractor-args', 'youtube:player_client=ios', url],
    // 5. With cookies (if available) + tv_embedded
    ...(COOKIES_PATH ? [
      [...base, '--extractor-args', 'youtube:player_client=tv_embedded,web', '--cookies', COOKIES_PATH, url],
    ] : []),
  ];
  return strategies;
}

function downloadStrategies(url, fmtString, outTpl, extra = []) {
  const base = [
    '-f', fmtString,
    '--no-playlist',
    '--no-warnings',
    ...extra,
    '-o', outTpl,
  ];
  const strategies = [
    [...base, '--extractor-args', 'youtube:player_client=tv_embedded', url],
    [...base, '--extractor-args', 'youtube:player_client=tv_embedded,ios', url],
    [...base, '--extractor-args', 'youtube:player_client=android_creator', url],
    [...base, '--extractor-args', 'youtube:player_client=ios', url],
    ...(COOKIES_PATH ? [
      [...base, '--extractor-args', 'youtube:player_client=tv_embedded,web', '--cookies', COOKIES_PATH, url],
    ] : []),
  ];
  return strategies;
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

const STD_H = new Set([144,240,360,480,720,1080,1440,2160]);
function heightOf(f) {
  if (!f) return null;
  if (f.format_note) {
    const m = String(f.format_note).match(/^(\d+)p/);
    if (m) return parseInt(m[1]);
  }
  const h = f.height||0, w = f.width||0;
  if (h && w) return Math.min(h,w);
  return h||null;
}
const BPS = {2160:35000,1440:16000,1080:8000,720:5000,480:2500,360:1000};
function estBytes(h,d) { return Math.round(((BPS[h]||1500)*1000/8)*(d||0)); }

function publicError(s) {
  if (/Sign in|bot|verif/i.test(s))   return 'This video is temporarily unavailable. Please try again.';
  if (/Private video/i.test(s))        return 'This video is private.';
  if (/unavailable|removed/i.test(s))  return 'This video is unavailable or has been removed.';
  if (/age.?restrict/i.test(s))        return 'This video is age-restricted.';
  if (/429/i.test(s))                  return 'Too many requests — please wait a moment.';
  if (/copyright|blocked/i.test(s))    return 'This video is blocked for copyright reasons.';
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
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || !isYouTube(url))
    return res.status(400).json({ error: 'Please enter a valid YouTube link.' });

  console.log('[INFO] Fetching:', url);
  const strategies = infoStrategies(url);
  let lastErr = '';

  for (let i = 0; i < strategies.length; i++) {
    const { code, out, err } = await ytdlp(strategies[i], 50000);
    if (code === 0 && out.trim()) {
      try {
        const v = JSON.parse(out.trim());
        const dur = v.duration || 0;

        const sizeMap = {};
        let bestAudioBytes = 0;

        (v.formats||[]).forEach(f => {
          const isVid = f.vcodec && f.vcodec !== 'none';
          const isAud = (!f.vcodec||f.vcodec==='none') && f.acodec && f.acodec !== 'none';
          if (isAud) {
            const sz = f.filesize||f.filesize_approx||0;
            if (sz > bestAudioBytes) bestAudioBytes = sz;
            return;
          }
          if (!isVid) return;
          const h = heightOf(f); if (!h) return;
          if (!STD_H.has(h)) return;
          const sz = f.filesize||f.filesize_approx||0;
          if (!sizeMap[h]||sz>sizeMap[h]) sizeMap[h]=sz;
        });

        if (!Object.keys(sizeMap).length) {
          (v.formats||[]).forEach(f => {
            if (!f.vcodec||f.vcodec==='none') return;
            const h = heightOf(f); if (!h) return;
            const sz = f.filesize||f.filesize_approx||0;
            if (!sizeMap[h]||sz>sizeMap[h]) sizeMap[h]=sz;
          });
        }

        let qualities = Object.keys(sizeMap).map(Number).sort((a,b)=>b-a)
          .map(h => ({
            height: h,
            bytes: (sizeMap[h]||estBytes(h,dur)) + (bestAudioBytes||Math.round((192000/8)*dur))
          }));

        if (!qualities.length)
          qualities = [1080,720,480,360].map(h=>({height:h,bytes:estBytes(h,dur)}));

        const audioSizes={};
        [320,256,128].forEach(k=>{audioSizes[k]=Math.round((k*1000/8)*dur);});

        console.log(`[INFO OK] strategy ${i+1} — "${v.title}" — up to ${qualities[0].height}p`);
        return res.json({
          id: v.id, title: v.title,
          author: v.uploader||v.channel||'Unknown',
          thumbnail: v.thumbnail,
          duration: fmtTime(dur), views: fmtViews(v.view_count),
          isShort: dur>0&&dur<=60,
          qualities, audioSizes
        });
      } catch(e) {
        lastErr = 'Parse error: ' + e.message;
        console.warn(`[INFO] Strategy ${i+1} parse failed:`, e.message);
        continue;
      }
    }
    lastErr = err;
    console.warn(`[INFO] Strategy ${i+1} failed (code ${code}):`, err.slice(-150));
  }

  console.error('[INFO] All strategies failed:', lastErr.slice(-300));
  res.status(404).json({ error: publicError(lastErr) });
});

/* ─── GET /api/download ──────────────────────────────────── */
app.get('/api/download', rateLimit, async (req, res) => {
  const { url, quality, mode, bitrate } = req.query;
  if (!url||!isYouTube(decodeURIComponent(url)))
    return res.status(400).json({ error: 'Invalid link.' });

  const ytUrl   = decodeURIComponent(url);
  const isAudio = mode === 'audio';
  const id      = uid();
  const outTpl  = path.join(os.tmpdir(), `klip-${id}.%(ext)s`);

  let fmtString, extra;
  if (isAudio) {
    const aqMap = {'320':'0','256':'2','128':'5'};
    fmtString = 'bestaudio/best';
    extra = [
      '--extract-audio', '--audio-format', 'mp3',
      '--audio-quality', aqMap[bitrate]||'0',
    ];
  } else {
    const h = parseInt(quality)||1080;
    fmtString = [
      `bestvideo[height<=${h}]+bestaudio`,
      `bestvideo[height<=${h}]`,
      `best[height<=${h}]`,
      'best'
    ].join('/');
    extra = ['--merge-output-format', 'mp4'];
  }

  const label = isAudio ? `MP3 ${bitrate}k` : `${quality}p`;
  console.log(`[DL START] ${label} — ${ytUrl}`);

  const strategies = downloadStrategies(ytUrl, fmtString, outTpl, extra);

  for (let i = 0; i < strategies.length; i++) {
    const { code, err } = await ytdlp(strategies[i], 300000); // 5 min timeout for big files
    if (code === 0) {
      const outFile = findFile(`klip-${id}`);
      if (!outFile) continue;

      const stat  = fs.statSync(outFile);
      const ext   = path.extname(outFile).slice(1)||(isAudio?'mp3':'mp4');
      const ctype = ext==='mp3'?'audio/mpeg':'video/mp4';
      const fname = `klip-${isAudio?'audio':quality+'p'}.${ext}`;

      console.log(`[DL DONE] strategy ${i+1} — ${fname} — ${(stat.size/1048576).toFixed(1)} MB`);
      res.setHeader('Content-Disposition',`attachment; filename="${fname}"`);
      res.setHeader('Content-Type',ctype);
      res.setHeader('Content-Length',stat.size);

      const stream = fs.createReadStream(outFile);
      stream.pipe(res);
      stream.on('end',  ()=>cleanup(outFile));
      stream.on('error',()=>cleanup(outFile));
      req.on('close',   ()=>{stream.destroy();cleanup(outFile);});
      return;
    }
    console.warn(`[DL] Strategy ${i+1} failed (code ${code}):`, err.slice(-150));
    cleanup(findFile(`klip-${id}`));
  }

  if (!res.headersSent)
    res.status(500).json({ error: 'Could not download this video. Please try a different quality.' });
});

/* ─── GET /api/health ────────────────────────────────────── */
app.get('/api/health',(req,res)=>{
  let ytdlpVer='not found', ffmpegVer='not found';
  try{ytdlpVer=execSync('yt-dlp --version',{timeout:5000}).toString().trim();}catch{}
  try{ffmpegVer=execSync('ffmpeg -version 2>&1',{timeout:5000}).toString().split('\n')[0];}catch{}
  res.json({
    status:'online', ytdlp:ytdlpVer, ffmpeg:ffmpegVer,
    cookies: COOKIES_PATH?'loaded (age-restricted support)':'not set (not needed)',
    uptime: Math.floor(process.uptime())+'s',
    version:'v7'
  });
});

/* ─── GET /api/debug?url=... ─────────────────────────────── */
app.get('/api/debug', async (req,res)=>{
  const {url} = req.query;
  if (!url) return res.json({error:'Pass ?url=YOUTUBE_URL'});

  const strategies = infoStrategies(url);
  const results = [];

  for (let i = 0; i < strategies.length; i++) {
    const {code,out,err} = await ytdlp(strategies[i], 30000);
    let parsed = null;
    if (code===0) {
      try {
        const v = JSON.parse(out.trim());
        parsed = { title:v.title, formats:v.formats?.length };
      } catch(e) { parsed = {parseError:e.message}; }
    }
    results.push({
      strategy: i+1,
      args: strategies[i].filter(a=>!a.includes('cookies')), // hide cookie path
      exitCode: code,
      stderr: err.slice(-300),
      parsedInfo: parsed,
      success: code===0 && !!parsed?.title
    });
    if (parsed?.title) break; // stop at first success
  }

  res.json({
    version: 'v7',
    cookies: COOKIES_PATH?'loaded':'not set',
    results
  });
});

/* ─── START ──────────────────────────────────────────────── */
const PORT = process.env.PORT||3001;
app.listen(PORT,()=>{
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  KLIP v7 — Port ${PORT}                   ║
  ║  Strategies: tv_embedded → ios → android ║
  ║  Cookies: ${COOKIES_PATH?'YES (optional enhancement)':'NO  (works without them)   '}  ║
  ╚══════════════════════════════════════════╝`);
});
