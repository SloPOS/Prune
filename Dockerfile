FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY apps/editor-web/package.json apps/editor-web/package.json
COPY apps/media-api/package.json apps/media-api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/export/package.json packages/export/package.json

RUN npm ci

COPY . .

RUN python3 -m pip install --break-system-packages -r scripts/requirements.txt

ENV HOST=0.0.0.0 \
    PORT=4173 \
    BITCUT_MEDIA_ROOTS=/data/media \
    BITCUT_UPLOAD_DIR=/data/uploads \
    BITCUT_TRANSCRIPT_DIR=/data/transcripts \
    BITCUT_PROJECTS_DIR=/data/projects \
    BITCUT_EXPORT_DIR=/data/exports \
    BITCUT_SETTINGS_PATH=/data/config.json

EXPOSE 4173

CMD ["npm", "run", "dev", "--workspace", "@prune/editor-web", "--", "--host", "0.0.0.0", "--port", "4173"]
