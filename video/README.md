# The demo video

The edited walk-through of the Naïve demo: the app filmed frame by frame, with captions and the
demo videos' own sound, about 1:42 at 1920 x 1080. It has no voice-over; that goes on top after.

## Make it

1. Film the app (from the repo root, with a production build running):

   ```bash
   npm run build && npm start
   ```

   ```bash
   node scripts/film-demo.cjs video/public/plate.mp4
   ```

   This plays `/demo?record=1`: the tour on autoplay drives the camera, and the tour card, the
   dispatches, the replay controls and the video players' controls stay off screen. The page's
   clock is Playwright's fake one, moved 1/30 s per frame, so the film has no dropped or uneven
   frames. Beside the plate it writes `plate.json`: the frame each tour step starts on and each
   demo video that played. `SITE=monid.ai` films the Monid demo.

2. Copy the demo videos whose sound the edit uses:

   ```bash
   mkdir -p video/public/sound && cp public/demo/usenaive-ai/{1,2,3,4}.mp4 video/public/sound/
   ```

3. Render (in `video/`, after `npm install`):

   ```bash
   npm run render
   ```

   The output is `out/nomen-demo.mp4`. `npm run studio` opens Remotion's editor to preview it.

## What is where

- `src/captions.ts`: each part's caption and where it sits so it covers nothing at that moment.
- `src/Demo.tsx`: the film, the captions (timed from `plate.json`), each demo video's sound while
  it plays on screen, and the end card.
