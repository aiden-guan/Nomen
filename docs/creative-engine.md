# The creative engine

Nomen remakes short videos that already went viral, adapted to the brand's product. It does not
write ads from scratch. A video that got 40x more views than its account has followers proves its
hook, structure and pacing work. Nomen finds those videos, breaks them down second by second, and
rebuilds them with the brand's product, its real screenshots and an AI presenter.

## The flow

```
website
  └─ research (Monid) ─ planner ─ ~25 searches (videos and ads) ─ scout ─ up to 5 follow-up searches
       └─ references ─ product analyst ─ site screenshots ─ reach and conversion ranking ─ 6 beat-by-beat breakdowns (reach and convert mix)
            └─ director (Naive agent nomen-director) ─ one brief per video: which video it remakes, its role (reach or convert) and metric
                 └─ script room ─ writer ─ linter ─ critic (x2) ─ per video, in parallel
                      └─ production ─ presenter shots (Kling 3.0) + QC ─ product cutaways ─ voice-over ─ edit
                           └─ review ─ posting (Naive Social) ─ analytics feed the next campaign
```

Every agent writes one typed document for the next (`src/lib/creative/types.ts`):
`ProductBrief`, `ReferenceCandidate`, `ReferenceBreakdown`, `CreativeBrief`, `Script`,
`ProductionPlan` and `EditTimeline`. Nothing downstream has to guess what an upstream agent meant.

## Agents and what they do

| Agent | Where | Reads | Writes |
| - | - | - | - |
| Research planner | `research.ts`, Claude Haiku on Naive | site, brand profile | 5 kinds of search phrases, 3 conversion searches, competitors, benchmarks for reach and for conversion |
| Scout | `creative/scout.ts`, Claude Haiku | first-wave stats, captions, hashtags | up to 5 follow-up searches (phase D) |
| Product analyst | `creative/product.ts`, Claude Sonnet with vision | site text and images | `ProductBrief`: facts, allowed claims, which images show the product |
| Site capture | `creative/capture.ts`, Naive cloud browser | the brand's site | phone-size screenshots (software and services) |
| Ranking | `creative/references.ts`, code | ~90 videos and up to 10 ads | `ReferenceCandidate`s with a reach score (views per follower, engagement) and a conversion score (ad run length and variants, saves per like, selling cues), each a reach or convert role; see `docs/research-steering.md` |
| Breakdown analyst | `creative/references.ts`, Naive speech-to-text and Claude Sonnet with vision | the video, its transcript, cuts and frames | `ReferenceBreakdown`: every beat with timing, exact lines, on-screen text, shots, hook mechanic, how it sells (problem, proof, offer, CTA), fit |
| Director | Naive agent `nomen-director` (`naive/agents/director.md`) | product brief, breakdowns, research | brand brief, search plan, one `CreativeBrief` per video, with a role and metric (at least one of each with 2+ videos) |
| Writer | `creative/script.ts`, Claude Sonnet | brief, reference, product | `Script`: the reference remade beat by beat |
| Linter | `creative/script.ts`, code | script, reference, product | problems: ad phrases, invented numbers, personal claims, drift from the reference |
| Critic | `creative/script.ts`, Claude Sonnet | all of the above | score; a full rewrite until 8/10 (two rounds) |
| Shot planner | `creative/plan.ts`, code | script | presenter shots (4/6/8 s), product cutaways, voice-over |
| QC | `qc.ts`, Claude Sonnet with vision | frames of each render | pass or a fixed prompt for a re-render |
| Edit | `creative/edit.ts`, ffmpeg | timeline | the finished 1080x1920 video |

## The rules of a remake

**What it keeps from the reference:**
- the hook, word for word where it can
- the beats, one for one, with the same timing
- the wording, sentence by sentence
- the shots, the on-screen text and the delivery
- the kind of presenter and setting

**What it changes:** only what must change to be about this product. An AI presenter of the same
kind replaces the original person.

**What never carries over:**
- The reference's claims about itself. Its personal results, prices, reviews and "I've used it
  for months" become true facts from the product brief that play the same role.
- Numbers not on the brand's site.
- The reference's handle, face, voice, footage and music.

These videos are posted by the brand on its own accounts and labeled AI-generated.

