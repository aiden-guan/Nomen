# Troy: the landing page and the camp

Troy is the pixel-art front door of Nomen. `/` is a white page with a Trojan horse and one box:
the company's website. Submitting it starts a real campaign; the horse's doors open, a gangplank
drops and the campaign's agents march out, one by one, down to their posts in the camp. `/camp/[brandId]` is the camp:
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
your review, then posting and the expedition. That takes about two and a half minutes, plus as
long as the presenter spends on the review.

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

**The tour.** A recorded demo starts with a caption card along the bottom (`camp/tour.ts`,
`useTour.ts`, `TourCard.tsx`). → (or Next) walks it one part of the work at a time, and each step
moves the clock there, holds it, and opens what it is about:
1. the website going in;
2. the scouts riding to every land, with the camera pulled back to show them all;
3. what they found (with the research's format checks);
4. the format study;
5. the director's picks, with each one's research reason (the War tent scrolls to them);
6. the workshop;
7. each finished video, playing in the screening room with the caption beside it;
8. the same briefs cast to real creators, when the recording has their castings;
9. posting;
10. the battle;
11. autopilot's next campaign.

← goes back (a step before the posting un-posts), R starts the tour over and T turns it off, giving
back the keys above. `?tour=0` starts with it off. Every number in a caption comes from the
recording. A brief can have its video and its creator: the theatre shows the cut first, then the
creator briefs.

**Research takes as long as the rides.** Each research source stays out until its scout has ridden
to its land and gathered a moment, so the panels and the riders agree. The planned sweep starts
once its scouts have marched from the horse to the stable, farthest lands first. The research is
done once the last scout is home with the case: about 40 seconds for the sample.

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

`--only <creative ids>` records just those videos: lines about the others are dropped or trimmed
("Campaign started" counts the kept ones). A kept video that was remade after its first version
(the first version is in its concept's `previous`) keeps the remake's production lines, and the
plan and script lines describe the remake.

**The Monid recording** (`public/demo/monid-ai/`) is the Monid campaign with one video: the
one-to-one remake of the @cluelyextras billboard video (628K views) that "We gave an agent $3 and
one skill file" became. `tests/monid-clone.seed.test.ts` stores that remake as the video's second
generation in `data/` (opt-in: `NOMEN_SEED_MONID=1`), then:

```bash
npm run demo:export -- monid.ai --only crv_376762f3ac4741cda217 --id monid-ai
```

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

- **Scouts:** one per land: the website or API that land stands for (see "The lands" below). A
  scout carries every research source fetched there. It waits in camp until the first of them
  starts, then takes a horse from the stable and gallops along the roads west to its land. It ties
  the horse by the shore and gathers at the landmark until every source there is in. Then it rides
  back with a scroll case and drops the case in the basket, which fills case by case. A scout whose
  sources all failed comes back empty-handed. Then the scout marches back into the horse, and out
  again if its land gets another source. The stable has eight horses: seven for scouts and one for
  the courier. Scouts beyond seven run on foot. The lookout climbs the tower's ladder and keeps
  watch.
- **Oracle:** watches the top videos on a CRT from the shrine's floor during the reference study:
  reading the product, screenshotting the site, screening the viral videos, breaking the best
  down. Its panel lists the references live (`camp/References.tsx`): the ones broken down or being
  broken down, then, folded, the ones set aside with the screen's reason. Each links to the
  original and names the videos that remake it.
- **War tent:** the creative director points at the map while it picks which reference each video
  remakes, a scribe takes notes, and the script room writes each script (the panel shows every
  brief, the reference it remakes, why the research picked it, and the script's length and critic
  score as it lands).
- **Workshop:** one desk and one editor per planned video, set up before the concepts arrive. The
  CRT is blue while a shot renders, green when the video is ready and red when it failed. The
  painter works the easel while first frames are made, and the inspector walks to the desk whose
  shot is in QC. Faceless videos (no presenter) show their screens, voice-over and edit instead of
  shots.
- **Theatre:** finished videos play on the screen as pixelated frames. The audience waits beside
  the theatre and takes its seats when there is a cut to watch. Each card says which viral video it
  remakes; the screening room shows that video's numbers and the script. In real-creator mode a
  brief's card is its casting instead: the creator, why they fit, the client-taste agent's verdict
  and the outreach draft. Approve it, and "Send from the phone" sends that DM from the brand's own
  account on its linked phone (docs/phones.md). While the campaign waits for your review,
  the theatre calls for you: a bobbing "N videos ready" marker over the screen opens its panel, its
  tag and its step in the top bar say "Your turn" and pulse, and on phones its card in the strip
  does the same.
- **Brand kit:** not an island: the "Brand kit" button in the top bar (and a nudge in the Scouts
  and Oracle panels while it can still shape the product study) opens `camp/BrandKitDrawer.tsx`.
  Drop files or a whole folder, or link a repo; it uses the same intake as the workspace's Brand
  kit tab (`src/components/brandkit/intake.ts`). The demo has no brand kit.
- **Autopilot:** the "Autopilot" button in the top bar (a pip shows whether it is on), and a
  nudge in the Agora, open `camp/AutopilotDrawer.tsx`: on/off, the weekly budget, the cadence,
  automatic posting, the next run, this week's spend and the last decision, with "skip these
  videos" when the loop waits on a review. Same rules as the workspace's Autopilot tab: it can't
  be turned on until the budget is filled in.
- **Agora:** the herald climbs the podium and trumpets while posts go out. While the core says
  "publishing" (its stage is still "review"), the theatre is done and the agora has the work; once
  every post is out the agora is done too. Below it, the army sails (see "The expedition").

A courier with a horse of his own rides each piece of work along the sandbars when it changes
hands (each stage change, each finished video), then rides back to the stable. New event lines
flash in the station's label with a pop-up emote beside the island.

### The lands

Far to the west of the camp, out of view until you zoom out, a road leaves the stable's gate for a
crossroads with a signpost. From there the
high road runs north and south between two columns of lands, with a spur to each. Each land is the
website or API the research reads (`LANDS` in `scenes/layout.ts`; landmarks in
`engine/models/lands.ts`):

| Land | Landmark | Sources (`landFor()`) |
| --- | --- | --- |
| The brand's site | a little walled town with its banners | `brand`, `site` |
| SimilarWeb | three houses alike, but not quite | `similar`, and any source the camp has no land for |
| Ahrefs | a striped beacon | `seo_*` |
| TikTok | a giant phone, its screen a cyan and magenta glitch | `tiktok_*` |
| Instagram | square pictures on easels in its gradient | `reels` |
| YouTube | an outdoor screen on red posts, with benches | `shorts` |
| Meta Ad Library | billboards of ads, framed in blue | `meta_ads_*` |
| Reddit | a stone forum with a notice board of threads | `reddit` |
| ChatGPT | a dark round shrine with a glowing orb | `aeo_chatgpt` |
| Perplexity | a faceted teal crystal on stepped stone | `aeo_perplexity` |

A scout ties its horse in one of four spots by the shore and gathers in front of the landmark. A
label under each land names it, says what is fetched there and counts the scouts out on it.

### The expedition

Below the agora is a harbour: a quay where four Greek ships lie alongside, with cranes, cargo and
a fire tower at its end. Beyond it the sea runs south, past three islets, to the rival's city: a
Roman port with a lighthouse on its mole, a temple over its forum, a wall with towers and a
gatehouse, and beyond the wall red-roofed houses, an amphitheatre and an aqueduct. The legion
stands in the forum for the first competitor in the research plan; a banner by the gate names it,
with the count of its ads the scouts found running. The harbour, the sea and the city appear grain
by grain as they come into view, whether you pan down to them or the camera takes you there.

The Greeks are camp agents (`armyPlans()` in `scenes/derive.ts`): they march out of the horse
like everyone else and can be clicked. The camp walks them down to the quay and hands each one to
`scenes/expedition.ts`, which owns the ships, the legion, the engines on the walls and everything
in the air, and moves the soldiers from then on.

- **One company per finished video:** six hoplites and an archer, mustered on the quay beside the
  ship that will carry it (`shipsFor()` in `scenes/battle.ts`). Past four videos, two companies
  share a ship, with four hoplites each.
- **A post goes out:** its company's leader calls "To the ships, men of Achaea!", the company goes
  up the gangplank, and once everyone is aboard the ship rows out, sets its sail and crosses the
  sea, the four ships abreast, each with its wake. A ship whose post is still going out waits off
  the city.
- **The post is out:** its ship runs in bow first at the city's quay, the company goes down the
  bow's plank ("Ashore! Shields up, and at them!") and forms up on the quay. The archer looses at
  the legion from the deck as the ship runs in.
- **Its numbers are in:** the company charges the century facing it, the archer shoots over the
  phalanx and the ballistae on the gate towers answer; legionaries hit by arrows are knocked flat
  and get up again. After six and a half seconds the attack ends the way the video does, by likes
  per view against the median of the top videos the scouts found in the category
  (`outcomeOf()` in `scenes/battle.ts`): 15% better or more routs the century, which runs into the
  dark of the gate's passage, and the company follows to the gate and cheers; within 13% either
  way it holds its ground; worse, it falls back to the quay. Then it stands: the fight does not go
  on forever. Numbers that change later replay the attack.
- **Every video wins:** the whole legion runs for the gate, the legion's banners on the gate
  towers come down and the Greeks' go up, the leader calls "Rome is ours! Raise our colours on the
  gate!", and the rival's banner turns green: taken.
- **Missing numbers never become a result:** a landed company without views and likes waits on
  the quay; without at least three top videos with numbers there is no comparison, and the panels
  say so.
- **Going back:** if the plan steps back (the demo going back or starting over), the companies go
  back aboard wherever they are, the ships sail home, the soldiers march back into the horse, and
  the legion walks back out of its gate.

While the posts go out the camera goes with the expedition: the harbour while the army boards,
riding along with the fleet across the sea, then the city once a company lands (closer up on
phones). A tag over each company says where it is in its story (boarding, under sail, landing,
fighting) and then its result ("▲ 19% vs top videos"); a scoreboard under the city gives your likes
per view against the top videos'. The agora's panel has the expedition in numbers, and a soldier's
card shows the video his company sails for. Analytics can come in any shape: `postNumbers()` reads
views and likes from the shallowest level that has them, so a total beside a per-platform
breakdown is not counted twice.

The demo replays the same. The sample's numbers are made up like the rest of it: the top videos
get 4.5% likes per view and every sample video beats them, so the demo ends with the city taken.
`npm run demo:export` records a real campaign's numbers (the top videos' median views and likes
per view, and each rival's ad count).

### Agents are people

Everyone in the plan is a figure that moves through the world; nobody appears or dissolves in the
open (`scenes/camp.ts`, tested in `tests/troy/camp.test.ts`):

- **The march.** Submitting the box mounts the camp while the doors open, so its first plan is
  known when the plank lands. The soldiers that step out of the horse are those agents, in plan
  order (scouts first); each walks the sandbars to its station and on to its post, and the camera
  follows the column down. The first one out leads the column and calls "Men of Achaea, out of the
  horse! Let's roll out!" in a speech bubble over his head.
- **Roads.** The sandbars form a ring (the horse's road joins it at the scouts, and the agora
  links back to the scouts), and `travel()` in `scenes/layout.ts` takes the shortest way round it.
  A walker crossing an island goes by its crossing points (`HUBS`), set clear of the shrine, the
  seats, the desks and the podium; one stopping there walks straight from the island's edge to its
  post. Soldiers march at double time and riders gallop, with longer strides at speed, so the camp
  keeps up with the campaign.
  Opening a camp directly (or with reduced motion) places everyone at once, appearing with the
  islands.
- **Later.** An agent that joins later (a scout for a new source) comes out of the horse the same
  way; one the plan drops marches back up the plank into it. Posts that move (the inspector, the
  audience) are walked to; posts off the ground are climbed to (`via` waypoints: the tower's
  ladder, the podium's step, the shrine's floor).
- **Nobody leaves the map.** Scouts ride to their land and back in plain view. At the stable,
  everyone walks or rides along the aisle behind the horses, so nobody passes through one. The
  horses come in five coats so a line of them reads as horses.

The knock on the closed doors (every few seconds, and while the campaign starts) jolts the closed
doors' own sprite outward and back, twice. It never swaps frames, so nothing re-shades or flickers;
and the stage keeps the last drawn sprite of anything whose next frame is still baking.

## Looking closer

**The map.** Scroll or pinch to zoom toward the pointer, and drag to look around. The + − buttons
at the bottom right do the same, as do the keys + − 0. Zooms settle on whole device pixels per art
pixel, so the art stays crisp. Once you move the camera it stays yours (the fit button turns red)
until you press fit (or 0), open a station or click a soldier.

Left alone, the camera frames the camp; the lands stay out of view to the west, and the harbour
and the sea below, until you zoom or pan out to them. While posts go out it goes with the
expedition (see above). Zoomed out, the station tags shrink to their names. The land labels shrink to their names, then to a marker in the land's colour with the
count of scouts out.

**Agents.** Every soldier on the map can be clicked (hover shows a ring and a pointer; a tap works
on phones). Their card (`camp/AgentCard.tsx`) shows a Greek name, an animated portrait from the
same sprites, what they are doing this moment in the camp ("Galloping to Reddit for what people
say"), their part of the campaign, and their piece of it drawn out: a scout's land, its sources,
its trip and the basket, an editor's video on its production line with every shot as a frame of film, the
inspector's verdicts, the painter's frames, the courier's errand on a map of the camp, the
strategist's brief, the audience's cut, the herald's posts. A marker bobs over their head and the
camera follows them, galloping riders included, until the card closes (or "Follow" is turned
off). `CampScene.pick()`, `info()` and `position()` are what the card reads.

**Stations.** A station's panel (`camp/StationPanel.tsx`) opens with its emblem, a one-line
explanation and a clickable map of the camp, then its agents as portraits (each opens their card)
and its work as pictures: sources as tiles and the basket, the format study's steps, the brief and
concept cards, each video's production line, the theatre's cut with approve and post, and each
post's journey from queued to posted. The latest dispatches for the station close it. The pieces
both share are in `camp/ui.tsx`.

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
  (a pose is a few joint angles; looks vary skin, crest, tunic, shield emblem), the riding horse in
  five coats, the station props and the lands' landmarks. `ships.ts` has the trireme in two
  sprites, the hull (a clipped box: pointed ends, raked bow and stern; the ram, the eye, the band,
  shields, oars in four strokes, gangplanks) and the rig (mast, yard, a bellying sail that is a
  slice of a cylinder), so soldiers on deck sort between them; and the harbour's furniture.
  `rome.ts` has the city, designed small and drawn twice the size through `engine/scaled.ts` (a
  model wrapper that scales positions, sizes and clip planes while materials keep seeing design
  units), so the buildings tower over the soldiers.
- `engine/grounds.ts`: islands, sandbars, the sea (a rounded box with a wandering coast, foam
  where it laps a shore, shallows, swell and glints) and towns (an island cut straight along its
  quays, paved as quay blocks, a forum's marble with a medallion, or cobbled streets). The big
  ones bake in tiles, each with the shadows of what stands near it.
- `engine/jobs.ts`: every drawable as a serialisable job (`{ k: "soldier", look, act, dir, f }`).
  `engine/bake.worker.ts` bakes jobs in a pool of up to three workers, with an inline fallback.
  `engine/baker.ts` caches the results as `ImageBitmap`s.
- `engine/stage.ts`: one canvas, a camera in art pixels and whole device pixels per art pixel where
  that costs little (quarter steps otherwise). The viewer's zoom eases toward the pointer and settles
  on those same crisp steps; panning stays within the world. The stage depth-sorts entities
  isometrically, draws soft blob shadows and pixel-dissolve reveals, and keeps HTML anchored to
  world points.

To add a prop: write a builder in `engine/models/props.ts`, add a case to `propModel()` in
`jobs.ts`, and place it in `scenes/stations.ts`. The island bakes its shadow automatically. To add
an activity, add an `Act` and its pose in `poseFor()`.

## Numbers

Measured in headless Chromium at 1440×900, 2x (software rendering, so real GPUs do better):
- **Landing:** the website box appears about 0.5 s after load, and the horse about 1 s after load
  in dev mode.
- **Frame time:** a median of 16.7 ms and a 95th percentile of 16.8 ms over the first 25 s after
  pressing the button: the doors, the column marching into the camp, the camera following it, and
  the scouts riding out to the lands with the camera pulled back. Over four runs, the slowest frame
  was 117 ms once, 50 ms twice, and under 34 ms once.
- **The expedition:** over 40 s from the posts going out (boarding, the voyage with the camera
  riding along, the landing and the battle in the city: an army of 28, the legion of 25, arrows and
  bolts), a median of 16.7 ms and a 95th percentile of 33.4 ms; 13 of 1,827 frames took over
  34 ms, the slowest 150 ms.
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
- deterministic baking, the door timeline and the knock;
- the roads, the roads west to every land, and the stable and waiting places standing on sand;
- the lands: which land each source rides to, lands clear of each other and of the camp, their
  spots on sand, and every landmark baking;
- the agents as people, on the real scene with a stubbed canvas: the column reaching every post,
  one scout per land riding out, gathering there, riding back and filling the basket, scouts
  running on foot when every horse is out, a scout setting out again for a new source, the
  courier, agents marching home, and that nobody fades out anywhere but the horse's doorway;
- the shortest routes, and crossings that keep clear of the furniture;
- picking a soldier, what the card is told about a scout's trip and the courier's errands, and
  that every agent has a name of its own;
- the gate and the demo-only switch;
- the demo's clock: research paced to the rides, the review that waits, posting now or one a day,
  autoplay, skips, where event lines land, and loading recordings;
- the expedition: reading views and likes from any shape of analytics, the top videos' benchmark,
  a company per finished video and a ship for each, the phases, how each attack ends, no result
  without numbers; on the real scene, the army mustering on the quay, sailing when the posts go
  out, routing or falling back by its numbers and then standing still, the city taken only when
  every video wins, everyone home again when the demo starts over, and legionaries knocked down
  getting up again.

## Not done yet

- **The real product online:** ready on Convex (docs/convex.md); waiting for the Convex project and
  the provider keys on Vercel.
- **Phones:** the warm-up track (`/api/phones/*`) isn't shown in the camp yet; a soldier scrolling a
  phone would fit the Agora.
- **Linking:** the brand workspace (`/brands/[id]`, core) doesn't link to the camp yet; the camp
  links to the workspace.
- **Theme:** the core's pages keep their dark theme.
