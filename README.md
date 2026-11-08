# Nomen

Paste a brand's website. Nomen researches the brand, its competitors and what is winning on
short-form video and in AI answers, writes a strategy, produces original UGC-style video ads, checks
every shot, and posts the videos you approve to the brand's own accounts.

```
website ─► research (Monid) ─► format study ─► strategy (Naive agent) ─► production (Naive video, Monid backup) ─► review ─► posting (Naive Social)
```

## Quick start

```bash
npm install
cp .env.example .env.local        # or paste keys in Settings later
npm run naive -- claim < key.txt  # once: bind the Naive CLI to your organization (see docs/naive.md)
npm run naive:apply               # once: creates the nomen-strategist agent on Naive
npm run dev                       # http://localhost:3000
```

Open the app, paste a website and press **Start campaign** (tick *Static ads only* to skip video). The header shows your Naive and Monid
balances; **Settings** holds the keys, the video model, campaign size and the switches below.

## What happens to a website

| Step | Runs on | What it does |
| --- | --- | --- |
| Research | Monid | About 17 calls: brand profile, homepage copy, similar sites, Ahrefs domain rating and keywords, then a model plans the category, competitors and search phrases, and Nomen pulls the top TikTok, Reels and Shorts videos, Meta and TikTok ad-library ads, on-topic Reddit threads, and what ChatGPT and Perplexity answer when a buyer asks. |
| Format study | Naive (vision model) | Downloads the top-performing videos, reads their frames and writes down what they do: hooks, shot structure, pacing, text style, delivery. |
| Strategy | Naive agent `nomen-strategist` | Brand brief, audience, competitors, what works, an SEO / AEO / GEO plan, and the video concepts with shot-by-shot prompts. |
| Production | Naive (Monid as backup) | For every shot: a first frame rendered from the brand's real product photos, a Veo 3.1 render animated from that frame, and a quality check. Shots are cut into one 1080×1920 video. |
| Review | You | Watch, edit captions, approve or re-render with a director's note. |
| Posting | Naive Social | Approved videos go to the brand's connected accounts, now or one per day, labeled AI-generated. Post status and analytics come back into the app. |
| Static research | Monid | About 20 more calls: the category's and competitors' image ads in Meta's ad library ranked by impressions, competitors' and category leaders' image posts on X with views and engagement, Google display and search ads, LinkedIn ads for B2B brands, agency case studies, and a screenshot of the brand's site. |
| Ad study | Naive (vision model) | Reads the brand's site and the best-ranked ads and sets the art direction the renderer follows: ground, type, decoration, imagery, layouts. |
| Static ads | Naive (copy and checks), Nomen (rendering) | Concepts and the copy each platform asks for, every number and quote checked against the site; every size drawn in real type; a vision check of the finished images. Download one ZIP per pack. See `docs/static-ads.md`. |

## Quality

Video quality is the product, so production is built to avoid the usual tells of AI video:

- **The real product on screen.** Each concept's first shot starts from a still rendered with the
  brand's own product photos as references; later shots reference that still so the same person,
  outfit and room carry through the cut.
- **Prompts written like a director's brief.** `naive/agents/strategist.md` holds the rules: one
  specific creator repeated word for word in every shot, dialogue that fits the shot (at most 18
  words per 8 seconds), real camera and light, and nothing video models render badly (on-screen
  text, crowds, fine finger work).
- **A quality gate.** After every render, frames go to a vision model with the brief. A shot with a
  garbled label, deformed hands, an identity change or a wrong action is re-rendered with a corrected
  prompt (`qc_max_retries`, default 2); a rejected shot also gets a rebuilt first frame, since the
  defect is often in its composition. Scores and notes are shown on every video.
- **The same person in every shot.** Before the cut, a continuity check compares one frame per shot;
  a shot that shows a different person or room is re-rendered from shot 1's look. If shot 1 had to
  render without a first frame, a still from its video becomes the reference for the others.
