# Naive in Nomen

[Naive](https://usenaive.ai) is the hosted agent platform Nomen runs its agents on. This page
explains the setup in plain terms, what Naive can and cannot change, and how to use it day to day.

## The three commands

| Command | What it does |
| --- | --- |
| `npm run naive:plan` | Previews what `naive.config.ts` would create or change on Naive. Changes nothing. |
| `npm run naive:apply` | Shows the same preview, then applies it only after you type `apply`. Applying can create agents that spend credits. |
| `npm run naive -- <command>` | Any other Naive CLI command, for example `npm run naive -- whoami`. |

All three run the CLI version pinned in `package.json` (`@usenaive-sdk/cli` 1.0.3) through
`scripts/naive-guard.mjs`. Add `-s` (`npm run -s naive -- whoami`) to get clean JSON for piping.

## What Naive can and cannot change in this repo

Checked against the source of `@usenaive-sdk/cli` 1.0.3 and tested in a scratch folder:

| Naive command | Files it writes | Protection |
| --- | --- | --- |
| `naive init` | creates `naive.config.ts` | Refuses if one already exists. Only `--force` overwrites, and the guard refuses `--force`. |
| `naive template` | clones a Naive company repo into a new folder | Refuses a folder that is not empty. The guard also keeps it outside this repo. |
| `naive login`, `naive claim` | nothing in the repo | The key goes to `~/.config/vetta/config.json`, readable only by you. |
| `naive up` | nothing | It only changes resources on Naive (next section). |
| Downloads with `--out` (`media`, `computer`, `mobile`, `storage`) | the file you name | The guard refuses a file that already exists. |

Git is the safety net: anything Naive writes shows up in `git status`, and the guard lists it
after every command.

## What `naive up` can change on Naive

`naive up` matches resources in the Naive organization by name
([CLI reference](https://usenaive.ai/docs/cli/naive)):

- It creates or updates what `naive.config.ts` declares. The config is the source of truth, so a
  change made by hand in the Naive dashboard to one of those resources is undone by the next apply.
  Change the config instead.
- It never deletes by omission. Only names listed under `removed` are deleted.
- Renaming is a delete plus a create: put the old name under `removed` in the same apply.
- An app owned by another project is refused unless `--adopt` is passed, which the guard refuses.

The guard requires every agent, app, skill, vault and identity name, and every name under
`removed`, to start with `nomen-`. Other templates and people can create resources in the same
organization; the prefix means `naive up` can never match, change or delete one of theirs. The
guard also refuses `tasks`, because they create or edit the organization's CEO agent.

## The agents Nomen runs

`nomen-director` (Claude Sonnet 5.5) is the creative engine's director: it reads the product brief
and the beat-by-beat breakdowns of proven reference videos and returns the brand brief, the search
plan and one video brief per ad. Its standing instructions live in `naive/agents/director.md`;
`settings.strategist_agent` names it. It has no tools and the same budget as the strategist below.

`naive.config.ts` also declares the original agent, `nomen-strategist` (Claude Sonnet 5.5). It reads the research
Nomen already collected and returns the brand brief, the search plan and the video concepts as a
structured answer. Its standing instructions live in `naive/agents/strategist.md`. It has no tools,
so it cannot browse, buy, post or spend on its own, and its budget is $4 per run and $40 a month.
Video renders, images, the format study and quality checks are called directly by the app; they
are billed to the organization, not to this agent's budget.

To change the agent (its model, budget or instructions), edit the config or the Markdown file,
commit, then run `npm run naive:plan`, read the preview, and `npm run naive:apply`.

Any new agent needs a budget you choose, in integer micro-USD (1 USD = 1,000,000):
`cap_micro_usd` per period, `max_task_micro_usd` per session and a `period` of `day`, `week` or
`month`. Tools that publish or spend ask a person first by default, including `social.post`,
`generate_video`, `mobile` and `data_run`
([tools reference](https://usenaive.ai/docs/capabilities/tools)). Keep them on `ask` until you
trust the agent.

## What else Nomen uses on Naive

| Primitive | Used for |
| --- | --- |
| Model proxy (`/v1/proxy/anthropic/v1/messages`) | the research plan (Claude Haiku), the format study, shot QC and the continuity check (Claude Sonnet, with images) |
| Media (`/v1/media/images`, `/v1/media/videos`) | first frames and Veo 3.1 renders |
| Files | storing renders and the finished ads, and the signed links the review page plays |
| Identities and Social | one identity per brand (`nomen-brand-<domain>`), its connection page and the posts |

Naive's media-skill builder was tried for the format study and could not fetch public TikTok or
Instagram links (November 2026), so Nomen studies the videos itself from Monid's download links.

## Why there is no blueprint clone

The usual Naive onboarding ([skill.md](https://usenaive.ai/skill.md)) clones a ready-made company
repo (`naive template agency` or `media`) and builds on it. Nomen is its own product, so
`naive init` created a `naive.config.ts` in this repo instead. If you want to look at one of
Naive's templates, clone it next to this repo: `npm run naive -- template agency --dir ../agency`.

## Your API key

- **Claude Code cloud sessions:** the key is saved as a network secret for `api.vetta.sh` on the
  cloud environment. The session's proxy adds it to every request to that host, so it never sits
  in the repo, the chat or the shell. Run commands with a placeholder key and the proxy setting:
  `NODE_USE_ENV_PROXY=1 NAIVE_API_KEY=proxy-injected npm run naive:plan`. To remove the key, open
  the cloud environment menu in the session's title bar, choose Edit, then Network secrets.
- **Your own computer:** run `npm install`, put the key in `key.txt` (gitignored), run
  `npm run naive -- claim < key.txt`, then delete `key.txt`.

Never put a key on the command line, in chat or in a committed file.
