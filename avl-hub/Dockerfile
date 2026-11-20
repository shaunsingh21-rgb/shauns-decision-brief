# AVL Tech Hub — production image. Build:  docker build -t avl-hub .
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Native modules (argon2, better-sqlite3) ship prebuilt binaries; build tools are only a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && apt-get clean
COPY package.json package-lock.json ./
# postinstall copies the on-device OCR engine into public/vendor
COPY scripts ./scripts
RUN npm ci --omit=dev
COPY server ./server
COPY migrations ./migrations
COPY public ./public
RUN node scripts/vendor-ocr.js || true
# All persistent data (database, uploads, backups) lives in /data — mount a volume there.
ENV DB_PATH=/data/avl-hub.db UPLOAD_DIR=/data/uploads BACKUP_DIR=/data/backups TRUST_PROXY=1 PORT=3000
RUN useradd --system --uid 10001 --home /app avl && mkdir -p /data && chown -R avl /data /app
USER avl
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
