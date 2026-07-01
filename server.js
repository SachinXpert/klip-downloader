/**
 * KLIP — Custom Video Downloader Backend
 * Engine: yt-dlp + ffmpeg (100% self-hosted)
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

/* ──────────────────────────────────────────────
   AUTO-UPDATE yt-dlp ON EVERY STARTUP
   YouTube changes weekly — always run latest.
────────────────────────────────────────────── */
console.log('[INIT] Updating yt-dlp to latest version…');
try {
  const out = execSync('yt-dlp -U 2>&1', { timeout: 60000 }).toString().trim();
  console.log('[INIT]', out.split('\n').slice(-1)[0]);
} catch (e) {
  console.warn('[INIT] yt-dlp update skipped:', e.message.slice(0, 120));
}

/* ──────────────────────────────────────────────
   COOKIES SETUP
   Set YT_COOKIES env variable in Railway → Variables
   with the full text of your youtube.com cookies.txt
────────────────────────────────────────────── */
let COOKIES_PATH = null;
if (process.env.YT_COOKIES) {
  COOKIES_PATH = path.join(os.tmpdir(), 'klip-cookies.txt');
  fs.writeFileSync(COOKIES_PATH, process.env.YT_COOKIES);
  console.log('[COOKIES] Loaded from YT_COOKIES env ✓');
} else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
  COOKIES_PATH = path.join(__dirname, 'cookies.txt');
  console.log('[COOKIES] Loaded from local file ✓');
} else {
  console.log('[COOKIES] None set — using client spoofing only');
}

/* ──────────────────────────────────────────────
   ANTI-BOT ARGS
   Try iOS client first (least restricted by YouTube
   for datacenter IPs), with cookies if available.
────────────────────────────────────────────── */
function antiBotArgs() {
  const args = [
    '--extractor-args', 'youtube:player_client=ios,mweb',
    '--user-agent',
    'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iPhone OS 17_5_1 like Mac OS X)',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
  ];
  if (COOKIES_PATH) args.push('--cookies', COOKIES_PATH);
  return args;
}

/* ──────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────── */
function isYouTube(url) {
  try {
    const h = new URL(url).hostname;
    return ['youtube.com','www.youtube.com','youtu.be','music.youtube.com'].includes(h);
  } catch { return false; }
}

