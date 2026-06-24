FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    MUD_DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY world-engine ./world-engine

RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 8790
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "world-engine/demo/healthcheck.js"]

CMD ["node", "world-engine/demo/production-server.js"]
