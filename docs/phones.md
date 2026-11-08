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
  caption, TikTok's AI-generated content label, an #AIgenerated tag and a song from TikTok's own
  sounds, publicly or, with "Only you" ticked, as a private test only the brand's account can see.
  Internal remakes nobody cleared (`postingHold` in `src/lib/publish.ts`) are refused at the click
  and again before the phone is woken, private or not.
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
   the agent's report (`posted`, `postUrl`, `aiLabel`, `onlyYou`, `reason`, and the song:
   `soundTitle`, `soundArtist`, `soundVolume`, `commercialSound`, `accountType`). The brief opens
   TikTok, taps + and Upload, picks the video, adds a song (below), types the caption (one line,
   tagged #AIgenerated), turns on "AI-generated content" (it must not post without it), sets "Who
   can watch this video", posts once and copies the link. A public post sets "Everyone" (TikTok
   keeps the last post's choice) and, where TikTok offers it, the "Your brand" disclosure. A
   private test sets "Only you" and must not post if it can't. `apps`: TikTok. `credentials`: the
   saved TikTok login, if any. `vpnCountry`: the brand's, if chosen. Recording is on where the
   phone supports it. Up to 80 steps and 15 minutes.
4. Polls the task, records `posted` (with the link, when the agent copied it), `failed` or
   `cancelled` and the song it added, logs it, and parks the phone. A private test the agent
   didn't confirm as "Only you", a public post that went out as "Only you", a post with no song
   reported, or a public post whose song isn't from the Commercial Music Library is posted with a
   warning to check it.

**The song.** The agent adds it inside the app, from TikTok's own sound picker ("Add sound"),
never mixed into the file: TikTok licenses its sounds in the app, while music baked into an upload
gets muted. The videos carry only their voice and small sound effects. A song can be named per post
("Timeless by The Weeknd", the camp's song field, `song` in the request); without one the agent
picks a popular trending one. In TikTok's Volume control the original sound stays at 100% and the
song goes to about 20% (15–25%). The agent must not post without a song. A Business account's
picker only offers TikTok's Commercial Music Library, so mainstream hits may be missing there and
the agent takes the closest popular song that is available; it reports the account type and the
song, and both are kept on the post.

Only the Commercial Music Library is cleared for brand content. TikTok's own business pages say
general-library songs aren't, and that a business promoting itself with them from a personal
account risks copyright infringement. A public post's song from outside that library is recorded
with a warning, and the camp marks it "not cleared for brand content". If TikTok won't take the
song together with the "Your brand" disclosure, the agent keeps the disclosure and picks a song
TikTok allows. Keeping brand accounts as Business accounts keeps every post inside the library.

Copying and creating the task are retried after errors that can pass (up to 5 tries); the task
itself runs once. A post that failed, or ended without the agent's report, is never posted again by
itself, because the video may have gone out: its message says to check the brand's TikTok profile,
and a person can click again. A video already posted publicly, through the phone or to TikTok
through Naive, is refused a second public post; a private test doesn't count, so a video can be
tested privately and then posted. Cost: up to 80 steps, about 40 credits ($0.40), plus up to 15
minutes of phone time.

## One-time phone setup for posting

Each phone is set up once, before its first post. "Set up for posting" in the Phones panel has the
phone agent do the app work: install TikTok from the Play Store and give it access to all photos
and videos. Signing in stays with a person, since it needs your Google and TikTok logins and often
a code sent to you; the agent never signs in, signs up or creates accounts. Nomen doesn't create
social accounts at all: the brand's own account is made by a person, in the app or on TikTok's
site.

1. Link the brand's phone and its TikTok account in the Phones panel on the brand's page. A saved
   login name is optional.
2. Click "Set up for posting". The session list shows what the agent found and what is left for
   you. Afterwards the phone stays on for 30 minutes, then it is parked.
3. If it says to sign in to Google Play: open the phone's screen in Mobilerun's dashboard, sign in
   with a Google account you are happy to keep on a cloud phone, and run the setup again.
4. Log in to the brand's own official TikTok account on the phone's screen, entering any code
   TikTok sends. The account must be public: TikTok refuses public posts from a private account.
5. Optional: save the TikTok login in Mobilerun's credential store and pick it in the panel, so the
   agent can log back in if TikTok logs out.

If the agent couldn't give TikTok access to the videos, do it by hand: in Android's Settings, Apps,
TikTok, Permissions, Photos and videos, choose "Allow all" ("Select photos and videos" hides the
videos Nomen copies later). The setup task: model `mobilerun/mobile-agent-fast`, up to 60 steps
(about 30 credits) and 15 minutes; `apps`: Play Store, Settings and TikTok; no logins passed; an
`outputSchema` for the report (`googleSignInNeeded`, `tiktokInstalled`, `photoAccess`,
`tiktokLoggedIn`, `reason`).

Then approve a video and use "Post through phone" in the camp's theatre, ticking "Only you" for a
first private test. Mobilerun's dashboard shows each task live and keeps its recording.

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
- `phone_sessions`: every warm-up session, and each setup for posting (`kind` = `setup`), with its
  status, its Mobilerun task, steps, result and timestamps. A scheduled session is unique per
  brand, platform and day.
- `phone_parks`: phones waiting to be parked, one row per phone, with when to try next, how many
  tries failed and the last error. A row is removed once the phone is parked or can't be.
- `phone_posts`: every post through a phone: the video, its title and caption, public or private
  (`visibility`), the song asked for (`sound_request`) and the one added (`sound_title`,
  `sound_artist`, `sound_volume`, `sound_commercial`, `account_type`), the file's name and folder on
  the phone, its status, its Mobilerun task, the post's link and the agent's report. Columns added
  after the table first shipped are added to older tables on first use.

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
| `POST /api/phones/setup` | Set the brand's phone up for posting (`{ brandId }`): install TikTok and allow it all photos and videos |
| `GET /api/phones/posts?brandId=` | Whether "Post through phone" is offered here and can run now (if not, what to do first), its cost, and the brand's phone posts |
| `POST /api/phones/posts` | Post one finished, approved video through the brand's phone (`{ creativeId, visibility?, song? }`: `visibility` `"public"`, the default, or `"private"` for TikTok's "Only you"; `song` names the song to add from TikTok's sounds, up to 120 characters, else a trending one) |

## Running and testing

```bash
npx vitest run tests/phones                                   # mocked fetch; no key needed
MOBILERUN_LIVE=1 npx vitest run tests/phones/live.test.ts     # read-only check against the live API
```

The live check reads `MOBILERUN_API_KEY` from the environment or `.env.local`. It lists phones and
saved login names and prints only counts and states; it creates nothing and is not billed.
