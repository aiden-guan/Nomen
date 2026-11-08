# Phones

Nomen can warm up a brand's own new social accounts on a Mobilerun cloud phone before posting
starts. A warm-up session opens the app on the brand's phone and has Mobilerun's phone agent browse
the brand's niche the way its social manager would. The same phone can also send a creator the
outreach DM a person approved in real-creator mode. Phones are optional: campaigns and posting work
without them.

## Rules

- **Brand-owned accounts only.** Linking needs the "This is the brand's own official account"
  confirmation. One account per platform per brand, and one phone per brand (a phone linked to one
  brand cannot be linked to another). Nomen never creates accounts.
- **Passive warm-up.** The brief (`warmupTask()` in `src/lib/phones/mobilerun.ts`) browses and
  watches the niche, likes at most 8 videos and follows at most 2 creators. It never posts, comments,
  messages, buys, changes settings or engages with the brand's own posts.
- **Outreach: one approved DM, word for word.** A brief cast to a creator (`creative/casting.ts`)
  has an outreach draft. Once a person approves the brief, "Send from the phone" on its card queues
  an outreach session: the brief (`outreachTask()`) opens the brand's own account, finds the
  creator's exact handle (or stops), opens their DMs (or stops if they are closed), types the
  approved message exactly and sends it once. Nothing else: no second message, follows, likes or
  comments. A DM is sent once per brief. Nomen does not read replies or carry on the conversation.
- **The risk is on screen.** The panel always states that automated activity can break a
  platform's terms and put the account at risk.
- **Keys stay out of the repo.** Use `.env.local` or the Settings page. Logins live in Mobilerun's
  credential store; Nomen only stores and shows their names, never their values.

## How it works

```
panel ──/api/phones/*──▶ service.ts ──▶ store.ts (phone_* tables)
                                   └──▶ mobilerun.ts ──▶ api.mobilerun.ai/v1
worker ──advancePhones() every ~4 s──▶ engine.ts ──▶ same store and client
```

- **Session states.** `pending` (waiting its turn) → `waiting` (the phone is parked or not ready;
  a parked phone is resumed) → `starting` (creating the Mobilerun task) → `queued`/`running` →
  `succeeded`, `failed` or `cancelled`.
- **One task per phone.** Sessions on the same phone run one after another.
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
  while they run.

## Mobilerun API used

Checked against docs.mobilerun.ai on 2026-11-07. Base URL `https://api.mobilerun.ai/v1`, with
`Authorization: Bearer dr_sk_…`.

| Call | Use |
| - | - |
| `GET /devices` | List phones (`{ items, pagination }`); terminated and unknown phones are hidden by default |
| `GET /devices/{id}` | Phone state: `creating`, `assigned`, `ready`, `rebooting`, `migrating`, `resetting`, `maintenance`, `stopped`, `terminated`, `unknown` |
| `POST /devices?deviceType=android_cloud_phone&billing=minute` | New Android cloud phone, with an `Idempotency-Key` per click |
| `POST /devices/{id}/resume` | Wake a parked (`stopped`) phone (204) |
| `POST /tasks` | Start a warm-up (201 `{ id, status, streamUrl }`) |
| `GET /tasks/{id}/status` | `{ status, succeeded, message, steps, recordingId, execution.terminationReason }` |
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
- `phone_sessions`: every warm-up and outreach session, with its status, its Mobilerun task, steps,
  result and timestamps. `task` is `warmup` or `outreach`; an outreach session keeps its DM in
  `payload_json` (the brief, the creator's handle, the approved message). A scheduled session is
  unique per brand, platform and day. The phone runs one session at a time; a DM queued during a
  warm-up waits for it.

The tables are created by the module on first use. `brands` is only read.

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
| `GET /api/phones/outreach?brandId=&creativeId=` | A brief's outreach DM: its latest session |
| `POST /api/phones/outreach` | Send a brief's approved outreach DM from the phone (`{ brandId, creativeId }`) |

## Running and testing

```bash
npx vitest run tests/phones                                   # mocked fetch; no key needed
MOBILERUN_LIVE=1 npx vitest run tests/phones/live.test.ts     # read-only check against the live API
```

The live check reads `MOBILERUN_API_KEY` from the environment or `.env.local`. It lists phones and
saved login names and prints only counts and states; it creates nothing and is not billed.
