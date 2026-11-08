# Changelog

## [0.1.0] — 2026-11-08 · Hackathon build

### Summary
The first complete loop, built at the Naïve × YC hackathon: a website goes in, and agents research, study, direct, produce, review, cast, post and plan the next campaign. Two real campaigns (Naïve and Monid) were recorded for the demo replay.

### Highlights
| Area | Change | Outcome |
| :--- | :--- | :--- |
| **Research** | Monid fan-out across short-form search, ad libraries, Reddit and AI answers, ranked by views against followers | Each campaign starts from outlier videos, not guesses |
| **Creative engine** | Reference breakdowns, the `nomen-director` agent on Naïve, a writer/linter/critic script room | Every video names the outlier it was built on |
| **Production** | First-frame checks, shot QC with re-renders, continuity checks, one-pass ffmpeg edit, Kling 3.0 fallback when Naïve runs out of credits | Fewer paid renders thrown away |
| **Hosting** | The core runs on Convex on Vercel and on SQLite locally, behind one store | One codebase for local runs and the hosted demo |
| **Camp** | A pixel-art camp where agents walk between stations, plus a recorded demo with a guided tour | The whole run is visible in two minutes |

### Detailed changes

#### Added
- **Research**: the Monid research plan, a scout for follow-up searches, research steering toward return on investment, and cloneability ranking of references.
- **Creative**: reference breakdowns, the director agent, the script room, generated product screens, brand kits, and the one-to-one remake format (internal, held from posting).
- **Production**: first-frame vision checks, shot QC with corrected re-renders, continuity checks, captions and B-roll in one ffmpeg pass, Kling 3.0 presenter shots, and optional Demucs stems for remakes.
- **Static ads**: research, an ad study, fact-checked copy and rendering at every platform size, downloaded as one ZIP.
- **Review and casting**: approvals and re-renders with a note; creators mode, where a client-taste agent approves a real creator and the outreach DM is drafted and sent from the brand's phone through Mobilerun.
- **Posting and autopilot**: posting through Naïve Social with the AI-generated flag, analytics for 14 days, and an autopilot that starts the next campaign only within a person's weekly budget.
- **Camp and demo**: the Troy landing and camp, station panels, the screening room, the battle for the rival's city, the recorded-campaign replay with a tour, and frame-by-frame filming of the demo (`scripts/film-demo.cjs`, `video/`).
- **Branding**: the Spartan helmet logo across the site, icons and the demo video's end card.

#### Changed
- **Hosting**: the core moved behind `src/lib/store` so it runs on Convex on Vercel, with Convex-driven worker ticks and files kept by key.
- **Research**: rebuilt around proven outlier videos instead of keyword volume.

#### Fixed
- **Providers**: every call that can hit a busy Naïve model waits it out and retries; casting falls back to plain JSON when a tool call fails.
- **Posting**: a live post's link shows as soon as it is out.

#### Documentation and presentation
- **README**: rewritten with the camp walkthrough, the videos the recorded campaigns made, architecture diagrams, engineering notes, setup and honest limits; media in `assets/readme/`.
- **Docs**: notes on the creative engine, research steering, Convex, phones, static ads and the camp in `docs/`.

### Not in this release
- The organic, 3D code-ad, brainrot and faceless-clone generators and phone posting are on `generators/*` branches, not merged.

### Verification
- `npm test`: 57 files, 697 tests passed, 18 skipped (opt-in live tests).
- `next build` passes on `main` at `03d29cf` (tagged `stable-demo-2026-11-08`).
