# ── KLIP YouTube Downloader ──────────────────────────────
# Base image: Node.js 20 (slim)
FROM node:20-slim

# Install Python, ffmpeg, and the LATEST yt-dlp
# (-U forces newest version — old yt-dlp breaks against YouTube often)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ffmpeg \
        curl \
        ca-certificates && \
    pip3 install --no-cache-dir -U yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json first (for Docker layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy all files
# (optionally include cookies.txt here too — see DEPLOY_GUIDE)
COPY . .

# Expose port (Railway overrides via $PORT at runtime)
EXPOSE 3001

# Health check — uses $PORT so it works on Railway's dynamic port
HEALTHCHECK --interval=30s --timeout=10s \
  CMD curl -f http://localhost:${PORT:-3001}/api/health || exit 1

# Start server
CMD ["node", "server.js"]
