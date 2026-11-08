# Troy: the landing page and the camp

Troy is the pixel-art front door of Nomen. `/` is a white page with a Trojan horse and one box:
the company's website. Submitting it starts a real campaign; the horse's doors open, a gangplank
drops and an endless column of hoplites marches out to the camp. `/camp/[brandId]` is the camp:
the campaign's agents, one island per pipeline stage, doing the work the core track reports.

## Who owns what

This track owns these paths; the core track owns everything else.

- `src/components/troy/**` (engine, models, scenes, UI)
- `src/app/page.tsx` (the landing; it replaced the brand list, which moved to `/brands`)
- `src/app/brands/page.tsx` (the core's `HomeView`, unchanged, at its new address)
- `src/app/camp/**` and `src/app/demo/**`
- `src/app/gate/**`, `src/app/api/gate/**` and `src/proxy.ts` (the password gate)
- `scripts/demo-export.mjs` and `public/demo/**` (recorded demos)
- `tests/troy/**`
- `docs/troy.md`

Troy reads the core's code but changes none of it.

## The contract it relies on

Troy talks to the core over HTTP only. Its response types are the core's own view types, imported
as types (`src/components/troy/api.ts` re-exports `BrandView`, `CampaignView`, `CreativeView` and
`BrandListItem` from `src/lib/views.ts`), so a change to a field Troy reads fails `npm run typecheck`.

| Call | Used for |
| --- | --- |
| `POST /api/brands {url}` | The landing's box: creates the brand and starts its campaign |
| `GET /api/brands` | "Your camps" on the landing |
| `GET /api/brands/[id]` | The camp, polled every 2.5 s while agents work (9 s otherwise, paused in hidden tabs) |
| `POST /api/campaigns/[id] {action}` | Retry, approve all, publish now / one a day |
| `PATCH /api/creatives/[id] {approved}` | Approving one video |
| `POST /api/creatives/[id]` | "Send back for another take" |
| `POST /api/brands/[id]/social {returnTo}` | The connect-accounts link before posting |
| `GET /api/media/[id]/final.mp4` | Videos in the theatre and on its screen |
| `GET/POST/DELETE /api/brands/[id]/brandkit` (and `/repo`, `/file`) | The camp's brand kit: drop files or a folder, link a repo |
| `GET/POST /api/brands/[id]/loop` | The camp's autopilot: on/off, weekly budget, cadence, posting, the next run and the last decision |

From the creative engine (docs/creative-engine.md) the camp reads, on the same `GET /api/brands/[id]`:
- `campaign.study`: where the reference study is (product brief, site screenshots, relevance
  screen, breakdowns), for the Oracle's status line;
- `campaign.references`: every viral video the agents broke down, are breaking down, or set aside,
  with its thumbnail, link, creator, platform, views, followers, views per follower, likes, saves,
  shares, comments, length, lane, hook, fit and why it works, the relevance screen's reason, and
  which of our videos remake it. Research steering adds its `role` (reach or convert), its
  `conversion` score (0-10) and the named `signals` behind it; a paid ad from an ad library has
  `paidAd` set and no view count ("views unknown"). The shortlist appears as soon as the
  breakdowns start;
- `campaign.strategy.campaign.briefs` and `.concepts`: the director's briefs (with each one's role
  and the metric it is judged on) and the script room's scripts, for the War tent;
- `creative.reference` ("Remake of @creator, 1.2M views"), `creative.script` (length, critic
  score) and `creative.role`/`creative.metric` on every video.

Two things are matched on the core's wording, and both are pinned by `tests/troy/derive.test.ts`:

- **Stages:** `research → style → strategy → production → review → live` map to the Scouts,
  Oracle, War tent, Workshop, Theatre and Agora.
- **Event lines:** `stationForEvent()` in `scenes/derive.ts` routes each `logEvent` line (for
  example `QC sent "…" shot 1 back`) to the station it is about. If you reword a `logEvent` call,
  run the tests.

## The demo

`/` is the real product: the box starts a campaign, which spends real credits. `/demo` is the
same horse and camp with nothing spent. Its box marches into `/camp/demo?site=<domain>`, which
replays a finished campaign on a clock: research, the format study, the strategy, production,
your review, then posting. That takes about two minutes, plus as long as the presenter spends on
the review.

**What it replays.** A `DemoScript` (`camp/demo.ts`):
- **A recording:** a real campaign exported with its videos. The recording for the typed website
  plays if there is one, otherwise the newest recording.
- **The sample:** with no recordings installed, a made-up brand on a reserved domain (Olive & Ash,
  `oliveandash.example`, in `camp/sample.ts`) with painted stills instead of videos.

