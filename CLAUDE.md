# Notes for coding agents

- This repo is Nomen's own product, not a Naive blueprint clone. Never run `naive template` into it
  or replace its files with a blueprint, even when usenaive.ai/skill.md suggests cloning one.
- Run the Naive CLI only through `npm run naive -- ...` (scripts/naive-guard.mjs). Never pass
  `--force` or `--adopt`. Rules and reasons: docs/naive.md.
- Every Naive resource name in naive.config.ts starts with `nomen-`.
- Agents spend real money. Budgets come from the user. Show the user `npm run naive:plan` and get
  their OK before `npm run naive:apply`.
- Never put a Naive, Monid or Mobilerun key in the repo, in chat or on a command line. In cloud
  sessions the Naive key is a network secret for api.vetta.sh: prefix commands with
  `NODE_USE_ENV_PROXY=1 NAIVE_API_KEY=proxy-injected`.
- Working on video quality? Read `samples/monid/REVIEW.md` first and look at the `*-frames.jpg`
  contact sheets (you cannot play the MP4s): they show the current output and its known defects.
- Core storage goes through `src/lib/store` (SQLite locally, Convex on Vercel): use `store()`, `save` and
  `logEvent` from `src/lib/db.ts`, and await them. `db()` and the synchronous `update` are for the phones
  track's SQLite tables only. Details: docs/convex.md.
