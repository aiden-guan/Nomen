# Code ads

A code ad is a 15-30 second vertical ad made entirely in code: a Three.js scene that headless Chrome renders frame by
frame, a synthesized score and foley, a narrator, and ffmpeg. No camera, no AI video. It is ED Studio's build genre
(Dylan's other project: one gliding camera take, one spoken word at a time, yellow term callouts), cut to ad length and
pointed at a product, with a cartoon software developer in the lead instead of ED Studio's Gary the Builder. The creative
director picks it like any other format (`code_ad`).

```
CreativeBrief (format "code_ad")
  └─ story.ts: the writer turns the brief, the product brief and a viral reference (any niche) into beats
       └─ critic: scores it, rewrites it once under 8/10; code checks keep it renderable and true
            └─ job.ts (a production tick starts it in the background, like a remake)
                 ├─ narrate.ts: one ElevenLabs clip per beat (Adam, on Monid) or the free macOS scratch voice, word times
                 ├─ layout.ts: story.json for the page (words, callouts, each beat's gag and screen on the clock)
                 ├─ cues.ts + synth.py: music, foley and the narrator mixed to -14 LUFS
                 ├─ render.ts: headless Chrome + WebGL, 60 fps with 2-sample motion blur, piped into ffmpeg
                 └─ frame sheet → vision QC (Naive) → crv_…/final.mp4, poster.jpg, frames.jpg in the store's files
```

The finished video then goes through review and posting like every other video: it is uploaded to Naive for posting,
carries a QC score and is not internal (it copies no one's footage).

## The story

The model writes `CodeAdStory` (`src/lib/codeads/types.ts`), stored on the concept as `script.code_ad`. Each beat is
one narrated line, one gag landing on one word, one picture on the office's wall screen and 1-2 callouts:

| Gag | On screen | For |
| - | - | - |
| `hack` | the developer types; the wall screen types the beat's terminal or chat | setups |
| `explode` | the laptop blows up; the developer is charred for a moment | a crash, a bad deploy |
| `bury` | labelled boxes drop on the developer; dizzy stars | too much work, too many tools |
| `zap` | the power strip: x-ray flicker, sparks | an integration that bites |
| `money` | banknotes pour out of the screen | costs, a surprise bill |
| `deliver` | the brand's crate drops and bursts; its agent robot hops out | the product's entrance |
| `team` | more robots pop in, one per role, and roam | several agents, scale |
| `approve` | a big button pops up; the developer slams it | approvals, budgets, guardrails |
| `show` | the camera pushes in on a real product screenshot | "this is what it looks like" |
| `celebrate` | confetti, the developer throws his arms up | the payoff |

Wall screens: `terminal`, `chat`, `image` (a real product visual by id), `logo`, `error`, `dashboard`.
Callouts: `term` (yellow, the feature's real name), `label`, `money`, `stamp`, `sfx`.

**The cast.** The lead is a software developer, two looks that rotate between videos (the writer picks one, else the
job alternates): `geek`, a heavyset dev in a hoodie with round glasses, headphones round his neck and a short beard,
and `mogger`, a sharp dev in a white tee with a quiff, a watch and shades pushed up on his head. ED Studio's Gary the
Builder (a hard hat) made no sense at a laptop (Dylan, after the first sample).

**The tone.** Product-first, like a sharp dev-tool launch video: the product is named early and every beat after the
problem shows one real thing it does. At most one light, dry wink per ad; no slapstick lines, roasts, yelling or absurd
props (the first sample's "yacht and a llama" read as cringe). The narrator is Adam's crisp read
(eleven_multilingual_v2 at speed 1.12, about 3 words a second, sped up at most 1.3x); ED Studio's dramatic eleven_v3
read with audio tags is still there (`NOMEN_CODEAD_NARRATOR=v3`). Ads aim at 18-24 seconds in 6-8 beats of 5-12 words.

**The frame.** The wall screen holds the top third, the developer's face sits at about 40 %, the one spoken word at 52 % (on his
chin, as in ED Studio's face shots) and the callouts in the lower third over the desk (ED Studio stacks them above the
faces; here that is where the screen is). A beat whose screen carries the point is framed to show the whole screen;
each framing holds until its gag has landed. The frame check found these rules: in the first Naïve render the
callouts covered the screen and close framings cropped it (QC 5/10).

**Pace.** Adam on eleven_v3 reads about 2.1 words a second; the narration is sped up (pitch kept) by at most 1.3x to
fit the target, so the writer budgets 2.75 words a second: about 75 words for 27 seconds.

**The concept comes from a viral reference in any niche.** The writer gets the reference's breakdown (hook, beats, why
it works) and keeps its premise, hook mechanic and escalation, never its words: an "AI given one instruction: make money"
video becomes "You give an AI agent your credit card and one instruction: make money", then the product is the fix.
ED Studio's own build reels are built the same way on @wemakebuild's "How a ___ Becomes a ___" engineering videos.

The formula (ED Studio `docs/BUILD.md`, cut down and calmed down): a hook spoken on frame 1, one problem beat, "So you
use <product>" and its entrance, one feature per beat named by a term callout, a payoff with one step and the url.
Claims and numbers come from the product brief only; the linter flags any number that is not in it.

## What was ported from ED Studio (`/Users/dylan/Documents/GitHub/EDStudio` at 6122035)

Vendored into `src/lib/codeads/engine/` (browser modules, served to headless Chrome) and `src/lib/codeads/`:

- `engine/core.js`: the renderer (bloom, grade, grain, tone mapping), deterministic timeline helpers, seeded random.
- `engine/build/`: `toon.js` (the toon rig and its faces; Nomen added glasses, builds, hair, a hoodie, headphones), `fx.js` (analytic particles: sparks, smoke, dust, confetti,
  banknotes), `anim.js` (pop, drop, squash, wobble), `rail.js` (one gliding camera take: `planRail`), `cuts.js`
  (`makeKick`, the frame-relative impact shake), `captions.js` (one word at a time + callouts; font paths changed).
- `engine/fonts/`: Fredoka 600/700 (OFL) and Luckiest Guy (Apache 2.0), from `@fontsource`.
- `engine/props.js`: `makeAgent` is ED Studio's `makeRoomba` (video 026) in the brand's colours with a role sign.
- `engine/sets/devoffice.js`: adapted from `sets/office.js` (video 012): a dollhouse dev office with a wall screen.
- `synth.py`: `audio/synth.py` whole (numpy + scipy), plus an `--out` option.
- Ported to TypeScript: `tools/narrate.py`'s word timing and layout (`narrate.ts`, `layout.ts`), `tools/render.mjs`
  (`render.ts`, on the DevTools pipe instead of puppeteer), the 024 `make_cues.py` "WORKSHOP" score (`cues.ts`).
- New: `engine/codead.js` compiles the beats into a scene (gags, camera framings, kicks, FX, the wall screen),
  `engine/screen.js` draws the wall screen, `story.ts` writes and checks the story, `job.ts` runs it.

Left out: ED Studio's other 40 sets and most props, the 5-subagent review loop, TRIBE scoring, cuts (Dylan rejected
them for the build genre), ElevenLabs' character timestamps (Monid's text-to-speech returns audio only, so words are
timed from the audio like ED Studio's scratch voice), the operation and posting tools. ED Studio is PolyForm
Noncommercial; it is Dylan's code and he asked for this port, so the license is his call.

## Running it

It renders where the worker runs locally: it needs Google Chrome (WebGL on the GPU), ffmpeg and `python3` with numpy and
scipy. **It cannot render on Vercel** (no Chrome with WebGL, no Python): there the creative fails at once with
"run the worker locally to make them". A 25 s ad takes about 6-8 minutes at 60 fps on an M-series Mac.

- Voice: ElevenLabs Adam through Monid when a Monid key is set (cents), else the free macOS `say` voice.
  `NOMEN_CODEAD_VOICE=scratch` forces the free one. `NOMEN_PYTHON` picks the Python.
- Cost: the writer and critic (Claude Sonnet on Naive, ~$0.10-0.30), the narrator (~$0.05-0.20), one vision check
  (cents). Rendering is free.

The sample for Naïve, end to end (reads the main checkout's data read-only, writes into this checkout's `data/`):

```bash
NOMEN_DATA_DIR=/Users/dylan/Documents/GitHub/nomen/data NOMEN_CODEAD_LIVE=all npx vitest run tests/codead.live.test.ts
```

`story` writes the story only, `make` makes the ad from the saved story, `page` prepares the ad's folder without
rendering, `stills` renders stills of an ad folder.

**The first sample (Nov 7).** Reference: mplentg's "I Let AI Run My Side Hustle" (644K views, 1,770 followers, 364x;
an AI given one instruction, "make money"). The writer and critic (8/10) wrote: "You give an AI agent your credit card
and one instruction: make money. / It buys a yacht and a LLAMA. Your card quits. / So you use Naïve. Agents get a
company to run, not your wallet. / Pick a company template, like video or store. Deploy it. / Multi-agent teams split
the goal and work in parallel. / Human approvals: spending waits for your yes. The llama is DENIED. / Now your card
builds a company. Pick a company template at usenaive.ai." 27.1 s at 1080x1920, 60 fps, -14.1 LUFS; frame QC 8/10
(two earlier renders scored 5 and 6, and their notes became the layout rules above). Paid: about $0.04 of narration
per take, about $0.10 per story and a few cents per frame check.
See the file's header for the options. Output: `data/codead-live/<brand>-<tag>/final.mp4`, `frames.jpg`, `made.json`.