`replay(script, state)` builds the same `BrandView` the API returns, so the demo drives the real
camp code. The top bar labels it "Replay" or "Demo", and the panels say nothing is spent.

**The review waits for you.** The clock stops at the review until the presenter approves videos
and presses "Post now" or "One a day" in the theatre, as in the real product. Clicking a video
opens it at full height with its hook and caption. Posting then runs as the core does it: posts
are queued and sent, then the campaign goes live. "One a day" schedules posts for 16:00 UTC on
consecutive days.

**Presenter controls.** These are in the top bar, and as keys while no control has focus:

| Key | Does |
| --- | --- |
| Space | Pause / play |
| → | Skip to the next step. At the review it approves and posts every video. |
| ← | Back a step (undoing the review) |
| R | Start over |
| A | Autoplay on or off: the camp approves and posts by itself |

`?auto=1` starts with autoplay on (for screen recordings) and `?speed=1.5` runs the clock faster.

### Recording a campaign for the demo

When a real campaign has turned out well:

```bash
npm run demo:export -- yourbrand.com
```

The exporter reads the campaign from a running Nomen (`--from`, default `http://localhost:3000`)
through the same HTTP API the camp uses. It writes `public/demo/<id>/` and adds the recording to
the front of `public/demo/index.json`:
- the finished videos (`1.mp4`…);
- a poster for each (the campaign's own, or a frame taken with ffmpeg);
- `script.json`: the plan, research counts, strategy, concepts, captions, QC scores, costs and the
  event log. The full log comes from `data/nomen.db` when it is there, otherwise the API's latest
  60 lines.

Commit `public/demo` and deploy. Typing that website on `/demo` then replays it.

The replay places each event line on its own clock. Lines that mark a step (the plan, research
done, a video ready) land exactly when the camp shows that step. The rest keep their relative place
within their stage. Review and posting lines are dropped, because the replay writes those as the
presenter acts. So are failures the campaign recovered from. Posted videos show numbers only if the
recording has real analytics.

## Demo deployments

Two environment variables turn a deployment into a password-protected demo. Both are off unless
set, so local development is unchanged.

| Variable | Effect |
| --- | --- |
| `SITE_PASSWORD` | `src/proxy.ts` sends every page to `/gate` until the browser has the cookie. API calls get a 401. The cookie holds a SHA-256 hash of the password, never the password, and lasts 30 days. Changing the password logs every browser out. |
| `NOMEN_DEMO_ONLY=1` | Forces the demo, even where campaigns could run. Not needed on Vercel: there `/` forwards to `/demo` by itself until Convex is connected (`src/lib/live.ts`). The proxy switches the API off (404), except `/api/status`, which answers "demo build" for the core's header. Nothing on the server opens the database or calls a provider. |

The Vercel project `nomen` (`nomen-phi.vercel.app`) sets the password in its environment variables
(type "sensitive"), never in the repo, and each browser enters it once. The project isn't linked to Git: deploy a branch with the Vercel CLI,
the API or Claude's Vercel tools.

The real product runs on Vercel once Convex holds the data (docs/convex.md), and `/` goes live by
itself then. It also runs anywhere with a lasting disk (`npm run build && npm start`, SQLite in
`data/`). `/demo` works in every setup.

## Under the core's layout

The core's root layout renders a dark header around every page. Troy's pages cover the window
(`position: fixed; z-index: 60`) and mark everything outside themselves `inert` while mounted, so
the header is neither visible nor reachable by keyboard. The landing links to `/settings` (where the
keys live) and to `/brands`.

A cleaner end state, for the core track to decide: move the header into an `(app)` route group's
layout so `/` and `/camp/*` never render it.

## How the camp maps the campaign

`scenes/derive.ts` turns a `BrandView` into a plan: each station's state (`waiting`, `working`,
`done`, `failed`, `skipped`, or `yours` when the campaign waits on the user), a one-line status and
progress, and every agent's post and activity:

- **Scouts:** one per research source. They queue while it is pending, walk off the island while
  it runs, and come back with a scroll when it finishes (or empty-handed when it fails). The lookout
  stays on the tower.
- **Oracle:** watches the top videos on a CRT during the reference study: reading the product,
  screenshotting the site, screening the viral videos, breaking the best down. Its panel lists the
  references live (`camp/References.tsx`): the ones broken down or being broken down, then, folded,
  the ones set aside with the screen's reason. Each links to the original and names the videos that
  remake it.
