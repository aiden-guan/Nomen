# The creative engine

Nomen remakes short videos that already went viral, adapted to the brand's product. It does not
write ads from scratch. A video that got 40x more views than its account has followers proves its
hook, structure and pacing work. Nomen finds those videos, breaks them down second by second, and
rebuilds them with the brand's product, its real screenshots and an AI presenter.

## The flow

```
website
  └─ research (Monid) ─ planner ─ ~15 searches ─ scout ─ up to 5 follow-up searches
       └─ references ─ product analyst ─ site screenshots ─ outlier ranking ─ 6 beat-by-beat breakdowns
            └─ director (Naive agent nomen-director) ─ one brief per video: which viral video it remakes
                 └─ script room ─ writer ─ linter ─ critic (x2) ─ per video, in parallel
                      └─ production ─ presenter shots (Veo) + QC ─ product cutaways ─ voice-over ─ edit
                           └─ review ─ posting (Naive Social) ─ analytics feed the next campaign
```

Every agent writes one typed document for the next (`src/lib/creative/types.ts`):
`ProductBrief`, `ReferenceCandidate`, `ReferenceBreakdown`, `CreativeBrief`, `Script`,
`ProductionPlan` and `EditTimeline`. Nothing downstream has to guess what an upstream agent meant.

## Agents and what they do

| Agent | Where | Reads | Writes |
| - | - | - | - |
| Research planner | `research.ts`, Claude Haiku on Naive | site, brand profile | 5 kinds of search phrases, competitors |
| Scout | `creative/scout.ts`, Claude Haiku | first-wave stats, captions, hashtags | up to 5 follow-up searches (phase D) |
| Product analyst | `creative/product.ts`, Claude Sonnet with vision | site text and images | `ProductBrief`: facts, allowed claims, which images show the product |
| Site capture | `creative/capture.ts`, Naive cloud browser | the brand's site | phone-size screenshots (software and services) |
| Ranking | `creative/references.ts`, code | ~90 videos | `ReferenceCandidate`s ranked by views per follower and engagement |
| Breakdown analyst | `creative/references.ts`, Naive speech-to-text and Claude Sonnet with vision | the video, its transcript, cuts and frames | `ReferenceBreakdown`: every beat with timing, exact lines, on-screen text, shots, hook mechanic, fit |
| Director | Naive agent `nomen-director` (`naive/agents/director.md`) | product brief, breakdowns, research | brand brief, search plan, one `CreativeBrief` per video |
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

## Formats

| Format | On screen | Sound | Render cost |
| - | - | - | - |
| `talking_head_broll` | the presenter, cut away to the product | the presenter (Veo native audio) | about $0.40 per second |
| `split_screen` | the presenter on top, the product below | the presenter | about $0.40 per second |
| `voiceover_demo` | the product only | text-to-speech | cents |
| `text_story` | the product only, with large text | text-to-speech | cents |
| `remake` | the reference itself, rebuilt one to one: our presenter, our graphics, its layout | the presenter (Veo native audio) | about $0.40 per second of the reference, internal only |

## One-to-one remakes (`remake`)

`src/lib/creative/remake.ts` rebuilds the reference from its own frames. Video models cannot
re-voice existing footage with lip-sync, so every shot is re-rendered from a clean frame of it.

1. **Layout:** a vision pass over sampled frames. It reads a full frame or a centre band with a
   blurred fill, the presenter's box, framing and motion per beat, every overlaid graphic (kind,
   box, time window, entrance) and the caption look.
2. **Shots:** each beat is split at the reference's cuts and at 8 s. A shot's clean first frame is
   the reference frame with our persona in place of the person and every overlay removed (an
   image edit), checked by the first-frame gate against the reference.
3. **Renders:** Veo animates each clean frame with the reference's motion, and the presenter says
   our line. Lines are budgeted per beat at the reference's words per minute.
4. **Graphics:** the screen builder makes each one at its exact box size, as the same kind of
   element, about our product.
5. **The cut:** shots in the band, graphics at their boxes, the blurred fill, and captions in the
   reference's case, slant, size and height.

Remakes are marked `internal`, and publishing refuses them unless a person clears them
(`clearForPosting`). `tests/remake.live.test.ts` runs a paid remake of the first 15 s of the
Cluely reference for monid.ai.

## Costs

- **Research:** about $0.10–0.40 on Monid.
- **Agents:** about $1–2 on Naive for the analysts, director, writers and critics.
- **Video:** about $0.40 per presenter second, plus QC re-renders (`qc_max_retries`). Faceless
  formats cost cents.

## What is not done yet

- **Untested against the live API:** whether speech-to-text returns timestamps for every model,
  site redirects to other domains, and non-English references.
- **Missing:**
  - recurring campaigns on a schedule;
  - word-level caption timing (captions are spread over each line by length);
  - full-page scrolling screenshots (the browser API takes one screen at a time).
- **Never:** a real person on camera. Presenters are AI-generated.
