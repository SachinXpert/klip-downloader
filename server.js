/**
 * ═══════════════════════════════════════════════
 *   KLIP — Custom Video Downloader Backend
 *   Engine: yt-dlp + ffmpeg (100% self-hosted)
 *   Zero external API calls
 * ═══════════════════════════════════════════════
 *
 *  Change "KLIP" to your brand name anywhere below.
 *
 *  Requirements (install once on server):
 *    pip install yt-dlp
 *    apt install ffmpeg   (or brew install ffmpeg on Mac)
 *    npm install
 *
 *  NOTE: every res.json({error: ...}) string below is shown
 *  directly to PUBLIC visitors — keep them simple and free of
 *  implementation details (yt-dlp, cookies, server, etc).
 *  Use console.error/log for anything technical — that only
 *  shows up in YOUR Railway logs, never on the website.
 */

const express   = require('express');
const cors      = require('cors');
const { spawn } = require('child_process');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');

const app = express();

// ─── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple rate limiter (max 5 downloads per IP per minute) ─
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const win = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - win.start > 60000) { win.count = 0; win.start = now; }
  win.count++;
  rateLimitMap.set(ip, win);
  if (win.count > 5) return res.status(429).json({ error: "You're going a bit fast — please wait a minute and try again." });
  next();
}

// ─── Helpers ───────────────────────────────────────────────
function isYouTube(url) {
  try {
    const u = new URL(url);
    return ['youtube.com','www.youtube.com','youtu.be','music.youtube.com'].includes(u.hostname);
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
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B views';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K views';
  return n.toString() + ' views';
}

function uid() {
  return Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function findFile(prefix) {
  return fs.readdirSync(os.tmpdir())
    .filter(f => f.startsWith(prefix))
    .map(f => path.join(os.tmpdir(), f))[0] || null;
}

function cleanup(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

// Normalizes a format's resolution to a conventional "p" value,
// correctly handling portrait Shorts (where height > width).
function heightOf(f) {
  if (!f || !f.height) return null;
  return Math.min(f.height, f.width || f.height);
}

// Rough kbps-per-resolution table, used ONLY as a fallback when
// YouTube doesn't report a real filesize for that stream.
const BITRATE_GUESS = { 2160:35000, 1440:16000, 1080:8000, 720:5000, 480:2500, 360:1000, 240:700, 144:400 };
function estimateBytes(height, durSec) {
  const kbps = BITRATE_GUESS[height] || 1500;
  return Math.round((kbps * 1000 / 8) * (durSec || 0));
}

// ─── Anti-bot-detection setup ─────────────────────────────────
// YouTube blocks cloud/datacenter IPs (Railway, AWS, etc.) more
// aggressively than home IPs. Two mitigations:
//  1. Pretend to be the Android client (lighter bot-check, free)
//  2. Use cookies (most reliable) — read from the YT_COOKIES
//     environment variable so the file is NEVER committed to git
//     or exposed in a public repo. Set it in Railway → Variables.
let COOKIES_PATH = null;
if (process.env.YT_COOKIES) {
  COOKIES_PATH = path.join(os.tmpdir(), 'klip-cookies.txt');
  fs.writeFileSync(COOKIES_PATH, process.env.YT_COOKIES);
  console.log('[COOKIES] Loaded from YT_COOKIES env variable ✓');
} else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
  COOKIES_PATH = path.join(__dirname, 'cookies.txt'); // local dev only — keep out of git
  console.log('[COOKIES] Loaded from local cookies.txt (dev mode) ✓');
} else {
  console.log('[COOKIES] None set — using android-client fallback only');
}

function antiBotArgs() {
  const args = [
    '--extractor-args', 'youtube:player_client=ios,web',
    '--user-agent', 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iPhone OS 17_5_1 like Mac OS X)',
  ];
  if (COOKIES_PATH) args.push('--cookies', COOKIES_PATH);
  return args;
}

// Raw yt-dlp stderr → clean, PUBLIC-safe message (no tech jargon).
// Full raw stderr is still console.error'd separately for your logs.
function explainError(stderr) {
  if (/Sign in to confirm/i.test(stderr))   return "This video can't be processed right now. Please try again shortly.";
  if (/Private video/i.test(stderr))        return 'This video is private and cannot be downloaded.';
  if (/Video unavailable/i.test(stderr))    return 'This video was deleted or is unavailable.';
  if (/age[- ]restrict/i.test(stderr))      return 'This video is age-restricted and cannot be downloaded.';
  if (/HTTP Error 429/i.test(stderr))       return "You're going a bit fast — please wait a moment and try again.";
  if (/copyright/i.test(stderr))            return 'This video is blocked due to a copyright claim.';
  return "Something went wrong with this video. Please try again or use a different link.";
}

// ─── POST /api/info ────────────────────────────────────────
// Fetch video metadata + REAL available qualities + real sizes
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isYouTube(url)) {
    return res.status(400).json({ error: 'Please enter a valid YouTube link.' });
  }

  let stdout = '';
  let stderr = '';

  const proc = spawn('yt-dlp', [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    ...antiBotArgs(),
    url
  ]);

  proc.stdout.on('data', d => stdout += d);
  proc.stderr.on('data', d => stderr += d);

  proc.on('close', code => {
    if (code !== 0) {
      console.error('[INFO FAIL]', stderr.slice(-400));
      return res.status(404).json({ error: explainError(stderr) });
    }
    try {
      const v = JSON.parse(stdout);
      const durSec = v.duration || 0;

      // Only report resolutions that ACTUALLY exist for this video —
      // this is what stops the UI from ever offering a fake quality.
      // Use the real filesize from YouTube when available, otherwise
      // fall back to a reasonable estimate based on duration.
      const sizeByHeight = {};
      (v.formats || []).forEach(f => {
        if (!f.vcodec || f.vcodec === 'none') return;
        const h = heightOf(f);
        if (!h) return;
        const sz = f.filesize || f.filesize_approx || 0;
        if (!sizeByHeight[h] || sz > sizeByHeight[h]) sizeByHeight[h] = sz;
      });

      let qualities = Object.keys(sizeByHeight)
        .map(h => parseInt(h))
        .sort((a, b) => b - a)
        .map(h => ({ height: h, bytes: sizeByHeight[h] || estimateBytes(h, durSec) }));

      if (!qualities.length) {
        qualities = [1080, 720, 480, 360].map(h => ({ height: h, bytes: estimateBytes(h, durSec) }));
      }

      const audioSizes = {};
      [320, 256, 128].forEach(kbps => {
        audioSizes[kbps] = Math.round((kbps * 1000 / 8) * durSec);
      });

      res.json({
        id:        v.id,
        title:     v.title,
        author:    v.uploader || v.channel || 'Unknown creator',
        thumbnail: v.thumbnail,
        duration:  fmtTime(durSec),
        views:     fmtViews(v.view_count),
        isShort:   durSec > 0 && durSec <= 60,
        qualities,
        audioSizes
      });
      console.log(`[INFO] "${v.title}" — up to ${qualities[0].height}p`);
    } catch (e) {
      console.error('[INFO PARSE FAIL]', e.message);
      res.status(500).json({ error: 'Could not read this video — please try again.' });
    }
  });

  proc.on('error', (e) => {
    console.error('[INFO SPAWN FAIL]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
  });
});

