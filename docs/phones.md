# Phones

Nomen can warm up a brand's own new social accounts on a Mobilerun cloud phone before posting
starts. A warm-up session opens the app on the brand's phone and has Mobilerun's phone agent browse
the brand's niche the way its social manager would. A person can also post one finished video on
TikTok through the brand's phone ("Post through phone" in the camp). Phones are optional: campaigns
and posting through Naive work without them.

## Rules

- **Brand-owned accounts only.** Linking needs the "This is the brand's own official account"
  confirmation. One account per platform per brand, and one phone per brand (a phone linked to one
  brand cannot be linked to another). Nomen never creates accounts.
- **Passive warm-up.** The brief (`warmupTask()` in `src/lib/phones/mobilerun.ts`) browses and
  watches the niche, likes at most 8 videos and follows at most 2 creators. It never posts, comments,
  messages, buys, changes settings or engages with the brand's own posts.
- **Posting only when a person asks.** Posting through a phone is a separate task (`postTask()` in
  the same file), not part of the warm-up, whose no-posting rule stays as written. It runs only when
  a person clicks "Post through phone" for one video in the camp's theatre: never on a schedule, on
  autopilot or for a whole campaign. It posts that one approved video on the brand's TikTok with its
  caption, TikTok's AI-generated content label and an #AIgenerated tag. Internal remakes nobody
  cleared (`postingHold` in `src/lib/publish.ts`) are refused at the click and again before the
  phone is woken.
- **The risk is on screen.** The panel always states that automated activity can break a
  platform's terms and put the account at risk.
- **Keys stay out of the repo.** Use `.env.local` or the Settings page. Logins live in Mobilerun's
  credential store; Nomen only stores and shows their names, never their values.

## How it works

```
panel ──/api/phones/*──────▶ service.ts ──▶ store.ts (phone_* tables)
camp ───/api/phones/posts──┘           └──▶ mobilerun.ts ──▶ api.mobilerun.ai/v1
worker ──advancePhones() every ~4 s──▶ engine.ts + posting.ts ──▶ same store and client
```

- **Session states.** `pending` (waiting its turn) → `waiting` (the phone is parked or not ready;
  a parked phone is resumed) → `starting` (creating the Mobilerun task) → `queued`/`running` →
  `succeeded`, `failed` or `cancelled`.
- **One task per phone.** Sessions and posts on the same phone run one after another. A waiting
  post goes before a waiting warm-up, since a person is waiting for it.
- **Parking.** Once a session or post ends (finished, failed, stopped or timed out), the worker
  parks its phone with `POST /devices/{id}/stop`: the phone keeps its apps and logins and is not
  billed until a session wakes it again. A phone is left on while another session or post holds it
  or is due on it within 5 minutes; the end of that one parks it. A failed park is retried on later ticks (30 s,
  60 s, … at most 10 minutes apart) and never fails a tick; the first failure puts one warning in
  the activity log. A phone Mobilerun can't park (it answers 404) gets one warning and stays on.
- **Idempotent ticks.** Each step claims its session with a conditional update. The Mobilerun task
  is created with the session id as its `Idempotency-Key`, so a create that is retried after a crash
  returns the same task. An overlapping `advancePhones()` call returns the tick already in flight.
- **Quick ticks.** A tick looks at no more than 8 due sessions. Each session records when it next
  needs checking (10 s while running, 20 s while waiting for a phone, longer after errors), so most
  ticks make no API calls.
- **Failure handling.**
  - Retryable errors (busy phone, rate limits, network) back off and retry, up to 5 attempts.
  - Errors the user must fix (bad key, no credits or minutes, deleted phone) fail the session with a
    plain-language message.
  - A session gives up on a phone that is not ready within an hour.
  - A session still running 30 minutes past its length is cancelled.
  - A phone that cannot record its screen runs the task without recording.
- **Schedule.** "Daily for N days" (default 7) queues one session per linked account per day,
  starting when the schedule is turned on. Days the worker was down are skipped, not caught up.
  Turning the schedule off stops scheduled sessions that have not started.