function fmtTime(sec) {
  if (!sec) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function fmtViews(n) {
  if (!n) return null;
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B views';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M views';
  if (n >= 1e3) return Math.round(n/1e3)+'K views';
  return n+' views';
}

function uid() {
  return Date.now()+'_'+Math.random().toString(36).slice(2,8);
}

function findFile(prefix) {
  return fs.readdirSync(os.tmpdir())
    .filter(f => f.startsWith(prefix))
    .map(f => path.join(os.tmpdir(), f))[0] || null;
}

function cleanup(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

function heightOf(f) {
  if (!f || !f.height) return null;
  return Math.min(f.height, f.width || f.height);
}

const BITRATE_GUESS = {2160:35000,1440:16000,1080:8000,720:5000,480:2500,360:1000};
function estimateBytes(h, dur) {
  return Math.round(((BITRATE_GUESS[h]||1500)*1000/8)*(dur||0));
}

// Public-safe error messages — raw stderr goes to Railway logs only
function publicError(stderr) {
  if (/Sign in to confirm|bot|verif/i.test(stderr))
    return "This video can't be loaded right now. Please try again in a moment.";
  if (/Private video/i.test(stderr))
    return 'This video is private.';
  if (/Video unavailable|has been removed/i.test(stderr))
    return 'This video has been removed or is unavailable.';
  if (/age.?restrict/i.test(stderr))
    return 'This video is age-restricted.';
  if (/429/i.test(stderr))
    return 'Too many requests — please wait a minute and try again.';
  if (/copyright|blocked/i.test(stderr))
    return 'This video is blocked in your region or removed for copyright.';
  return 'Could not process this video. Please try a different link.';
}

/* ──────────────────────────────────────────────
   RATE LIMITER
────────────────────────────────────────────── */
const RL = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || '';
  const now = Date.now();
  const w   = RL.get(ip) || { n: 0, t: now };
  if (now - w.t > 60000) { w.n = 0; w.t = now; }
  w.n++; RL.set(ip, w);
  if (w.n > 6) return res.status(429).json({ error: 'Too many requests — please wait a minute.' });
  next();
}

/* ──────────────────────────────────────────────
   POST /api/info
   Returns video metadata + real available qualities
────────────────────────────────────────────── */
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isYouTube(url))
    return res.status(400).json({ error: 'Please enter a valid YouTube link.' });

  let out = '', err = '';

  const proc = spawn('yt-dlp', [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    ...antiBotArgs(),
    url
  ]);

  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);

  proc.on('close', code => {
    if (code !== 0) {
      console.error('[INFO FAIL]', err.slice(-600));
      return res.status(404).json({ error: publicError(err) });
    }
    try {
      const v = JSON.parse(out);
      const dur = v.duration || 0;

      // Real available resolutions from this video's format list
      const sizeMap = {};
      (v.formats || []).forEach(f => {
        if (!f.vcodec || f.vcodec === 'none') return;
        const h = heightOf(f);
        if (!h) return;
        const sz = f.filesize || f.filesize_approx || 0;
        if (!sizeMap[h] || sz > sizeMap[h]) sizeMap[h] = sz;
      });

      let qualities = Object.keys(sizeMap)
        .map(h => parseInt(h))
        .sort((a, b) => b - a)
        .map(h => ({ height: h, bytes: sizeMap[h] || estimateBytes(h, dur) }));

      if (!qualities.length)
        qualities = [1080,720,480,360].map(h => ({ height:h, bytes:estimateBytes(h,dur) }));

      const audioSizes = {};
      [320,256,128].forEach(k => { audioSizes[k] = Math.round((k*1000/8)*dur); });

      console.log(`[INFO OK] "${v.title}" — up to ${qualities[0].height}p`);
      res.json({
        id:        v.id,
        title:     v.title,
        author:    v.uploader || v.channel || 'Unknown',
        thumbnail: v.thumbnail,
        duration:  fmtTime(dur),
        views:     fmtViews(v.view_count),
        isShort:   dur > 0 && dur <= 60,
        qualities,
        audioSizes
      });
    } catch(e) {
      console.error('[INFO PARSE]', e.message);
      res.status(500).json({ error: 'Could not read video info — please try again.' });
    }
  });

  proc.on('error', e => {
    console.error('[INFO SPAWN]', e.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  });
});

