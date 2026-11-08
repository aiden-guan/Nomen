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
| Ranking | `creative/references.ts`, `creative/cloneability.ts`, code | ~90 videos and up to 10 ads | `ReferenceCandidate`s with a reach score (views per follower, engagement), a conversion score (ad run length and variants, saves per like, selling cues) and a cloneability guess (caption cues, length), each a reach or convert role; hard-to-clone ones are picked last; see `docs/research-steering.md` |
| Breakdown analyst | `creative/references.ts`, Naive speech-to-text and Claude Sonnet with vision | the video, its transcript, cuts and frames | `ReferenceBreakdown`: every beat with timing, exact lines, on-screen text, shots, hook mechanic, how it sells (problem, proof, offer, CTA), what the footage is made of and its cloneability, fit |
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
| `remake` | the reference itself, one to one: our people, our graphics, its layout, cuts and music | our people (Kling 3.0's own voice) over the reference's music | about $0.17 per second of the reference plus about $0.30, internal only |

## One-to-one remakes (`remake`)

A remake is the reference video one to one: the same footage, framing, cuts, timing, motion,
set, music and effects, graphic places and caption style. Only the people (lookalike personas:
the same type, clearly someone else), the voice and the product content change, and the script
keeps the reference's words except the product facts. Remakes are internal: they are marked
`internal`, the camp shows an "internal" badge, and publishing refuses them unless a person clears
them (`clearForPosting` in publish.ts).

`src/lib/creative/remake.ts` runs it; a production tick starts it in the background
(`remake-job.ts`) and it resumes from its manifest after a restart.

1. **Layout** (vision, up to 12 frames): band over a blurred fill or full frame; the main person
   per beat; the **segments** and their kind; every graphic (kind, box, window, entrance); every
   text overlay (words line by line, box, colour, size); the caption look (case, words at a time,
   height, size).
2. **Segments and their strategies** (`clone.ts`). Segment edges snap to the reference's cuts.
   - `talking_head`: the host re-performs it.
   - `stitch` (another creator's clip with the host as a cut-out): the brand's co-host (a second
     persona, made once per brand) re-performs the clip, with the host's cut-out blanked; the host's
     cut-out is re-performed on green, listening, and keyed back in at the reference's box.
   - `screen_walkthrough` (a phone filming a monitor, the host green-screened over it): the
     reference's footage is kept and our product's desktop screens are warped into its display,
     following the display's corners read per sampled frame (the host's old cut-out is blurred
     dark); when the corners don't hold up, the filmed_screen plate with hand-held motion. The
     host's cut-out is re-performed on green and keyed in.
   - `broll`: kept. `graphic`: the screen builder makes ours at the stage's size.
   - A segment that can't be cloned cuts to our own product graphic and says so in the notes.
3. **Takes and renders.** Each cloned layer splits into takes at its real cuts: a scene change in
   its own region (a graphic popping in elsewhere is not a cut). Consecutive takes group into
   renders of up to 14 s; each render's first frame is a **twin frame** (the reference frame with
   our person in the same pose, size and place, overlays removed, or on green for a cut-out),
   checked by the first-frame gate, and the reference's cuts inside it become Kling's multi-shot
   list ("Shot 1, 4 s: …").
4. **The cost guard.** Before anything is paid for, an estimate (Kling billed seconds, twin frames,
   personas, plates, audio, graphics, vision); over `remake_max_usd` it stops. Actual spend is kept
   on the creative and in the manifest.
5. **The presenter** (`presenter.ts`, one interface): `kling-native` (default) is Kling 3.0
   image-to-video voicing the line itself, with the head-to-head's recipe; `kling-motion` (Kling
   Motion Control driven by the reference's own footage, silent) and `naive:<model>` are options,
   and an audio-driven model only needs `submit` and `poll`.
6. **Sound** (`dub.ts`). Demucs (`npm run setup:stems`) splits the reference into voice and bed;
   without it, ElevenLabs isolates the voice and there is no bed. Speech-to-text times the
   reference's words. Each render's own voice is the soundtrack for its stretch: its lead-in is
   skipped and a line that runs long is played up to 1.25x (picture with it), so the reference's
   timing holds. `remake_voice_match` passes every render's voice through speech-to-speech into the
   persona's one voice (Kling's timing is kept). Words no render says get our eleven_v4 read.