- **Finishing.** Shots are normalized to 1080×1920 at 30 fps with clean AAC audio and cut together
  with ffmpeg (the system binary, or the bundled `ffmpeg-static`).

## Costs

Measured on this account in November 2026:

| Item | Cost |
| --- | --- |
| Research on Monid | $0.06–$0.35 per campaign (Ahrefs keywords are most of it) |
| Research plan (Claude Haiku) and format study (Claude Sonnet) on Naive | a few cents |
| Strategist session (Claude Sonnet 5.5) on Naive | about $0.21 |
| Veo 3.1 on Naive | $0.40 per second: an 8-second shot is $3.20, the default campaign (4 videos × 2 shots × 8 s) about $25.60 before re-renders |
| Kling 3.0 on Monid (backup) | $0.168 per second at 1080p with audio |
| A post through Naive Social | $0.013 per post, $0.0325 when it includes X |
| A static ad pack (4 concepts at 14 sizes, research included) | about $0.56: $0.08 on Monid, $0.48 on Naive, measured on a static-ads-only campaign |

For these costs set against Higgsfield, a Claude subscription and human UGC creators, with the
arithmetic, see `docs/sales-numbers.md`.

When Naive runs out of credits mid-campaign, new renders switch to Kling 3.0 on Monid automatically
and the campaign says so. Research always runs on Monid, so Naive's balance goes to video.

## Rules Nomen keeps

- **Brand-owned accounts only.** Posting goes through accounts the brand connects itself; Nomen
  never creates accounts or posts as invented people.
- **Labeled.** Every post sets Naive's `ai_generated` flag, which applies each network's AI-content
  label and adds `#AIgenerated`.
- **No fake testimonials.** Creators share the product; they never claim results, reviews or
  experiences that did not happen, and claims stay within what the brand's own site says.
- **Inspired, not copied.** Competitor videos inform structure and pacing, never people, scripts or
  branding.
- **A person approves.** Nothing posts until someone approves it, unless Autopilot is switched on in
  Settings, or a brand's Autopilot tab is on with "Post automatically" ticked.
- **Budgets come from people.** A brand's Autopilot starts its next campaign by itself only within
  the weekly budget someone typed in; with no budget it never starts one (`src/lib/loop.ts`).

## Architecture

- `src/lib/` — the engine: `research.ts` (Monid pack), `format.ts` (format study), `strategy.ts`
  (contract with the strategist), `production.ts` (frames, renders, QC, finishing), `publish.ts`,
  `pipeline.ts` (the state machine), `worker.ts` (the loop that drives it), and clients for Naive
  and Monid.
- `src/lib/statics/` — static ads: research fan-out, ad study, copywriter and checks, layouts and
  rendering (`next/og`, bundled fonts in `assets/fonts`), the pack pipeline and the ZIP. See
  `docs/static-ads.md`.
- `src/app/` — Next.js 16 pages and API routes. `src/components/` — the UI.
- SQLite in `data/` holds brands, campaigns, research runs, videos, posts and the activity log;
  finished videos are kept in `data/media/`. Every step is idempotent, so restarting the server
  resumes every campaign where it stopped.
- `naive.config.ts` declares Nomen's Naive resources; change them only through `npm run naive`
  (see `docs/naive.md`).
- `src/lib/phones/`, `src/components/phones/` and `src/app/api/phones/` belong to the phones track
  (Mobilerun account warm-up), built in parallel; see `docs/handoff-dylan.md`.

## Tests

```bash
npm test                 # unit tests, including real Monid responses as fixtures and a static pack built end to end
npm run typecheck
NOMEN_SAMPLE_VIDEO=clip.mp4 npx vitest run tests/media.test.ts        # ffmpeg helpers on a real clip
NOMEN_LIVE_CAMPAIGN=cmp_… npx vitest run tests/format.live.test.ts     # live format study (costs cents)
```

## Sample output

`samples/monid/` holds the six real videos from the monid.ai test runs, with frame contact sheets,
the prompts, QC verdicts and an honest critique in `samples/monid/REVIEW.md`. Start there before
working on video quality.