## The edit

- **Captions:** Poppins ExtraBold, white with a heavy outline, popping in two or three words at a
  time, at about 64% of the height.
- **Hook text:** in a dark rounded box in the top fifth.
- **Product cutaways:** real screenshots and photos cover the presenter while their voice keeps
  going.
  - Smooth zoom, pan and scroll motion, using ffmpeg's `perspective` filter.
  - A wide image is shown whole over a blurred copy of itself.
- **Split screen:** presenter on top, product below.
- **Filmed screen:** the look of a phone filming a computer monitor (`creative/plate.ts`).
  - One photo per video, from the image model: a monitor on a desk, its display solid green.
  - Code finds the display's corners in the green and checks it is one whole, flat screen. A
    photo that fails gets up to two retries; after that, the screens fill the frame instead.
  - Each beat's 1440x900 desktop screen is warped into the display, the green is keyed out, and
    the photo goes back on top so its bezel covers the edges.
  - The whole picture drifts and turns slightly, like a hand-held phone.
- **The finish** (`finish`, on by default; "off" to compare): under the captions, a touch of
  contrast, a little less saturation, light sharpening and fine moving grain, encoded at crf 21
  with an 8 Mb/s ceiling; on the sound, a high-pass, low-pass, gentle compression and a hint of
  room, pink room tone at about -50 dBFS, and loudness at -14 LUFS.

## The presenter

Presenter shots render on Kling 3.0 image-to-video on Monid with its own voice
(`presenter_engine`: `kling-3.0`, the default; `naive` uses the Naive video model in
`video_model`). It won a head-to-head against Veo 3.1, HeyGen, Seedance and Wan for realism and
lip-sync. What made it look real is the prompt recipe in `plan.ts`:

- **The first frame** names the camera propped up at eye level an arm's length away, chest-up,
  mouth slightly open mid-sentence, a lived-in real place, natural daylight, skin texture and grain.
  A later shot's frame is shot 1's still re-posed: an image edit that names only the new pose.
- **The video prompt** says only what happens (the frame carries the face): a real creator
  talking into the camera with the line's emotion arc (from the script's per-beat `emotion` tags),
  one gentle action, hands below the frame, no pointing, then the line, then "No subtitles, no
  on-screen text."
- Each take renders about a second longer than its line; the edit trims it to the speech.

## Formats

| Format | On screen | Sound | Render cost |
| - | - | - | - |
| `talking_head_broll` | the presenter, cut away to the product | the presenter (Kling 3.0's own voice) | about $0.17 per second |
| `split_screen` | the presenter on top, the product below | the presenter | about $0.17 per second |
| `voiceover_demo` | the product only | text-to-speech | cents |
| `filmed_screen` | a phone filming a monitor that shows the product | text-to-speech | cents, plus one to three photos |
| `text_story` | the product only, with large text | text-to-speech | cents |

## Costs

- **Research:** about $0.10–0.40 on Monid.
- **Agents:** about $1–2 on Naive for the analysts, director, writers and critics.
- **Video:** about $0.17 per presenter second on Kling 3.0 (1080p with audio; $0.40 on Veo 3.1),
  plus QC re-renders (`qc_max_retries`). Faceless formats cost cents.

## Where its work is kept

Rows go through the store (SQLite locally, Convex on Vercel; docs/convex.md). The reference study
lives in the campaign's `style_json` (`CreativeState` in src/lib/pipeline.ts: the product brief,
the screened candidates, the shortlist being broken down, the breakdowns), so the UI shows each
step as it lands. Files that must outlive a tick (captured screenshots, renders, frames, screens,
the voice-over, the cut) are kept in `store().files` by key; downloads and the edit's intermediates
use a scratch folder for one tick. The Troy camp shows the references live in the Oracle
(`campaign.references` in src/lib/views.ts) and which reference each video remakes.

## What is not done yet

- **Untested against the live API:** whether speech-to-text returns timestamps for every model,
  site redirects to other domains, and non-English references.
- **Missing:**
  - recurring campaigns on a schedule;
  - word-level caption timing (captions are spread over each line by length);
  - full-page scrolling screenshots (the browser API takes one screen at a time).
- **Never:** a real person on camera. Presenters are AI-generated.