- **Task settings.** Model `mobilerun/mobile-agent-fast`.
  - Session length comes from the `warmup_minutes` setting (default 12).
  - From that: `maxSteps` = 12 per minute and `executionTimeout` = length + 5 minutes. Mobilerun caps
    the timeout at 2700 s.
  - On: `reasoning`, `vision`, `humanize`, and `recordingEnabled` where the phone supports it.
  - `apps`: the platform's package.
  - `credentials`: the saved login name, if one was given.
  - `vpnCountry`: if one was chosen.
- **Cost.** At about 0.5 Mobilerun credits per step, a 12-minute session costs at most about 72
  credits ($0.72). Android cloud phones are provisioned with `billing=minute` and bill per minute
  while they run past the plan's included minutes, so the worker parks a phone between sessions.
  A phone you wake by hand (the panel's Wake button or Mobilerun's dashboard) is billed until you
  park it in Mobilerun's dashboard or the next session on it ends.

## Posting through the phone

"Post through phone" in the camp's theatre queues one finished, approved video for the brand's
linked phone (`POST /api/phones/posts`). The camp doesn't offer it on the Vercel deployment, where
phones don't run (their tables live in the local SQLite database). Nothing touches the phone until
the worker's next tick, which then (`src/lib/phones/posting.ts`):

1. Checks the video may still go out (still approved, not a held remake, the phone and TikTok
   account still linked), waits for the phone like a session does, and wakes it if it is parked.
2. Copies the cut onto the phone as `nomen-<post id>.mp4` in `/DCIM/Camera`, or in `/DCIM` on a
   phone without a Camera folder. Earlier `nomen-*.mp4` files in that folder are deleted first, so
   the newest video in the gallery is this one; the phone's own files are left alone. The folder is
   listed afterwards, and a file that didn't arrive whole is copied again.
