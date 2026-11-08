# Research steering: reach and return

Dylan's brief: in UGC, likes are not the goal. A video with 2 million likes can sell $10K while one
with 100K likes sells far more. The research agents should look for the highest return for the
customer, use reach as one good sign among others, and plan campaigns the way performance teams
do: some videos to get eyes on the product, others to convert.

Until now Nomen ranked references almost only on reach: views per follower, engagement and raw
views. This doc covers what public signals predict conversion, what Monid can actually give us,
and the steering built on that.

## What predicts conversion

Short findings, best sources first. Most of the industry evidence is vendor analysis, so treat the
thresholds as rules of thumb.

1. **An ad that keeps running is the best public proxy for one that pays.** Ad libraries hide
   spend and results, but advertisers stop paying for ads that lose money. Practitioners shortlist
   ads running 30+ days (some use 14+ days with several live variants, or 60+), and read "N ads
   use this creative" as a sign the advertiser scaled it. The caveat is real: a small business can
   run a tiny budget forever, so longevity shortlists and does not prove. Sources:
   [Moda's critique of the longevity signal](https://moda.app/blog/meta-ad-library),
   [Flighted](https://www.flighted.co/blog/how-to-research-competitor-meta-ads-before-you-launch-a-campaign),
   [Ryze](https://get-ryze.ai/blog/meta-ads-library).
2. **TikTok Creative Center's Top Ads are the only public ads with performance data.** They are
   advertiser-authorised top performers, filterable by region, industry and campaign objective
   (conversions, app installs, leads, product sales), with CTR, 2 s and 6 s view rates and CVR as
   percentile ranks. ([TikTok help: Top Ads](https://ads.tiktok.com/help/article/top-ads?lang=en))
3. **Direct-response structures win more often than others.** Motion's 2026 benchmark (578,750
   creatives, 6,015 Meta ad accounts, $1.29B spend, Sept 2025 to Jan 2026) puts Offer-First,
   Demo, Testimonial, Unboxing, Before & After, Listicle, Split Screen and Us vs Them among the
   formats with the highest hit rates (about 5-10% of creatives become winners; 4% for small
   accounts, 8.8% for the largest). Humour shows up in 25% of ads spending over $1M.
   ([Motion: hit rates](https://motionapp.com/library/research/creative-benchmarks-2026/hit-rate-context))
4. **Native creator content converts better than repurposed ads.** In TikTok's A/B test for
   Swisscom, native creator content had a 22.7% higher conversion rate and 19% lower cost per
   conversion than ads made for other platforms. TikTok's own Spark Ads tests report higher
   completion (+134%) and, for CREA Jewelry, a 44% better conversion rate.
   ([Swisscom](https://www.casestudies.com/company/tiktok-for-business/case-study/swisscom-customer-case-study),
   [CREA Jewelry](https://ads.tiktok.com/business/en/inspiration/crea-jewelry))
5. **The hook carries the product.** Over 63% of TikTok's highest-CTR videos show the key message
   or product in the first 3 seconds (correlational).
   ([TikTok for Business](https://ads.tiktok.com/business/en-US/blog/9-creative-tips-to-drive-auction-ad-performance))
6. **Teams run both jobs at once.** Binet and Field's study of 996 IPA campaigns found the best
   long-run results near 60% brand building and 40% sales activation on average; the split moves
   by category and B2B leans toward activation.
   ([summary](https://www.alexmurrell.co.uk/summaries/les-binet-and-peter-field-the-long-and-the-short-of-it))
   On Meta, Andromeda made creative diversity the main lever: distinct concepts (persona, angle,
   offer) rather than cosmetic variants; 3-5 genuinely different concepts suffice for a small
   account. ([Jon Loomer](https://www.jonloomer.com/meta-andromeda/))
7. **Hook rate and hold rate** (3 s views / impressions; ThruPlays / 3 s views) are the metrics
   teams judge their own ads on, with cold-traffic hook rates around 25-30%. They need the ad
   account's data: no library publishes them. They belong in measurement, below, not in research.
   ([Motion](https://motionapp.com/blog/key-creative-performance-metrics))
8. **Saves and buying-intent comments** ("link?", "where can I buy", "price?") are widely used as
   intent signals, but I found no study tying save rate to purchases. Nomen uses saves per like as
   a heuristic, judged against the niche (below), and leaves comment text as a follow-up.
   ([Creatorflow on intent comments](https://creatorflow.so/blog/instagram-sales-signals-high-intent-comments/))

## What Monid gives us

Checked in the live monid.ai research packs (`data/nomen.db`, read-only) and Monid's free catalog
(`/v1/discover`, `/v1/inspect`, 2026-11-07). No paid endpoint was run.

| Source | What it returns | Use |
| - | - | - |
| TikTok search | views, likes, comments, shares, saves, author followers, posted date, length, paid partnership | reach score, saves and comments per like, caption cues |
| Instagram Reels search | views, likes, comments, length, paid partnership; no saves, shares or followers | reach; comments per like |
| YouTube Shorts search | views and title only | reach |
| Meta ads (`/facebook.ads_search`, `/facebook.company_ads`) | start and end date, active, `adCount` (ads using this creative), button text, link, video file, page likes; no impressions or spend | longevity, variants, button, the ad's video |
| TikTok ad library (`/tiktok.ad_library_search`) | first and last shown, audience band, video file. **EU and UK only**; the US is not served and the default region is DE | longevity |
| TikTok Creative Center (tikhub `/api/v1/tiktok/ads/search_ads`) | top ads filtered by objective (3 = conversions) and period, with likes, comments, shares and landing page | ads bought for conversions |
| `/tiktok.ad_library_ad` | one top ad's CTR, cost level and objective | follow-up |
| `/tiktok.video_comments`, `/instagram.post_comments` | comment text ($0.0006 a call) | follow-up: buying-intent comments |

What the live runs showed:

- **Ad keyword searches return junk.** The Meta search for the competitor "RapidAPI" returned 27
  ads from truck dealers and WhatsApp lead-gen pages that say "rapid"; the brand search "Monid"
  returned a wheel shop. Fix: company searches for the brand and competitors, and an on-topic
  filter for keyword searches.
- **Every TikTok ad was dropped.** The reader looked for `advertiser` and `title`; TikTok's library
  says `brandName` and `adTitle`. Those that came through were Dutch and Chinese, because the
  library defaults to Germany.
- **Saves per like depends on the niche.** Across 208 TikTok results in the AI-agent niche the
  median is 0.33 (p10 0.06, p90 1.1); in Olipop's soda niche it is about 0.03. So it is judged
  against the pool's own median.
- The highest saves-per-like videos were the ones that sell: "Comment READY and I'll send the
  setup", "Full guide on my IG", "link in bio". The comment-keyword ask (comment a word, get a DM)
  is the dominant conversion mechanic in this niche.

## The design

### Every candidate gets a reach score and a conversion score

The reach score is the old ranking (`score.total`: views per follower, engagement, views, length).
Next to it, `score.conversion` (0-10), `score.role` and `score.signals`, from `conversionOf` in
`src/lib/creative/references.ts`:

| Component | Points | Signal |
| - | - | - |
| intent | 0-3 | saves per like against the pool's median: 1.5 + 0.75 x log2(ratio), so 1.5 at the median, 3 at 4x |
| questions | 0-1 | comments per like against the pool's median: 0.5 x log2(ratio) |
| ask | 1 | caption asks or offers: link in bio, a code, % off, free trial, "comment AGENT", #tiktokmademebuyit |
| review | 1 | caption is a review or comparison: review, "I tried", vs, worth it, before and after |
| paid | 1.5 | paid partnership or #ad |
| ad | 1 | a video from an ad library, plus: |
| longevity | 0-4 | days run: 0 at a week, 2.3 at 30 days, 4 at 90+ |
| variants | 0-2 | ads reusing the creative: 1 at two, 2 at four or more |
| button | 1 | the button asks for an action (shop, sign up, install), not "learn more" |
| top ad | 2 | a Creative Center top ad bought for conversions |

The pool median needs 8 measured videos; until then the defaults are 0.1 saves and 0.015 comments
per like. **Role:** every ad is `convert`; an organic video is `convert` at 3.5 or more, which takes
saves far above the niche plus a selling cue, or exceptional saves and comments together. High
saves alone mark a useful video, not a selling one. Every component is listed in `score.signals`
("ran 94 days, still running", "saves per like 3.8x the pool's", `caption asks: "Comment READY"`),
so the screen, the breakdown and the director see why.

### Research looks for conversion evidence (`src/lib/research.ts`)

- The planner writes 3 `conversion_queries` (a review or "I tried", a comparison with a competitor,
  a demo or testimonial phrase), searched on TikTok (`tiktok_conv_*`) and the first on Reels.
- Benchmarks carry a role: at least one known for reach (Cluely, Duolingo, MrBeast) and one known
  for UGC that converts (Cal AI for apps, Ridge or Dr. Squatch for physical products).
- Ads: Meta company searches for the brand and three competitors, a Meta keyword search for the
  category, TikTok's library in GB for the category and two competitors, and Creative Center top
  ads bought for conversions in the US. About 9 more runs per campaign; the ad endpoints cost about
  $0.001 a call.
- `adsFrom` reads run length, variants, button, link and the ad's video file. Keyword results that
  do not name the brand, a competitor or the category are dropped. Ads are sorted competitors
  first, longest-running first, and up to 10 with a video join `pack.videos` as paid candidates
  with `video.ad` set (views 0 means unknown).
- The scout sees saves per like, leaves ads out, and must spend at least one follow-up on videos
  that sell.

### Picking is a mix (`references.ts`, `relevance.ts`)

- `scoreCandidates` puts every ad in the `ad` lane and judges the pool against its own median.
- The relevance screen reads the top of the reach ranking plus up to 8 seats for the best
  converters below the cut, which is how ads (no views) get seen at all. Only downloadable videos.
- `pickForBreakdown` reserves 2 convert and 2 reach references out of 6 (1 and 1 from n = 2),
  converters ordered by evidence, then one from each lane not yet represented.

**One-to-one remakes** (direction change during this work): a remake now rebuilds the reference's
own footage, layout, graphics, captions and timing. So:

- only references with a `media_url` are screened or picked;
- length costs: every second past 45 s takes 0.1 points off the reach score and off a converter's
  evidence when picking (75 s: -3), on top of the old penalty past 75 s;
- the breakdown's `fit` and the relevance screen favour layouts that rebuild cleanly (one
  presenter to camera, green screen, screen recording, graphics on a plain background) over
  footage that needs real-world shots.

### The breakdown records how a video sells

`ReferenceBreakdown.anatomy`: `role`, `structure` (problem_solution, demo, testimonial, review,
before_after, us_vs_them, listicle, founder_story, objection_handling, tutorial, skit, reaction,
trend, story, other) and the quoted `problem`, `proof`, `offer`, `cta` and `objection`. The
breakdown's `role` is `convert` for ads, for candidates whose evidence says convert, and for videos
the model reads as built to sell that actually ask for the click; otherwise `reach`. It also keeps
`origin` and the candidate's `conversion` score and signals.

### The director plans a funnel mix (`strategy.ts`, `naive/agents/director.md`)

- Every brief has `role` (reach or convert) and `metric` (views, shares or saves; link_clicks,
  sign_ups or purchases). Both are required by the schema.
- With 2+ videos, at least one of each. `balanceRoles` is the backstop: if every brief has the same
  role, the one whose CTA fits the missing role best switches.
- The director sees each reference's role, conversion evidence and selling beats; an ad's views
  read "unknown (paid ad)". Convert briefs remake converters and keep their selling beats; reach
  briefs remake reach proof with a soft ask. References should rebuild cleanly and run 45 s or
  less when the evidence is close.
- `director.md` changes reach Naive only after `npm run naive:plan` and an approved apply. The
  per-campaign message and the schema carry the same rules now.

### The script room keeps the selling beats (`script.ts`)

Convert scripts keep the reference's problem, proof, objection, offer and CTA in order, with the
product's real facts, and end on the brief's CTA (added to the last beat if the reference never
asks). Reach scripts keep the ending and stay soft. The linter fails a convert script with no beat
that asks; the critic scores `does_its_job`.

## Measuring conversions for real (follow-up, not built)

Research can only guess which videos sell. To learn it:

1. **A tracked link per video**: a unique short link or UTM (`utm_content=<creative id>`) in the
   bio or link-in-bio page, a per-video promo code, or an attributed deep link for apps.
2. **Collect** link clicks from the shortener and sign-ups or purchases by `utm_content` from the
   brand's analytics (or a Nomen pixel or webhook), plus platform stats (views, shares, saves,
   profile visits, hook and hold rate where the platform gives them).
3. **Judge each video on its own metric** (`brief.metric`) and its cost per result, and feed that
   into `pastResults` with the role.
4. **Calibrate** the conversion weights against what actually converted; read buying-intent
   comments with `/tiktok.video_comments` to replace the comments-per-like proxy; pull
   `/tiktok.ad_library_ad` for a top ad's CTR and cost level.

## Needs a live run to confirm

- `/facebook.company_ads` matches names exactly and case-sensitively: some competitor names will
  find nothing ("Zapier MCP").
- TikTok's library serves `region: "GB"` (documented as an example region).
- The tikhub Creative Center search's real response shape (the reader follows the provider's
  documented example), whether it returns video files, and whether keyword + objective returns
  anything for a niche query.
- Whether Meta and TikTok library video links download for the breakdown.
- The 3.5 convert threshold and the defaults in other niches, and whether the director and writers
  keep the mix and the selling beats.
