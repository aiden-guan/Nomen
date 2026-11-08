# Static ads

Nomen turns a brand's research into ready-to-upload static ad packs for Google Ads (Search, Display
and Performance Max), Meta (Facebook and Instagram), X and Reddit. A pack is a ZIP with one folder
per platform: every image at the exact size the platform recommends, the copy in the columns each
upload or import screen asks for, and a README that explains how to upload it and what research it
came from.

Static ads are the dependable output: they need no video model, cost a few dollars, and every
letter on them is set in real type, so nothing comes out garbled.

```
campaign research ─► static research fan-out (Monid) ─► ad study (vision) ─► copy (fact-checked) ─► renders (every size) ─► check ─► pack
```

## How to make a pack

- **With a campaign.** When a campaign's research finishes, a static pack starts by itself
  (Settings: `static_ads_auto`, on by default). Open the brand's **Static ads** tab.
- **Static ads only.** Tick *Static ads only* on the home page, or press **Static ads only** on a
  brand page. The campaign researches the brand, skips video, and makes the pack.
- **From existing research.** On any campaign whose research is done, **Make static ads** (or
  **New set**) starts a pack from that research. A new set for the same campaign reuses the static
  research already collected, so it costs only the study, copy and checks.

In the tab you can approve ads, change a headline or subhead (the ad is re-rendered on the same
picture, no model calls), or **Make again** with a note. **Download pack** zips the approved ads,
or every ready ad if none is approved.

## The research fan-out

