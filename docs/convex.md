# Nomen on Vercel with Convex

The core keeps its rows in a store with two backends (`src/lib/store/`):

| | SQLite | Convex |
| --- | --- | --- |
| Used | locally (`npm run dev`) and in the tests | on Vercel, where nothing persists between requests |
| Rows | `data/nomen.db` (or `NOMEN_DB_PATH`) | Convex tables (`convex/schema.ts`), same columns and ids |
| Media | `data/media/<key>` | Convex file storage, named by the same keys (`crv_…/final.mp4`) |
| Worker | an in-process loop every 4 s | Convex asks the site to tick (below) |

The pipeline code is the same either way: every read and write goes through `store()` (or the
`save` and `logEvent` helpers in `src/lib/db.ts`) and is awaited. The store is Convex when a Convex
URL and the server secret are present, or when `NOMEN_STORE=convex`; otherwise SQLite. The tests run
the store contract and the pipeline against both, with Convex on `convex-test`
(`tests/store.test.ts`).

## How it runs on Vercel

- **The app** (pages, API routes, the pipeline, ffmpeg) runs on Vercel. The ffmpeg-static binary is
  shipped with the API functions (`next.config.ts`).
- **The data** stays private to the server. The functions in `convex/` refuse any call without
  `NOMEN_SERVER_SECRET`, and browsers only ever talk to the app. That includes media: `/api/media/…`
  checks the site password and then redirects to the file's storage URL.
- **The worker:** `POST /api/worker/tick` (signed with the secret) runs one tick after answering.
  While a campaign or a post is in flight, each tick asks Convex for the next one 10 s later
  (`worker:continueTicking`). A cron every 5 minutes (`convex/crons.ts`) restarts the chain after a
  crash and handles slow work (scheduled posts, analytics). An idle site costs one small call every
  5 minutes. A lease in Convex keeps two ticks from ever overlapping.

## Setting it up

1. **Convex.** Add Convex to the Vercel project from the Vercel Marketplace (Storage → Convex,
   connected to the `nomen` project, Production and Preview environments, no custom prefix). Or
   create a project at convex.dev, generate a Production deploy key, and add it to the Vercel project
   as `CONVEX_DEPLOY_KEY`, Production only.
2. **Provider keys.** In the Vercel project's environment variables, add `NAIVE_API_KEY` and
   `MONID_API_KEY` for Production, as type "Sensitive". Never put them in the repo or in chat.
3. **Redeploy.** The project's build command is `bash scripts/vercel-build.sh`. With a deploy key it
   runs `npx convex deploy`, sets `NOMEN_SERVER_SECRET` and `NOMEN_SITE_URL` on the Convex deployment,
   and builds the app with its URL; without one it is a plain build. `/` goes live by itself once
   Convex is connected (src/lib/live.ts); before that it forwards to `/demo`. Keep `SITE_PASSWORD`:
   the real site spends real credits.
4. **Check:** `/` shows the cost line, `/demo` still plays the demo, and a campaign started from the
   horse moves through research within a minute.

`NOMEN_SERVER_SECRET` doesn't need setting: both sides derive it from the deploy key. Set it
explicitly only if you want to rotate it independently.

## What doesn't run on Convex yet

**Phones** (`src/lib/phones`, the phones track) keep their own tables in SQLite. On a Convex
deployment their API answers that phones aren't available there yet, and the worker skips them.
Moving them means porting `src/lib/phones/store.ts` to the store, like the core's tables.

## Developing against Convex locally

Not needed day to day (SQLite is the default), but possible:

```bash
npx convex dev
```

That links a dev deployment and writes `NEXT_PUBLIC_CONVEX_URL` to `.env.local`. Then:
- set `NOMEN_STORE=convex` and a `NOMEN_SERVER_SECRET` of at least 32 characters in `.env.local`;
- set the same secret on the dev deployment from its dashboard.

The local in-process worker still ticks, because the cron can't reach localhost.

`convex/_generated` is committed. `npx convex dev` and `npx convex deploy` regenerate it whenever
`convex/` changes.