7. **The cut.** The segments on the stage, cut-outs keyed in, graphics at their boxes, the blurred
   fill, text overlays at their places with our words (the series line kept), word captions timed
   from speech-to-text in the reference's style, the finish, the soundtrack over the ducked bed.
8. **The check.** Our frames against the reference's at the same moments (vision): framing, the
   same people throughout, no original person. Kept as the creative's QC score and continuity.

**The script** keeps the reference's words beat for beat, swaps only the product facts with about
as many syllables, gives every line an emotion tag, and keeps on-screen text's wording and series
numbering; `lintRemake` checks all of it.

**People** (`persona.ts`): kept per brand in the store's files (`brd_…/persona.json` and `.png`, the
co-host as `cohost.*`): a portrait from the director's description, or a prebuilt Naive character
(`persona_character`, chr_…). Each has one ElevenLabs voice (Lena or Brielle, Matt or Arthur, by
gender, age and vibe).

**Live tests:** `tests/remake.live.test.ts` (opt-in, paid): the Cluely hook (0-9 s) for monid.ai and
hustle.jordan99's "Part 67" (the first ~12 s) for usenaive.ai. See the file's header for the
commands, the plan-only mode and the options.

### Faceless remakes

A reference with nobody on camera is the dependable remake: there is no face to fake, so the
reference's own footage stays and only the product content and the voice change.

- **A filmed screen** (a phone filming a laptop or monitor) is a screen walkthrough, also when the
  layout reader calls it b-roll. With OpenCV set up (`npm run setup:stems` installs it next to
  Demucs), `scripts/track-screen.py` (via `track.ts`) puts our screens into the display frame by
  frame: one vision corner read per shot, snapped onto the display's edges, then optical flow and a
  homography per frame; our screen is matched to how the phone saw the display (black level,
  white point, tint, softness), and the reference's burned-in captions are painted out of the
  footage it keeps. Shots are split at a softer cut list (scene score 0.12), since a filmed screen
  cuts between shots of the same room. Without OpenCV it warps between corner reads, as before.
- **A generic screen stays as it is** (a phone ringing, a call screen): our product goes on a
  filmed screen only where the original's would sell someone else's. `screens: "auto"` asks once
  per remake (cached; unsure means replace), `"keep"` forces it; the kept footage only has its
  burned-in captions painted out.
- **A silent person in the footage** (someone at a desk under a caption, never talking to the
  camera) stays as filmed with `people: "keep"`: nobody is re-performed, and every kept shot of a
  faceless remake has its burned-in words painted out so the redrawn caption is the only one.
- **Redrawn captions** leave out emoji (libass draws them as empty boxes) and squeeze a line our
  font makes too wide for the frame (to 75%, then smaller).
- **Labels a voice reads out** (TikTok's text to speech) show our line in their case; captions stay
  out of a label's window and never run across two lines.
- **A voice-over ad** keeps no captions when the reference has none (`captions.present`), and a
  script with no words at all keeps the reference's whole soundtrack.
- **A square or landscape reference** keeps its shape as a band over a blurred fill.
- **Motion graphics**: a full-stage graphic segment draws the elements the reference lays over it
  itself, at their places and times (no separate cards with edges); every graphic and screen
  designer sees the reference's still at its moment.
- **Voice**: our narrator (an ElevenLabs voice matched to the reference's: gender, pitch,
  delivery) reads every line with its emotion tag, best of three by length, timed onto the
  reference's words.

**Live tests:** `tests/faceless.live.test.ts`: @vqgts for Mobilerun (a filmed laptop with labels),
@ai.with.ni for Monid (a filmed monitor with a voice-over), ElevenLabs' Meta ad for Naive (a
voice-over over motion graphics), @risingpower__ for Mobilerun (a desk phone ringing, its own
display kept) and @marketingwithed_ for Naive (a silent desk shot under one caption: only the
caption changes). See the file's header for the commands.

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
