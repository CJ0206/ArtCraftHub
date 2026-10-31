# Multi-arch friendly: node:alpine publishes amd64, arm64 and armv7 images.
FROM node:22-alpine

RUN apk add --no-cache unzip

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /srv
COPY server.js default-apps.json ./
COPY public ./public

# /data holds the app list and the downloaded app versions.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
