# ── KLIP YouTube Downloader ──────────────────────────────────
FROM node:20-slim

# Install ffmpeg + curl + python (minimal)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        ca-certificates \
        python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Download yt-dlp BINARY directly from GitHub releases
# This is always the absolute latest stable release —
# much faster and more up-to-date than pip.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version

# App setup
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
