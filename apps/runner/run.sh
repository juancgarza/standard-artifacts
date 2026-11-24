#!/bin/sh
# Trust the CA Cloudflare creates when the container starts, so outbound HTTPS can
# pass through the Worker that adds credentials. It only exists at runtime, so the
# image can't include it. Then drop root: the agent doesn't need it.
set -eu
CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$CA" ]; then
  cp "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null
  export NODE_EXTRA_CA_CERTS="$CA"
fi
export HOME=/home/node
exec setpriv --reuid=node --regid=node --init-groups node /app/stdartifacts.mjs "$@"