// ─── GET /api/download ─────────────────────────────────────
// Download video/audio using yt-dlp, stream to browser
app.get('/api/download', rateLimit, (req, res) => {
  const { url, quality, mode, bitrate } = req.query;

  if (!url || !isYouTube(decodeURIComponent(url))) {
    return res.status(400).json({ error: 'Invalid link.' });
  }

  const ytUrl  = decodeURIComponent(url);
  const isAudio = mode === 'audio';
  const id     = uid();
  const outTpl = path.join(os.tmpdir(), `klip-${id}.%(ext)s`);

  let args;
  if (isAudio) {
    const aqMap = { '320': '0', '256': '2', '128': '5' };
    args = [
      '-f', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', aqMap[bitrate] || '0',
      '--no-playlist',
      '--no-warnings',
      ...antiBotArgs(),
      '-o', outTpl,
      ytUrl
    ];
  } else {
    const h   = parseInt(quality) || 1080;
    const fmt = [
      `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${h}]+bestaudio`,
      `best[height<=${h}][ext=mp4]`,
      `best[height<=${h}]`,
      'best'
    ].join('/');
    args = [
      '-f', fmt,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      ...antiBotArgs(),
      '-o', outTpl,
      ytUrl
    ];
  }

  const label = isAudio ? `MP3 ${bitrate}kbps` : `${quality}p MP4`;
  console.log(`[↓ START] ${label} — ${ytUrl}`);

  const proc  = spawn('yt-dlp', args);
  let stderr = '';

  proc.stderr.on('data', d => { stderr += d; });

  proc.on('close', code => {
    if (code !== 0) {
      console.error(`[↓ FAIL] ${label}\n`, stderr.slice(-400));
      if (!res.headersSent) {
        res.status(500).json({ error: explainError(stderr) });
      }
      return;
    }

    const outFile = findFile(`klip-${id}`);
    if (!outFile) {
      console.error('[↓ FAIL] Output file missing for', label);
      return res.status(500).json({ error: 'Something went wrong creating your file. Please try again.' });
    }

    const stat   = fs.statSync(outFile);
    const ext    = path.extname(outFile).slice(1) || (isAudio ? 'mp3' : 'mp4');
    const ctype  = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    const fname  = `klip-${isAudio ? 'audio' : quality + 'p'}.${ext}`;

    console.log(`[↓ DONE] ${fname} — ${(stat.size / 1048576).toFixed(1)} MB`);

    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', ctype);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('end',   () => cleanup(outFile));
    stream.on('error', () => cleanup(outFile));
    req.on('close',    () => { stream.destroy(); cleanup(outFile); });
  });

  proc.on('error', (e) => {
    console.error('[↓ SPAWN FAIL]', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
    }
  });
});

// ─── GET /api/health ───────────────────────────────────────
// Diagnostic endpoint for YOU only — never linked from the public UI.
app.get('/api/health', (req, res) => {
  const { execSync } = require('child_process');
  let ytdlp = 'not found', ffmpeg = 'not found';
  try { ytdlp  = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim(); } catch {}
  try { ffmpeg = execSync('ffmpeg -version 2>&1', { timeout: 5000 }).toString().split('\n')[0].replace('ffmpeg version ',''); } catch {}
  res.json({
    status: 'online',
    ytdlp,
    ffmpeg,
    cookies: COOKIES_PATH ? 'loaded' : 'not set (using android-client fallback)',
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ─── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   KLIP — Custom Video Downloader       ║
  ║   Engine: yt-dlp + ffmpeg              ║
  ║   Port: ${PORT}                           ║
  ╚════════════════════════════════════════╝
  → http://localhost:${PORT}
  → Health (private, for you): http://localhost:${PORT}/api/health
  `);
});
