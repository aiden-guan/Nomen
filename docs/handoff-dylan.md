# Handoff: the phones track (Dylan)

Nomen turns a brand's website into researched, high-quality UGC-style video ads and posts them to
the brand's own accounts. This track adds **phones**: Mobilerun cloud phones that warm up a brand's
own new social accounts before posting starts. It runs in parallel with the core build, so it
lives in its own folders and touches the rest of the app at exactly two points.

## Who owns what (this is what prevents overlap)

You own these paths: create, edit and delete freely.

- `src/lib/phones/**`
- `src/components/phones/**`
- `src/app/api/phones/**`
- `src/app/dev/phones/**` (an optional scratch page; delete it before the PR)
- `tests/phones/**`
- `docs/phones.md`

Everything else is read-only for you, including `package.json`, `package-lock.json`,
`next.config.ts`, `naive.config.ts`, `src/lib/*.ts`, the rest of `src/app/**`,
`src/components/ui.tsx`, `CLAUDE.md` and the other docs. If you need a change outside your paths (a
dependency, a setting key, a new hook), list it in the PR under **Changes needed outside the phones
track** and it is made on the core branch.

## The integration contract

These signatures are stable; the core track will not change them without telling you.

1. **Worker hook.** The background worker calls `advancePhones()` from `src/lib/phones/index.ts`
   every ~4 seconds, inside a try/catch. Make it idempotent and quick: start due sessions, poll
   running tasks, record results. Never loop or sleep inside it.
2. **Brand page panel.** The brand page renders
   `<PhonesPanel brandId={…} brandName={…} niche={…} />` from
   `src/components/phones/PhonesPanel.tsx` (a client component). `niche` is a list of topics from
   the brand's latest strategy, empty before the first one. The panel fetches its own data from
   your `/api/phones/*` routes.
3. **What you may import (read-only):**
   - `@/lib/db`: `db()`, `newId(prefix)`, `now()`, `parse(json, fallback)`,
     `update(table, id, fields)`, `logEvent({ brandId, message, level? })`. The event shows up in
     the brand's activity feed.
   - `@/lib/settings`: `getSetting`, `getInt`, `secretStatus`, with the keys `mobilerun_api_key`,
     `mobilerun_base_url` and `warmup_minutes`.
   - `@/lib/http`: `ApiError`, `requestJson`.
   - `@/components/ui`: `Button`, `Card`, `Badge`, `Spinner`, `Stat`, `Empty` and `cx`, so the
     panel matches the rest of the app (dark theme, Tailwind 4).
4. **Data.** Create your own tables with `create table if not exists phone_…` from your module (for
   example on the first `advancePhones()` call). Read `brands` (`id`, `name`, `domain`); never
   alter other tables.

## What to build

- **Mobilerun client.** `src/lib/phones/mobilerun.ts` was written from the docs and has not been
  run against the live API. Verify every endpoint and response shape against
  https://docs.mobilerun.ai (start with `/cloud/quickstart.md` and `/agent.md`), then fix it.
- **Devices.** List devices with their state; provision an Android cloud phone
  (`POST /v1/devices?deviceType=android_cloud_phone&billing=minute`); resume a stopped one.
- **Link a brand account.** Per brand: the device, the platforms (TikTok, Instagram, YouTube, X,
  Reddit), the name of the login saved in Mobilerun's credential store for each app, and a required
  checkbox: "This is the brand's own official account."
- **Warm-up.** "Run now", plus a daily schedule for N days (default 7). Session length comes from
  `warmup_minutes`; the task brief comes from `warmupTask()` in `mobilerun.ts`, and its restrictions
  stay as written. Show each session's status, steps and result, plus the history.
- **States.** With no key, show a setup card pointing to Settings. Show a device that is not ready
  and a task that failed in plain language.
- **Tests.** Use vitest in `tests/phones/`, with mocked `fetch`, covering the scheduling and task
  state machine.

## Rules

- **Brand-owned accounts only.** One account per platform per brand. Never create accounts.
- **Passive warm-up.** Browse and watch the niche, like at most 8 videos, follow at most 2
  creators. Never post, comment, message, buy, change settings or engage with the brand's own posts.
- **Show the risk.** In the panel, state that automated activity can break a platform's terms and
  put the account at risk.
- **Keep keys out of the repo, chat and command lines.** Locally, use `.env.local` (gitignored). In
  a Claude Code cloud session, save the key as a network secret for `api.mobilerun.ai` and run with
  `MOBILERUN_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1`.

## Git

1. Branch `dylan/phones` from the latest `claude/pensive-shannon-bkisql`, and push only to
   `dylan/phones`.
2. Before opening the PR, run `git merge origin/claude/pensive-shannon-bkisql`. There should be no
   conflicts if the ownership above held. Then run `npx vitest run tests/phones` and
   `npx tsc --noEmit`.
3. Open the PR into `claude/pensive-shannon-bkisql`.

## Running it

```bash
npm install
cp .env.example .env.local   # add MOBILERUN_API_KEY
npm run dev                  # http://localhost:3000
```

You only need a Mobilerun key for this track. Without Naive and Monid keys, a new brand's campaign
stops at research with a message, and the brand page and your panel still work.

## Prompt for Dylan's Claude Code session

> Read `docs/handoff-dylan.md` in this repo and build the phones track it describes. Work only in the
> paths it assigns to the phones track, on branch `dylan/phones` created from
> `origin/claude/pensive-shannon-bkisql`. Verify the Mobilerun API against its live docs before you
> rely on it, and follow the rules section exactly. When done, merge the latest core branch, run the
> tests and typecheck, and open a PR into `claude/pensive-shannon-bkisql`.
