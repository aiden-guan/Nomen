# The code-ad engine (browser side)

Served to headless Chrome by `src/lib/codeads/render.ts` (`/engine/…`, three.js from `node_modules/three` as
`/three/…`, the ad's own folder as `/ad/…`). Not bundled by Next.js and not type-checked (plain ES modules).

Vendored from ED Studio (`/Users/dylan/Documents/GitHub/EDStudio`, commit 6122035, Dylan's project, PolyForm
Noncommercial 1.0.0): `core.js` and `build/` (anim, captions, cuts, fx, rail, toon) as they are, except the font paths
in `build/captions.js`. `props.js` (`makeAgent`, from `makeRoomba` in `engine/build/factory.js`) and
`sets/devoffice.js` (from `engine/sets/office.js`) are adapted. `codead.js`, `screen.js`, `index.html` and `main.js`
are Nomen's.

Fonts: Fredoka (SIL Open Font License 1.1) and Luckiest Guy (Apache License 2.0), from `@fontsource`.

Every frame is a pure function of t: no `Math.random`, no `Date` in this folder (use `rng(seed)` from `core.js`).