The art direction is not a house style: it comes from what the research finds. After the
campaign research, a small planning call (Claude Haiku) names the brand's direct competitors and
the best-known companies in its category (for a developer tool: the leading developer and AI
companies), their X handles and domains, the ad-library searches, the search keywords and the
case-study searches. Then these Monid runs go out in parallel (phase `S`, listed with the rest of
the campaign's sources on the Research tab):

| Source | Monid endpoint | What it gives | Price on Monid (Nov 2026) |
| --- | --- | --- | --- |
| Meta ad library: the category's image ads, 2 searches | `anyapi /facebook.ads_search` (`mediaType: IMAGE`, `sortBy: impressions`) | image, text, headline, button, start date, versions | $0.0012 per call |
| Meta ad library: each competitor's and leader's image ads | same, exact phrase | the same, kept as that company's when the page name matches | $0.0012 per call |
| X: the brand's own, competitors' and leaders' posts | `anyapi /twitter.user_tweets` | image posts with views, likes, reposts, bookmarks | $0.0001 + $0.0001 per post |
| Google Ads Transparency Center | `anyapi /google_ads.company_ads` (`format: image`) | competitors' display ads with first and last shown dates | $0.00085 per call |
| Google search ads on the category's keywords | `litescrape /google/ads` | the paid search ads competitors run | $0.00015 per call |
| LinkedIn ad library (B2B brands) | `anyapi /linkedin.ads_search` | headlines, text, buttons, impressions where published | $0.0012 per call |
| Agency case studies | `parallel /search` (basic mode) | ranked pages with excerpts | about $0.005 |
| The brand's own site | `context.dev /web/screenshot` | a 1920×1080 screenshot, cookie banner dismissed | about $0.002 per credit |

**How ads are ranked.** Ad libraries do not publish results for commercial ads, so Nomen ranks by
the signals they do publish and says so wherever it shows them: Meta's own impression ranking,
days running and number of versions (an advertiser keeps paying for ads that work, and duplicates
the ones it scales); on X, views and engagement (likes, reposts, bookmarks and quotes over views);
in Google's Transparency Center, how long an ad has been shown and whether it still runs.

## The ad study

A vision model (`static_model`, Claude Opus 5.5 by default) looks at the brand's own homepage and
the eleven best-ranked ads with pictures, chosen so that no advertiser fills more than three places
and every role and source is seen. It returns, as a strict schema:

- **art direction**: the ground (`white`, `cream`, `black`, the brand color, a pale tint of it or a
  near-black from its hue), a second ground for variety, the type style, the decoration level
  (`none`: flat, hairlines, no shadows or stickers; `subtle`; `bold`), whether winning ads draw a
  button in the image, what carries the images (product UI, photography, type or data), and the
  layouts to use, best first;
- what each studied ad does and why its signals suggest it works;
- *What wins here* and *Rules for new statics*, which the copywriter reads.

The writer and the renderer follow the art direction field by field. For software and AI brands
the research usually lands where the best tech advertisers on X are: neutral grounds, real product
UI, restrained type, one accent color, no stickers or stock people.

## The layouts

Every layout is drawn for square, 4:5, 9:16 and landscape (1.91:1 and 4:3) at any pixel size, with
`next/og` (Satori and Resvg, bundled with Next.js), so there is no browser to install. Headlines are
measured from the fonts' own glyph widths, broken into balanced lines and sized to fill their box.
A phrase the copy marks with `*asterisks*` is drawn in the brand color.

| Layout | For | Picture |
| --- | --- | --- |
| `editorial` | one sentence, set well, with room around it | none |
| `product_ui` | the brand's real website in a browser window | site screenshot |
| `code` | a command from the brand's own docs in a terminal | none |
| `chat` | a question a customer would ask and what the product does | none |
| `stat` | one number from the site, set huge | none or a photo |
| `comparison` | the usual way against the brand (never a named competitor) | none |
| `benefits` | three benefits with check marks | a photo |
| `quote` | a quote copied word for word from the site | none or a photo |
| `hero` | product photo above, headline panel below | a photo |
| `statement` | a bold claim with the product as a supporting picture | a photo |
| `offer` | an offer the site states, in a badge | a photo |
| `native` | a real-feeling photo with one caption box, for feeds like Reddit | a photo |

Pictures come from what is real first: the site screenshot for software, the brand's own photos
for physical products. A generated photo (`static_image_model`, Nano Banana Pro by default) is used
only for a physical product when no site photo fits, never for software, screens or faces, and the
pack says which ads use one. Settings: `static_ai_images` turns generation off.

Fonts are bundled (`assets/fonts`, all SIL Open Font License): Geist, Geist Mono, Newsreader,
Inter, Bricolage Grotesque, Anton, Playfair Display, DM Sans and Nunito.

## The copy, and what it is checked for

Two calls go out in parallel: the concepts (on-image copy and the copy for Meta, X and Reddit) and
the Google text assets. Then every line is checked (`src/lib/statics/validate.ts`):

- **Facts.** Every number must appear in the brand's own site text. Quotes, offers and terminal
  commands must appear word for word. A concept that fails goes back to the writer once with the
  problems; what still fails is downgraded (a stat with an unsupported number becomes a plain
  headline) or dropped, never shipped.
- **Generic phrasing.** Words that make copy read as machine-written ("unlock", "supercharge",
  "seamless", "elevate", …) are rejected unless the brand's own site uses them.
- **Platform rules.** Character limits; for Google no exclamation marks, emoji, repeated
  punctuation, words in capitals the brand does not write that way, or phone numbers; for X no
  hashtags (not allowed in promoted posts since June 2025). Lines are dropped, never cut.

## What a pack holds

| Folder | Images | Copy |
| --- | --- | --- |
| `meta/` | 4:5 at 1440×1800, 1:1 at 1440×1440, 9:16 at 1440×2560 (top 14%, bottom 35% and 6% each side kept free of text, per Meta) | `ads.csv` in Ads Manager's import column names |
| `x/` | 1:1 at 1200×1200, 1.91:1 at 1200×628, under 3 MB | `posts.csv`: post text and website card headline |
| `reddit/` | 4:5 at 1080×1350, 4:3 at 1440×1080, 1:1 at 1080×1080, under 3 MB, with less text on the image | `ads.csv`: headline and button |
| `google-search/` | | `responsive-search-ad.csv` in Google Ads Editor's import columns (imports paused), sitelinks, callouts, structured snippet |
| `google-display-pmax/` | `images/`: 1.91:1, 1:1 and 4:5 with no text (Google's display guidance asks for no text or logos over images and no fake buttons); `designed-for-pmax/`: the designed versions without a drawn button; `logos/`: 1:1 and 4:1 | `text-assets.csv` with character counts |

The sizes and limits, each with its source, are in `src/lib/statics/specs.ts`. They were checked
against the platforms' own help pages on 2026-11-08. Where two official pages disagree, the stricter
value is used: X's website card is capped at 3 MB (its API docs) rather than 5 MB (its ads page).

Known gaps, stated in the pack's README where they apply:

- Google Ads Editor's help page lists the responsive search ad columns but no `Ad type` value; the
  file uses the documented columns.
- Sitelinks point at the homepage; set each one to the page it describes.
- Meta's bulk import also needs your Page, campaign and ad set columns.
- Some of X's ad specs come from its API docs because its business pages block automated reading.

## Costs

Measured on 2026-11-08 with a static-ads-only campaign for monid.ai (4 concepts, 14 sizes each),
from Monid's run list and Naive's credit ledger:

| Item | Cost |
| --- | --- |
| Campaign research on Monid (17 runs) | $0.051 |
| Static research on Monid (23 runs) | $0.032 |
| Planning, ad study, copy and four image checks on Naive (9 model calls, Claude Haiku 5.5 and Opus 5.5) | $0.479 |
| Generated pictures | none in this run; when a concept needs one, the cost Naive reports is added to the pack |
| **Total** | **about $0.56**, about four minutes end to end |

The tab shows each pack's Monid cost exactly and estimates the model cost from token counts at
Anthropic's list prices (Naive bills its own rate; its ledger is the record).

Model calls stream through Naive's proxy: a long call made as a plain request was cut off upstream
after about 30 seconds and still billed for what it had generated. The steps that call models
retry at most twice for that reason.

## Code

- `src/lib/statics/research.ts`: the planning call, the fan-out specs and the compaction with signals.
- `src/lib/statics/study.ts`: the vision study and the art direction.
- `src/lib/statics/writer.ts` and `validate.ts`: the copywriter and the checks.
- `src/lib/statics/layouts.tsx`, `fonts.ts`, `color.ts`, `render.ts`: the layouts, text measurement,
  palettes and rendering.
- `src/lib/statics/pipeline.ts`: the state machine (tables `static_packs` and `static_ads`).
- `src/lib/statics/pack.ts` and `src/lib/zip.ts`: the download.
- `src/components/StaticAdsView.tsx`: the tab.

Tests: `npx vitest run tests/statics` (layouts at every size, copy checks, research compaction, and
a pack built end to end offline). `NOMEN_PREVIEW_DIR=/tmp/previews npx vitest run
tests/statics/layouts.test.ts` writes every layout at every size for a look; add
`NOMEN_PREVIEW_ASSETS` (a folder with `visual.png`, `logo.png` and an optional `brand.json`) to use a
real brand. The live run is `tests/statics/live.test.ts` (it spends money; see the file).
