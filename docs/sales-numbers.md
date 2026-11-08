# Sales numbers

Numbers to use when selling Nomen, each with its source and its arithmetic.

- **Nomen's side** was measured on this account in November 2026 (README, `docs/`, `samples/`).
- **Higgsfield's side** comes from Higgsfield's own blog posts. Its pricing page shows no prices when
  fetched, so the figures could not be checked against it. Checked 2026-11-08.
- **Claude's side** comes from claude.com/pricing, checked 2026-11-08.
- Every Nomen figure is **what it costs us to make**, not a customer price. Every comparison uses a
  first take on both sides (see [Re-renders](#re-renders)).

## The lines to use

| Claim | The numbers behind it |
| - | - |
| **About 4x cheaper per second of presenter video than Higgsfield's UGC ad tool** | Higgsfield Marketing Studio UGC ad: 160 credits per 10 s at 1080p, $6.88 on Ultra ($0.043 a credit). Nomen's presenter (Kling 3.0 via Monid, 1080p with audio): $1.68 per 10 s. 6.88 / 1.68 = **4.1x** (4.7x against Plus, 7.1x against Starter). |
| **A finished 16-second presenter ad for about $3.40–3.70**: researched, scripted, quality-checked and edited | [The breakdown below](#a-finished-16-second-presenter-ad). The same 16 s from Higgsfield's UGC tool at 1080p costs $11.01 on Ultra, **about 3x** as much, and that price covers the video only. |
| **Code ads cost nothing to render** | Three.js in headless Chrome plus ffmpeg on our own machine. No video model, no per-second fee. |
| **A 25-second code ad for about $1** on a flat Claude plan | Claude Max ($100 a month) at 100 ads a month is $1.00 per ad, plus $0.04 of narration: **$1.04**. The same 25 s from Higgsfield's UGC tool at 1080p costs $17.20 on Ultra: **16x**. [Other volumes below](#code-ads-on-a-subscription). |
| **56 finished static ads in about 4 minutes for $0.56** | 4 concepts at 14 platform sizes, with copy checked against the brand's site and vision checks of the finished images: **1 cent per finished size**. |
| **Research for 7 cents** | 30–33 sources per campaign: about 90 short videos and up to 16 ads ranked, plus Reddit, ad libraries and AI answers, for $0.07 on Monid (README range: $0.06–0.35). |
| **One month of Higgsfield Ultra ($129) buys about 3x the finished ads on Nomen** | On Higgsfield: 11 sixteen-second UGC ads at 1080p. On Nomen: 34–37 finished 16 s presenter ads. [Details below](#what-129-buys). |
| **About 50x cheaper than a human UGC creator** | The median human UGC video costs about $175 ([Influee, 2026](https://influee.co/blog/ugc-price)), so 175 / 3.69 to 175 / 3.40 = **47–51x**. This is marketplace data, not an audit. |

## What not to claim

- **Don't claim cheaper raw Kling.** Higgsfield sells raw Kling 3.0 at 25 credits per 10 s at 1080p:
  $0.108 a second on Ultra, $0.123 on Plus and $0.188 on Starter (Higgsfield doesn't say whether
  audio is included). We pay $0.168 a second with audio. Our saving is against Higgsfield's **ad
  tool** and in the work Nomen automates around the render. It does not come from cheaper model
  seconds.
- **Don't claim cheaper Veo.** Our Veo 3.1 on Naive costs $0.40 a second at 720p. Higgsfield lists
  Veo 3 with audio at about 58 credits per 8 s at 720p: $0.31 a second on Ultra, $0.36 on Plus.
  Kling 3.0 is our default presenter, so this rarely comes up.
- **Compare price, not quality.** These numbers don't show that our output matches Higgsfield's.
  The QC scores are in `samples/*/REVIEW.md`.
- **Code ads and brainrot ads are not in `main` yet.** They live on `generators/code-ads` and
  `generators/brainrot-ads`. Code ads render only on a local Mac with Chrome and WebGL, not on
  Vercel.
- **Code-ad volumes are hypothetical.** Anthropic gives plan limits only as multiples of Pro, so I
  cannot confirm how many code-ad stories fit in a month of Max or Ultra.

## Higgsfield's prices

Plans ([higgsfield.ai/blog/higgsfield-pricing-explained](https://higgsfield.ai/blog/higgsfield-pricing-explained),
"Prices verified October 2026", modified 2026-10-24):

| Plan | Per month | Credits a month | Per credit |
| - | - | - | - |
| Starter | $15 | 200 | $0.075 |
| Plus | $49 | 1,000 | $0.049 |
| Ultra | $129 | 3,000 | $0.043 |
| Team | $79 a seat | 1,000 a seat | $0.079 |
| Scale | $215 a seat | 2,500 a seat | $0.086 |

- Unused credits don't roll over.
- Marketing Studio is billed in credits, and Unlimited doesn't cover it
  ([higgsfield.ai/blog/best-ai-ugc-video-tools-agencies-2026](https://higgsfield.ai/blog/best-ai-ugc-video-tools-agencies-2026)).
- A failed generation is usually refunded. A finished generation you discard is still charged.

Products, priced at each plan's credit rate:

| Higgsfield product | Credits | Starter | Plus | Ultra | Source |
| - | - | - | - | - | - |
| Marketing Studio UGC ad, 10 s, 720p | 70 | $5.25 | $3.43 | $3.01 | pricing-explained |
| Marketing Studio UGC ad, 10 s, 1080p | 160 | $12.00 | $7.84 | $6.88 | pricing-explained |
| UGC template video | 84–105 | $6.30–7.88 | $4.12–5.15 | $3.61–4.52 | best-ai-ugc-video-tools-agencies-2026 |
| Kling 3.0, 10 s, 1080p (audio not stated) | 25 | $1.88 | $1.23 | $1.08 | [ai-video-credits-explained](https://higgsfield.ai/blog/ai-video-credits-explained) (2026-08-03) |
| Veo 3 with audio, 8 s, 720p | about 58 | $4.35 | $2.84 | $2.49 | pricing-explained |

Monthly caps: Ultra's 3,000 credits make 18 UGC ads at 1080p (3,000 / 160) or 42 at 720p
(3,000 / 70). Plus makes 6 at 1080p or 14 at 720p.

## Nomen's measured costs

| Item | Cost | Source |
| - | - | - |
| Research per campaign (Monid) | $0.07 for 30–33 sources, about 90 short videos and up to 16 ads; README range $0.06–0.35 | `samples/monid-v2/REVIEW.md`, `samples/monid-v3/REVIEW.md`, README |
| Agents per campaign (Naive): product analyst, breakdowns, director, writers, critics | about $1–2 | `docs/creative-engine.md` |
| Presenter render: Kling 3.0 on Monid, 1080p with audio | $0.168 a second ($1.68 per 10 s) | `src/lib/views.ts`, README |
| Default campaign's renders: 4 videos × 2 shots × 8 s, each shot rendered 1 s long | (64 + 8) × $0.168 = **$12.10** | `estimateUsd` in `src/lib/views.ts` |
| A first frame (image) | $0.016–0.032 | `samples/brainrot/REVIEW.md` (`generators/brainrot-ads`) |
| A vision check | about $0.04 | same |
| Faceless video (voice-over demo, text story, filmed screen) | cents | `docs/creative-engine.md` |
| Brainrot ad, finished, 21–37 s | $2.03–3.27 | `samples/brainrot/REVIEW.md` (`generators/brainrot-ads`) |
| Code ad, 15–30 s | about $0.10 for the story, $0.04 for narration, a few cents for the frame check; rendering free | `docs/code-ads.md` (`generators/code-ads`) |
| Static ad pack: 4 concepts × 14 sizes | $0.56, about 4 minutes end to end | `docs/static-ads.md` |
| A post through Naive Social | $0.013 ($0.0325 with X) | README |

### A finished 16-second presenter ad

This is the default campaign: 4 videos of two 8 s shots each. The math is per video, first takes.

| Part | Math | Cost |
| - | - | - |
| Presenter renders | (16 s + 2 s Kling renders past the lines) × $0.168 | $3.02 |
| Research, shared by 4 videos | $0.07 / 4 | $0.02 |
| Agents, shared by 4 videos | $1–2 / 4 | $0.25–0.50 |
| Two first frames | 2 × $0.016–0.032 | $0.03–0.06 |
| Two quality checks | 2 × $0.04 | $0.08 |
| **Total** | | **$3.40–3.69** |

Higgsfield, the same 16 s at 1080p through Marketing Studio: 16 s × 16 credits a second = 256
credits, which is **$11.01 on Ultra** or $12.54 on Plus. Made as two 10 s generations it is 320
credits, $13.76 on Ultra. 11.01 / 3.69 = 2.98 and 11.01 / 3.40 = 3.24, so **about 3x**.

### What $129 buys

$129 is one month of Higgsfield Ultra.

| | Higgsfield Ultra | Nomen |
| - | - | - |
| 1080p presenter footage | 187 s through Marketing Studio (3,000 / 16 credits a second) | 767 s of Kling renders (129 / 0.168) |
| Finished 16 s presenter ads, first takes | 11 (3,000 / 256) | 34–37 (129 / 3.69 to 129 / 3.40) |

The same $129 on Nomen's other formats:

- 39–63 brainrot ads (129 / 3.27 to 129 / 2.03)
- 230 static packs, 12,880 finished sizes (129 / 0.56 = 230, × 56)
- research for 368–1,843 campaigns (129 / 0.35 to 129 / 0.07)

## Code ads on a subscription

This section assumes the following:

- The story, the critic and the frame check run on a flat Claude plan instead of per-token calls.
- The render runs on a Mac we already own. Machine time and electricity are not counted.
- Narration is ElevenLabs through Monid, about $0.04 per take as measured. The free macOS voice
  costs $0.

**Cost per ad = plan price / ads per month + $0.04.**

Plans ([claude.com/pricing](https://claude.com/pricing), checked 2026-11-08):

- Max: $100 a month, 5x Pro's usage.
- Ultra: $200 a month, 10x Pro's weekly usage, and no 5-hour limit for verified accounts.

| Code ads a month | On Max ($100) | On Ultra ($200) |
| - | - | - |
| 30 | $3.37 | $6.71 |
| 100 | $1.04 | $2.04 |
| 300 | $0.37 | $0.71 |
| 1,000 | $0.14 | $0.24 |

The same 25 s on Higgsfield, at Ultra rates:

- **Marketing Studio UGC ad at 1080p:** 25 s × 16 credits = 400 credits, **$17.20**. At 100 ads a
  month on Max, a code ad costs 16.5x less; at 300 a month, 46x less.
- **Raw Kling 3.0 clips at 1080p:** 25 s × 2.5 credits = 62.5 credits, **$2.69**. These are clips
  only, with no script, voice or edit. At 100 ads a month on Max, a code ad costs 2.6x less. At 30
  a month the plan's share ($3.37) costs more than these raw clips.

Use these alongside the table:

- **If we already pay for the plan** for other work, one more code ad costs only its narration:
  about $0.04.
- **If we buy the plan only for code ads,** it beats the measured API price only at volume. The
  API price is about $0.10–0.30 per story, so Max is cheaper only above 333–1,000 ads a month
  (100 / 0.30 to 100 / 0.10). Below that, per-token calls cost less per ad.
- **Capacity:** one M-series Mac renders a 25 s ad in 6–8 minutes. That is 7–10 an hour, or
  180–240 a day running nonstop, so rendering doesn't cap these volumes. The plan's usage limit
  might, and that limit isn't published as a number.
- **API credits:** claude.com/pricing also lists $100 a month of API credits on Max and $200 on
  Ultra. Their footnote's terms weren't readable, so they are not counted here.

## Against human creators

2026 marketplace guides put a human UGC video at:

- a median of about $175 ([Influee](https://influee.co/blog/ugc-price)), and $150–300 at entry
  level;
- 30–50% more for paid-ad usage rights
  ([Novoads](https://novoads.ai/blog/how-much-do-ugc-creators-charge)).

Nomen's own creator mode offers a $150 flat fee (`creator_fee_usd` in `src/lib/settings.ts`).

| Against $175 | Nomen | Ratio |
| - | - | - |
| 16 s presenter ad | $3.40–3.69 | 47–51x |
| Code ad, Max at 100 a month | $1.04 | 168x |

## Re-renders

Every comparison here uses first takes. Both sides pay for retakes:

- **Nomen:** QC re-renders a failed shot up to twice (`qc_max_retries`, default 2). In the worst
  case, where every shot is rendered three times, the 16 s ad costs about $9.73. Past runs lost
  money to bugs before they were fixed: about half of the $25.92 and $27.55 videos in
  `samples/monid-v2` and `samples/monid-v3`.
- **Higgsfield:** a finished generation is charged even if you throw it away. Its blog doesn't
  give a typical number of tries, and its API pricing post assumes two generations per usable clip
  ([ai-video-api-pricing-vs-subscriptions](https://higgsfield.ai/blog/ai-video-api-pricing-vs-subscriptions)).

## Updating these numbers

- Our unit prices live in `src/lib/views.ts` (`KLING_USD_PER_SECOND`, `VEO_USD_PER_SECOND`) and in
  the Costs sections of the README, `docs/creative-engine.md` and `docs/static-ads.md`.
- Re-check Higgsfield's blog and claude.com/pricing before a pitch. Third-party guides list
  different Higgsfield plans and prices, so its prices may have changed recently. The arithmetic is
  plain multiplication, so a new credit price or plan price drops straight into the tables.
