# Multi-arch friendly: node:alpine publishes amd64, arm64 and armv7 images.
FROM node:22-alpine

RUN apk add --no-cache unzip su-exec

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /srv
COPY server.js default-apps.json ./
COPY public ./public
COPY entrypoint.sh /entrypoint.sh

# The container starts as root, fixes /data permissions, then runs the app as "node".
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
