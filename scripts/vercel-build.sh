#!/usr/bin/env bash
# Vercel's build command (bash scripts/vercel-build.sh).
#
# With Convex (CONVEX_DEPLOY_KEY set, by the Convex integration or by hand): deploy the Convex
# functions, hand them the server secret and, for production, this site's address (the worker
# cron calls it), then build the app with the deployment's URL. See docs/convex.md.
#
# Without it: a plain build; `/` then plays the demo (src/lib/live.ts).
set -euo pipefail

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  exec npm run build
fi

# The same value src/lib/store/index.ts derives at run time when NOMEN_SERVER_SECRET isn't set.
secret="${NOMEN_SERVER_SECRET:-$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update("nomen-server:v1:" + process.env.CONVEX_DEPLOY_KEY).digest("hex"))')}"
npx convex env set NOMEN_SERVER_SECRET "$secret" > /dev/null
if [ "${VERCEL_ENV:-}" = "production" ] && [ -n "${VERCEL_PROJECT_PRODUCTION_URL:-}" ]; then
  npx convex env set NOMEN_SITE_URL "https://${VERCEL_PROJECT_PRODUCTION_URL}" > /dev/null
fi

exec npx convex deploy --cmd 'npm run build'
