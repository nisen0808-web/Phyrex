FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY world-engine ./world-engine

RUN mkdir -p /data \
  && chown -R node:node /app /data

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    MUD_PRODUCTION=true \
    MUD_AUTH=true \
    MUD_DATA_DIR=/data \
    MUD_DEFAULT_SAVE=world.json \
    MUD_SHUTDOWN_SAVE=world-latest.json

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "api:production"]
