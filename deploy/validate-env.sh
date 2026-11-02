#!/usr/bin/env sh
set -eu

env_file="${1:-.env.production}"
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.production.example and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

required="DOMAIN POSTGRES_PASSWORD RINGCENTRAL_CLIENT_ID RINGCENTRAL_CLIENT_SECRET RINGCENTRAL_REDIRECT_URI RINGCENTRAL_TOKEN_ENCRYPTION_KEY"
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "Missing required production setting: $name" >&2
    exit 1
  fi
done

case "$DOMAIN" in
  http://*|https://*|*/*) echo "DOMAIN must be a hostname only." >&2; exit 1 ;;
esac

expected="https://${DOMAIN}/integrations/ringcentral/callback"
if [ "$RINGCENTRAL_REDIRECT_URI" != "$expected" ]; then
  echo "RINGCENTRAL_REDIRECT_URI must equal $expected" >&2
  exit 1
fi

if [ "${DEEPCANVAS_REQUIRE_WEB_AUTH:-true}" != "true" ]; then
  echo "DEEPCANVAS_REQUIRE_WEB_AUTH must be true in production." >&2
  exit 1
fi

echo "Production environment looks valid."
