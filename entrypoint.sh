#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  # Started as root (the Portainer template default). Hand /data to the node user,
  # including anything left behind by earlier runs, then drop privileges.
  find /data ! -user node -exec chown node:node {} \; 2>/dev/null || true
  if su-exec node sh -c 'touch /data/.write-test && rm -f /data/.write-test' 2>/dev/null; then
    exec su-exec node "$@"
  fi
  # Some NAS file systems refuse ownership changes. Keep working instead of crashing.
  echo "notice: /data is not writable by the unprivileged user on this file system; running as root instead."
fi
exec "$@"