- **War tent:** the creative director points at the map while it picks which reference each video
  remakes, and the script room writes each script (the panel shows every brief, the reference it
  remakes, and the script's length and critic score as it lands).
- **Workshop:** one desk per video. The CRT is blue while a shot renders, green when the video is
  ready and red when it failed. The painter works the easel while first frames are made, and the
  inspector visits the desk whose shot is in QC. Faceless videos (no presenter) show their screens,
  voice-over and edit instead of shots.
- **Theatre:** finished videos play on the screen as pixelated frames, with an audience. Each card
  says which viral video it remakes; the screening room shows that video's numbers and the script.
- **Brand kit:** not an island: the "Brand kit" button in the top bar (and a nudge in the Scouts
  and Oracle panels while it can still shape the product study) opens `camp/BrandKitDrawer.tsx`.
  Drop files or a whole folder, or link a repo; it uses the same intake as the workspace's Brand
  kit tab (`src/components/brandkit/intake.ts`). The demo has no brand kit.
- **Autopilot:** the "Autopilot" button in the top bar (a pip shows whether it is on), and a
  nudge in the Agora, open `camp/AutopilotDrawer.tsx`: on/off, the weekly budget, the cadence,
  automatic posting, the next run, this week's spend and the last decision, with "skip these
  videos" when the loop waits on a review. Same rules as the workspace's Autopilot tab: it can't
  be turned on until the budget is filled in.
- **Agora:** the herald trumpets while posts go out.

A messenger rides along the sandbars when work changes hands (each stage change, each finished
video). New event lines flash in the station's label with a pop-up emote.

## The art

Nothing is a bitmap. `engine/tracer.ts` is a small analytic ray tracer:
- **Models:** unions of boxes, ellipsoids, cylinders, capsules and frustums, with clip planes and
  carved holes.
- **Camera:** an orthographic 2:1 isometric camera, one ray per art pixel.
- **Light:** a sun with hard shadows on objects and dithered soft shadows on the ground.
- **Colour:** hand-picked 6-step ramps (`engine/palette.ts`) with ordered dithering on curved
  surfaces only.
- **Grounds:** islands whose rims dissolve into scattered grains.

- `engine/models/*`: the horse (body, door leaves and gangplank as separate layers), the hoplite
  (a pose is a few joint angles; looks vary skin, crest, tunic, shield emblem) and the station
  props.
- `engine/jobs.ts`: every drawable as a serialisable job (`{ k: "soldier", look, act, dir, f }`).
  `engine/bake.worker.ts` bakes jobs in a pool of up to three workers, with an inline fallback.
  `engine/baker.ts` caches the results as `ImageBitmap`s.
- `engine/stage.ts`: one canvas, a camera in art pixels and whole device pixels per art pixel where
  that costs little (quarter steps otherwise). It depth-sorts entities isometrically, draws soft blob
  shadows and pixel-dissolve reveals, and keeps HTML anchored to world points.

To add a prop: write a builder in `engine/models/props.ts`, add a case to `propModel()` in
`jobs.ts`, and place it in `scenes/stations.ts`. The island bakes its shadow automatically. To add
an activity, add an `Act` and its pose in `poseFor()`.

## Numbers

Measured in headless Chromium at 1440×900, 2x (software rendering, so real GPUs do better):
- **Landing:** the website box appears about 0.5 s after load, and the horse about 1 s after load
  in dev mode.
- **Frame time:** a median of 16.7 ms and a 95th percentile of 16.8 ms through the door opening
  and the march.
- **Bake cost:** the horse body takes about 250 ms and a soldier frame about 5 ms, all in workers.

## Tests

```bash
npx vitest run tests/troy
```

They cover:
- the plan for every campaign state and event routing;
- the creative engine in the camp (`tests/troy/references.test.ts`): the reference list and its
  numbers, the study's steps, the script room, faceless videos and the engine's event lines;
- that the website box accepts exactly what the server's `normalizeDomain` accepts;
- deterministic baking and the door timeline;
- the gate and the demo-only switch;
- the demo's clock: the review that waits, posting now or one a day, autoplay, skips, where event
  lines land, and loading recordings.

## Not done yet

- **The real product online:** ready on Convex (docs/convex.md); waiting for the Convex project and
  the provider keys on Vercel.
- **Phones:** the warm-up track (`/api/phones/*`) isn't shown in the camp yet; a soldier scrolling a
  phone would fit the Agora.
- **Linking:** the brand workspace (`/brands/[id]`, core) doesn't link to the camp yet; the camp
  links to the workspace.
- **Theme:** the core's pages keep their dark theme.
