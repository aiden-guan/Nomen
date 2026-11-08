# Brainrot ads

Deliberately terrible, so-cringe-it's-funny AI meme ads. People watch AI slop because it is bad.
These lean into that on purpose, and the product is the punchline: its real facts are in the
words, and its real site is on the end card.

The code is in `src/lib/creative/brainrot*.ts`. The format is `brainrot`. The director can pick it
for a reach video, and a live test makes samples without a campaign.

## The bits

Each bit copies the format of a video that was pulling tens of millions of views when it was
picked (Monid's TikTok keyword search on 7 Nov 2026, 16 searches, $0.02). It never copies the
original's characters, people or footage.

| Bit | What it is | Built on |
| - | - | - |
| `anthem` | An "Italian brainrot" song. Absurd hybrid creatures with sing-song pseudo-Italian names, each introduced by one rhyming line (one pun on a real feature each). The lines are read by an Italian-accented voice over a dumb beat, with karaoke lyrics and one coloured word per line. | [@br.ai.nrot, "Tralalero Tralala - The Italian Brainrot Song 2"](https://www.tiktok.com/@br.ai.nrot/video/7495815620152364310): 44.4M views, 291x its followers, 1.5M shares |
| `melodrama` | An AI food-character soap opera. A sad hero whose pain is the product's problem, a rich rival, tears in the rain ("it's over"), then the product and a hard music turn to phonk ("we're so back"). One huge word on screen at a time. | [@mommyyame1, "p: 1 #fruitdrama"](https://www.tiktok.com/@mommyyame1/video/7649489303176809741): 81.1M views, 345x its followers |
| `aura` | An aura-farming / mogging phonk edit. Our character does nothing, nonchalantly, in slow motion, while the product does the work behind it. Stamps like "+1000 AURA" and "MOGGED", and bass-boosted drops. | [@yboatkid, "best aura farmer so far"](https://www.tiktok.com/@yboatkid/video/7521629317063822648): 98.9M views, 1,113x its followers (the format only; never the original kid or his boat race) |

| `funnel` | An agent-experiment POV, the meme-ad format a competitor (Composio) pays creators for. The mascot reacts to camera in the bottom half while a funnel of what the agent did fills the top half, one row per beat ("2,900+ tools it looked at", "0 sign-ups"). Each row gets an indignant comment, the product comes in mid-way, and it ends on "what should my agent do next?" | [@phamhacks, "people be so greedy smh"](https://www.tiktok.com/@phamhacks/video/7678518337311116557): 2.28M views, 447x its followers. It is in the Monid campaign's own competitor research. |

**Riffing on the research.** A bit can riff on one video from the campaign's own research. In a
campaign, that is the reference the director picked for the brainrot brief; in the live test, it is
a link from the campaign's `research_json`, transcribed once on Naive. The writer gets that video's
numbers, caption and words, keeps its structure, and remakes it in the bit's style with the
product's facts. The video then credits the riffed video as its reference (`inspired_by`), so the
camp shows the research behind it.

Every bit opens on an outrageous stunt as bait, then cuts hard into the bit: a cart drifting
through a fireball, a jet ski off a ramp, a car through glass into a rooftop pool. It never opens
on anything that reads as suicide, self-harm or a fall to death; the critic sends those back.

## How one is made

1. **The writer** (`writeBrainrot`, Sonnet on Naive) writes the bit from the product brief and the
   recipe. The **linter** checks the result, and one **critic** round rewrites it if it is too
   polite, too ad-like or breaks a rule. The script is a `BrainrotScript`: characters, shots
   (frame, motion, words, stamp, sound effects, picture effects), music, the end line and card.
2. **The voice** is one ElevenLabs line per shot, read through Monid for cents, so every shot is as
   long as what is said over it. Each bit has its own voice and tempo (the anthem's
   Italian-accented voice plays 1.3x faster). When Monid's wallet refuses, Naive's own models
   take over the voice (OpenAI's voices, no accent), the music and the sound effects.
3. **The pictures:** each recurring character is drawn once, then every shot's still is drawn from
   those references on Naive's image model, with no text in any picture.
4. **The clips** are a Naive video model per still (Veo 3.1 Lite by default, measured at $0.08 a
   second). The first clip renders alone, and its real price feeds the cost guard before anything
   else is paid for. A clip up to 1.35x shorter than its shot plays slowed down.
5. **The music** (ElevenLabs Music, instrumental) and the **sound effects** (ElevenLabs sound
   generation) come through Monid. The effects are kept once for every video under
   `brainrot/sfx/`. The 6-7 chant is a shouted voice line. An effect that can't be made gets an
   ffmpeg stand-in.
6. **QC:** a vision check of two frames per clip fails only rule breaks and broken renders (a real
   person, someone else's character, drawn text, a human main character), and a failed clip is
   rendered once more with the check's fix. Then a check of the cut scores it and says whether
   it is safe; an unsafe cut fails the video.
7. **The cut** (`brainrot-cut.ts`, ffmpeg): hard cuts, the hook on top, karaoke lyrics or one word
   at a time, stamps slammed in at an angle, zoom punches, shake, deep fry, flash frames, an RGB
   glitch and a fisheye bulge. The voice plays over the beat ducked under it, with sound effects
   on cue and bass-boosted, clipped drops. The end card is the mascot with the site slammed on it
   in giant letters and its line under it. A screenshot of the product's page made a flat ending,
   and monid.ai's failed the final check for the other companies' logos on it.

Everything paid for is kept by key with a manifest (`crv_…/brainrot/manifest.json`), so a restart
resumes without paying twice. The cut is `crv_…/final.mp4`.

## Rules that never bend

- **People:** no real people. No celebrities, streamers, politicians, athletes or founders, and not
  their names, faces or voices either. Every character is non-human: animals, food, objects,
  robots. Image models draw "a robot" as a human-shaped mannequin, so every character prompt says
  it is not one.
- **Characters and brands:** no one else's characters (Skibidi Toilet, Tung Tung Tung Sahur,
  Tralalero Tralala and the rest of the Italian-brainrot cast, cartoon, game and anime characters)
  and no other brands.
- **Topics:** nothing sexual, no jokes about abuse or trafficking, nothing about minors, no slurs
  or hate, no drugs, weapons or gore.
- **Facts:** every product fact comes from the brief. Meme numbers ("6-7", "+1000 AURA") and 0 or 1
  are the only numbers that don't need to.
- **Other companies:** briefs and references name them (Monid's aha compares two AI labs, and the
  funnel reference is Composio's sponsored meme). They are never named in the ad: the linter flags
  them.
- **6-7:** one bit, once or twice at most. It is never the whole joke.

The linter checks the names, topics and numbers in the script, and both vision checks look for
them in the frames.

## Posting

Brainrot videos are held like remakes: the concept is `internal`, and publishing refuses it
("brainrot ad: not cleared for posting") until a person clears it with `clearForPosting`.

## Settings

| Setting | Default | |
| - | - | - |
| `brainrot_video_model` | `google/veo-3.1-lite` | the Naive video model for the clips |
| `brainrot_video_usd_per_second` | `0.15` | its assumed price until a clip measures it (Veo 3.1 Lite measured $0.08) |
| `brainrot_max_usd` | `4` | the cost guard's cap per video |

## Samples

`tests/brainrot.live.test.ts` makes one per sponsor (paid, opt-in; see the file's header). It
reads the campaigns' product briefs read-only from `data/nomen.db` and writes to
`data/media/brainrot-live/`. The reviewed samples are in `samples/brainrot/`.