3. Creates the posting task with the post's id as its `Idempotency-Key` and an `outputSchema` for
   the agent's report (`posted`, `postUrl`, `aiLabel`, `reason`). The brief opens TikTok, taps +
   and Upload, picks the video, types the caption (one line, tagged #AIgenerated), turns on
   "AI-generated content" (it must not post without it) and, where TikTok offers it, the "Your
   brand" disclosure, posts once and copies the link. `apps`: TikTok. `credentials`: the saved
   TikTok login, if any. `vpnCountry`: the brand's, if chosen. Recording is on where the phone
   supports it. Up to 80 steps and 15 minutes.
4. Polls the task, records `posted` (with the link, when the agent copied it), `failed` or
   `cancelled`, logs it, and parks the phone.

Copying and creating the task are retried after errors that can pass (up to 5 tries); the task
itself runs once. A post that failed, or ended without the agent's report, is never posted again by
itself, because the video may have gone out: its message says to check the brand's TikTok profile,
and a person can click again. A video already posted, through the phone or to TikTok through
Naive, is refused. Cost: up to 80 steps, about 40 credits ($0.40), plus up to 15 minutes of phone
time.

## One-time phone setup for posting

A person sets up each phone once, before its first post. The phone agent can't do these steps:
they need your Google and TikTok logins and often a code sent to you.

1. Link the brand's phone and its TikTok account in the Phones panel on the brand's page. A saved
   login name is optional.
2. Wake the phone (Wake in the panel, or Mobilerun's dashboard) and open its screen in Mobilerun's
   dashboard.
3. Open the Play Store and sign in with a Google account you are happy to keep on a cloud phone.
4. Install TikTok (`com.zhiliaoapp.musically`) from the Play Store.
5. Open TikTok and log in to the brand's own official TikTok account, entering any code TikTok
   sends. The account must be public: TikTok refuses public posts from a private account.
6. Give TikTok access to all photos and videos: tap +, then Upload, and choose "Allow all", not
   "Select photos and videos", which hides the videos Nomen copies later. Back out without posting.
   (Or in Android's Settings: Apps, TikTok, Permissions, Photos and videos, Allow all.)
7. Optional: save the TikTok login in Mobilerun's credential store and pick it in the panel, so the
   agent can log back in if TikTok logs out.
8. Park the phone in Mobilerun's dashboard when you are done: it bills per minute while it is on.
   Don't run warm-ups while you set it up, because a finished session parks the phone.

Then approve a video and use "Post through phone" in the camp's theatre. Mobilerun's dashboard
shows the task live and keeps its recording.

## Mobilerun API used

Checked against docs.mobilerun.ai on 2026-11-07. Base URL `https://api.mobilerun.ai/v1`, with
`Authorization: Bearer dr_sk_…`.

| Call | Use |
| - | - |
| `GET /devices` | List phones (`{ items, pagination }`); terminated and unknown phones are hidden by default |
| `GET /devices/{id}` | Phone state: `creating`, `assigned`, `ready`, `rebooting`, `migrating`, `resetting`, `maintenance`, `stopped`, `terminated`, `unknown` |
| `POST /devices?deviceType=android_cloud_phone&billing=minute` | New Android cloud phone, with an `Idempotency-Key` per click |
| `POST /devices/{id}/resume` | Wake a parked (`stopped`) phone (204) |
| `POST /devices/{id}/stop` | Park a phone once its sessions are over (204; 404 when the phone can't be parked) |
| `POST /devices/{id}/files?path=<folder>` | Copy a cut onto the phone: multipart form data, field `file`, saved under its file name (204; Android only) |
| `GET /devices/{id}/files?path=<folder>` | List a folder (`{ path, total, files }`); a missing folder answers 404 |
| `DELETE /devices/{id}/files?path=<file>` | Delete an earlier post's cut (204) |
| `POST /tasks` | Start a warm-up or a post (201 `{ id, status, streamUrl }`); a post sends an `outputSchema` (JSON Schema) |
| `GET /tasks/{id}/status` | `{ status, succeeded, message, output, steps, recordingId, execution.terminationReason }`; `output` is the agent's report when an `outputSchema` was sent |
| `POST /tasks/{id}/cancel` | Stop a task (`{ cancelled }`) |
| `GET /credentials` | Saved logins; only `packageName` and `credentialName` are kept |

## Data

- `phone_links`: one row per brand.
  - The brand's phone: `device_id`, unique, so a phone belongs to one brand.
  - When the official-account box was confirmed.
  - The niche topics and the optional traffic country.
  - The schedule.
- `phone_accounts`: one row per brand and platform, with the saved login name (or none if the app
  is already logged in).
- `phone_sessions`: every warm-up session, with its status, its Mobilerun task, steps, result and
  timestamps. A scheduled session is unique per brand, platform and day.
- `phone_parks`: phones waiting to be parked, one row per phone, with when to try next, how many
  tries failed and the last error. A row is removed once the phone is parked or can't be.
- `phone_posts`: every post through a phone: the video, its title and caption, the file's name and
  folder on the phone, its status, its Mobilerun task, the post's link and the agent's report.

The tables are created by the module on first use. `brands`, `campaigns`, `creatives` and `posts`
are only read (posting reads the video, its cut and its earlier posts).

## API routes

| Route | Does |
| - | - |
| `GET /api/phones?brandId=` | Everything the panel shows |
| `GET /api/phones/devices` | Mobilerun phones and which brand each is linked to |
| `POST /api/phones/devices` | Provision an Android cloud phone (`{ brandId, idempotencyKey, country? }`) |
| `POST /api/phones/devices/{id}/resume` | Wake a parked phone |
| `GET /api/phones/credentials` | Saved login names per platform |
| `PUT /api/phones/link` | Link the phone, accounts, topics and traffic country (`official: true` required) |
| `DELETE /api/phones/link?brandId=` | Unlink; stops running sessions; the phone stays in Mobilerun |
| `PUT /api/phones/schedule` | `{ brandId, enabled, days }` |
| `POST /api/phones/sessions` | Run now (`{ brandId, platform? }`) |
| `POST /api/phones/sessions/{id}/cancel` | Stop a session |
| `GET /api/phones/posts?brandId=` | Whether "Post through phone" is offered here and can run now (if not, what to do first), its cost, and the brand's phone posts |
| `POST /api/phones/posts` | Post one finished, approved video through the brand's phone (`{ creativeId }`) |

## Running and testing

```bash
npx vitest run tests/phones                                   # mocked fetch; no key needed
MOBILERUN_LIVE=1 npx vitest run tests/phones/live.test.ts     # read-only check against the live API
```

The live check reads `MOBILERUN_API_KEY` from the environment or `.env.local`. It lists phones and
saved login names and prints only counts and states; it creates nothing and is not billed.
