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
  if (win.count > 5) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
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

// ─── POST /api/info ────────────────────────────────────────
// Fetch video metadata using yt-dlp (no external API)
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !isYouTube(url)) {
    return res.status(400).json({ error: 'Please enter a valid YouTube URL.' });
  }

  let stdout = '';
  let stderr = '';

  const proc = spawn('yt-dlp', [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    url
  ]);

  proc.stdout.on('data', d => stdout += d);
  proc.stderr.on('data', d => stderr += d);

  proc.on('close', code => {
    if (code !== 0) {
      console.error('[INFO FAIL]', stderr.slice(-200));
      return res.status(404).json({
        error: 'Video not found. It may be private, age-restricted, or deleted.'
      });
    }
    try {
      const v = JSON.parse(stdout);
      res.json({
        id:        v.id,
        title:     v.title,
        author:    v.uploader || v.channel || 'Unknown Channel',
        thumbnail: v.thumbnail,
        duration:  fmtTime(v.duration),
        views:     fmtViews(v.view_count),
        isShort:   (v.duration || 999) <= 60
      });
      console.log(`[INFO] "${v.title}" — ${fmtTime(v.duration)}`);
    } catch {
      res.status(500).json({ error: 'Could not read video data.' });
    }
  });

  proc.on('error', () => res.status(500).json({
    error: 'yt-dlp not found on server. Run: pip install yt-dlp'
  }));
});

// ─── GET /api/download ─────────────────────────────────────
// Download video/audio using yt-dlp, stream to browser
app.get('/api/download', rateLimit, (req, res) => {
  const { url, quality, mode, bitrate } = req.query;

  if (!url || !isYouTube(decodeURIComponent(url))) {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  const ytUrl  = decodeURIComponent(url);
  const isAudio = mode === 'audio';
  const id     = uid();
  const outTpl = path.join(os.tmpdir(), `klip-${id}.%(ext)s`);

  // Build format string
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
      '-o', outTpl,
      ytUrl
    ];
  }

  const label = isAudio ? `MP3 ${bitrate}kbps` : `${quality}p MP4`;
  console.log(`[↓ START] ${label} — ${ytUrl}`);

  const proc  = spawn('yt-dlp', args);
  let stderr = '';

  proc.stderr.on('data', d => { stderr += d; process.stdout.write('.'); });

  proc.on('close', code => {
    console.log('');
    if (code !== 0) {
      console.error(`[↓ FAIL] ${label}\n`, stderr.slice(-300));
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed. Try a different quality.', detail: stderr.slice(-150) });
      }
      return;
    }

    const outFile = findFile(`klip-${id}`);
    if (!outFile) return res.status(500).json({ error: 'Output file missing.' });

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

  proc.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'yt-dlp not installed on server.' });
    }
  });
});

// ─── GET /api/health ───────────────────────────────────────
app.get('/api/health', (req, res) => {
  const { execSync } = require('child_process');
  let ytdlp = 'not found', ffmpeg = 'not found';
  try { ytdlp  = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim(); } catch {}
  try { ffmpeg = execSync('ffmpeg -version 2>&1', { timeout: 5000 }).toString().split('\n')[0].replace('ffmpeg version ',''); } catch {}
  res.json({ status: 'online', ytdlp, ffmpeg, uptime: Math.floor(process.uptime()) + 's' });
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
  → Health: http://localhost:${PORT}/api/health
  `);
});
