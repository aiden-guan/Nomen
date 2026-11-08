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

## The creative engine on Convex

A campaign's work is spread over many worker ticks, and on Vercel each tick may run on a different
machine with an empty disk. So everything that must reach a later tick goes through `store().files`
by key, and only one tick's scratch work uses the temp folder (`scratchDir()` in src/lib/media.ts):

| Kept by key (data/media locally, Convex storage on Vercel) | Scratch for one tick |
| --- | --- |
| Captured site screenshots: `visuals-cmp_…/site-….png` (the ProductVisual carries the `key`) | Product images the analyst looks at, reference videos for the breakdowns |
| Renders `crv_…/shot1-r1.mp4` and first frames `crv_…/shot1-frame.png` | Silence-trimmed renders, downloaded product images |
| Product screens `crv_…/screens/…` and their manifest `crv_…/screens/manifest.json` | The screen builder's HTML and frames |
| filmed_screen's monitor photo `crv_…/plate.png` and its record `crv_…/plate.json` | The rejected photo tries |
| The voice-over `crv_…/voiceover-raw.wav` and `crv_…/voiceover.wav` | The edit's intermediates |
| The cut `crv_…/final.mp4` (`final_key`) and its poster `crv_…/shot0-frame.png` | |

The UI only ever loads the cut, the poster and the frames, through `/api/media/…` (which redirects
to the storage URL on Convex). Rows from before the store held absolute paths under data/media;
those still work locally, because a key is the path under data/media.

Convex's local copies are checked against the stored size, because a remade first frame, the
screens manifest and the plate record are rewritten under the same key.

**Autopilot** (src/lib/loop.ts) keeps one row per brand in `brand_loops`, in both stores. While any
brand's autopilot is on, the 5-minute heartbeat ticks the site (convex/worker.ts), so the loop can
start the brand's next campaign when its cadence and budget allow; with every autopilot off, an
idle site still costs one small call every 5 minutes.

**What needs a full machine:**
- **The screen builder** renders motion graphics with headless Chrome. Vercel's functions have no
  Chrome, so `buildScreens` fails there and every screen falls back to the beat's real visual (a
  screenshot or a brand-kit asset), exactly as when a single screen can't be built. The videos are
  still made; they just have no generated screens. Run the worker on a machine with Chrome (or point
  the screen builder at a remote browser) to get them.
- **The edit and QC** use ffmpeg, which is shipped with the API functions (`next.config.ts`, with
  the caption font in `assets/fonts`). A long edit can run close to the tick route's 300 s limit;
  the edit only starts once everything it needs is kept, so a tick cut off mid-edit just runs it
  again on the next tick.
- **Brand kits** are folders on the server's disk (`data/brandkits`). On Convex they read as empty
  and the brand-kit routes refuse changes with a message, so a campaign there works from the
  website's screenshots alone. Moving kits to the store means keeping `kit.json` and the assets in
  `store().files` (src/lib/creative/brandkit.ts).

## What doesn't run on Convex yet

**Phones** (`src/lib/phones`, the phones track) keep their own tables in SQLite. On a Convex
deployment their API answers that phones aren't available there yet, and the worker skips them.
Moving them means porting `src/lib/phones/store.ts` to the store, like the core's tables.

**Brand kits and generated screens** need a disk and Chrome: see the creative engine above.

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