/* ──────────────────────────────────────────────
   GET /api/download
   Downloads and streams the file to browser
────────────────────────────────────────────── */
app.get('/api/download', rateLimit, (req, res) => {
  const { url, quality, mode, bitrate } = req.query;
  if (!url || !isYouTube(decodeURIComponent(url)))
    return res.status(400).json({ error: 'Invalid link.' });

  const ytUrl   = decodeURIComponent(url);
  const isAudio = mode === 'audio';
  const id      = uid();
  const outTpl  = path.join(os.tmpdir(), `klip-${id}.%(ext)s`);

  let args;
  if (isAudio) {
    const aqMap = { '320':'0', '256':'2', '128':'5' };
    args = [
      '-f', 'bestaudio/best',
      '--extract-audio', '--audio-format', 'mp3',
      '--audio-quality', aqMap[bitrate]||'0',
      '--no-playlist', '--no-warnings',
      ...antiBotArgs(),
      '-o', outTpl, ytUrl
    ];
  } else {
    const h   = parseInt(quality)||1080;
    const fmt = [
      `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${h}]+bestaudio`,
      `best[height<=${h}][ext=mp4]`,
      `best[height<=${h}]`,
      'best'
    ].join('/');
    args = [
      '-f', fmt, '--merge-output-format', 'mp4',
      '--no-playlist', '--no-warnings',
      ...antiBotArgs(),
      '-o', outTpl, ytUrl
    ];
  }

  const label = isAudio ? `MP3 ${bitrate}k` : `${quality}p MP4`;
  console.log(`[DL START] ${label} — ${ytUrl}`);

  const proc = spawn('yt-dlp', args);
  let stderr  = '';
  proc.stderr.on('data', d => { stderr += d; });

  proc.on('close', code => {
    if (code !== 0) {
      console.error(`[DL FAIL] ${label}\n`, stderr.slice(-600));
      if (!res.headersSent) res.status(500).json({ error: publicError(stderr) });
      return;
    }
    const outFile = findFile(`klip-${id}`);
    if (!outFile) {
      console.error('[DL FAIL] Output file missing');
      return res.status(500).json({ error: 'File not created — please try again.' });
    }
    const stat  = fs.statSync(outFile);
    const ext   = path.extname(outFile).slice(1) || (isAudio ? 'mp3' : 'mp4');
    const ctype = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    const fname = `klip-${isAudio ? 'audio' : quality+'p'}.${ext}`;

    console.log(`[DL DONE] ${fname} — ${(stat.size/1048576).toFixed(1)} MB`);
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', ctype);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('end',   () => cleanup(outFile));
    stream.on('error', () => cleanup(outFile));
    req.on('close',    () => { stream.destroy(); cleanup(outFile); });
  });

  proc.on('error', e => {
    console.error('[DL SPAWN]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong — please try again.' });
  });
});

/* ──────────────────────────────────────────────
   GET /api/health  (private — for you only)
────────────────────────────────────────────── */
app.get('/api/health', (req, res) => {
  let ytdlp = 'not found', ffmpeg = 'not found';
  try { ytdlp  = execSync('yt-dlp --version', { timeout:5000 }).toString().trim(); } catch {}
  try { ffmpeg = execSync('ffmpeg -version 2>&1', { timeout:5000 }).toString().split('\n')[0]; } catch {}
  res.json({ status:'online', ytdlp, ffmpeg,
    cookies: COOKIES_PATH ? 'loaded ✓' : 'not set',
    uptime: Math.floor(process.uptime())+'s' });
});

/* ──────────────────────────────────────────────
   GET /api/debug?url=...  (private — for you only)
   Shows RAW yt-dlp output so you can see exact errors
   e.g. /api/debug?url=https://youtu.be/dQw4w9WgXcQ
────────────────────────────────────────────── */
app.get('/api/debug', (req, res) => {
  const { url } = req.query;
  if (!url) return res.json({ error: 'Pass ?url=YOUTUBE_URL' });

  let out='', err='';
  const proc = spawn('yt-dlp', [
    '--dump-json', '--no-playlist', '--no-warnings', '--skip-download',
    ...antiBotArgs(), url
  ]);
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('close', code => {
    let parsed = null;
    try { const v = JSON.parse(out); parsed = { title: v.title, formats: v.formats?.length, topFormats: v.formats?.slice(0,3).map(f=>({height:f.height,vcodec:f.vcodec,acodec:f.acodec})) }; } catch {}
    res.json({ exitCode: code, stderr: err.slice(-800), parsedInfo: parsed,
      cookies: COOKIES_PATH ? 'loaded' : 'none', client: 'ios,mweb' });
  });
  proc.on('error', e => res.json({ spawnError: e.message }));
});

/* ──────────────────────────────────────────────
   START
────────────────────────────────────────────── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   KLIP — Video Downloader              ║
  ║   Port: ${PORT}                           ║
  ╚════════════════════════════════════════╝
  Health : /api/health
  Debug  : /api/debug?url=YOUTUBE_URL
  `);
});
