#!/usr/bin/env bash
# cloudflare/sync-env.sh — copy the 3 API secrets from .env.local to the
# Pages project as secrets. Run in YOUR terminal (uses your Cloudflare login).
#
#   ./cloudflare/sync-env.sh cinephile-areana
#
# Copies ONLY: TMDB_API_KEY, PEACHIFY_KEY_HEX, VIDNEST_ALPHABET
# (plus optional SUBDL_API_KEY / OPENSUBTITLES_* if you set them).
# NEVER copies VERCEL_OIDC_TOKEN or anything else.
set -euo pipefail
PROJECT="${1:?usage: sync-env.sh <pages-project-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

get() { # get KEY file -> prints value or empty
  python3 -c "
import re,sys
for line in open(sys.argv[2]):
    m = re.match(r'^' + sys.argv[1] + r'=(.*)$', line.strip())
    if m:
        v = m.group(2).strip().strip(chr(34)).strip(chr(39))
        print(v); break
" "$1" "$ROOT/.env.local" || true
}

put() { # put KEY value -> wrangler pages secret
  local key="$1" val="$2"
  if [ -z "$val" ]; then echo "skip $key (not in .env.local)"; return 0; fi
  printf '%s' "$val" | npx wrangler pages secret put "$key" --project-name="$PROJECT"
}

put TMDB_API_KEY "$(get TMDB_API_KEY)"
put PEACHIFY_KEY_HEX "$(get PEACHIFY_KEY_HEX)"
put VIDNEST_ALPHABET "$(get VIDNEST_ALPHABET)"
put SUBDL_API_KEY "$(get SUBDL_API_KEY)"
put OPENSUBTITLES_API_KEY "$(get OPENSUBTITLES_API_KEY)"
put OPENSUBTITLES_USERNAME "$(get OPENSUBTITLES_USERNAME)"
put OPENSUBTITLES_PASSWORD "$(get OPENSUBTITLES_PASSWORD)"
echo "done -> $PROJECT"
