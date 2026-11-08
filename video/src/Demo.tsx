import { loadFont } from "@remotion/fonts";
import { AbsoluteFill, Audio, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import film from "../public/plate.json";
import { type Caption, CAPTIONS, type Place } from "./captions";

// The edited demo video: the filmed walk-through (scripts/film-demo.cjs), a caption for each part
// of it placed where it covers nothing, the demo videos' own sound while they play, and an end card.

const fonts = Promise.all([
  loadFont({ family: "Geist", url: staticFile("fonts/geist-latin-500-normal.woff"), weight: "500" }),
  loadFont({ family: "Geist", url: staticFile("fonts/geist-latin-600-normal.woff"), weight: "600" }),
  loadFont({ family: "Geist", url: staticFile("fonts/geist-latin-700-normal.woff"), weight: "700" }),
  loadFont({ family: "Geist Mono", url: staticFile("fonts/geist-mono-latin-500-normal.woff"), weight: "500" }),
  loadFont({ family: "Inter", url: staticFile("fonts/inter-latin-400-normal.woff"), weight: "400" }),
  loadFont({ family: "Inter", url: staticFile("fonts/inter-latin-500-normal.woff"), weight: "500" }),
]);
void fonts;

const INK = "#2b1d14";
const PAPER = "#fbf6ea";
const CRIMSON = "#b73a31";

type Log = { fps: number; frames: number; enter: number; steps: Array<{ key: string; frame: number }>; videos: Array<{ src: string; frame: number }> };
const log = film as Log;

/** Seconds the end card holds at the close. */
const END_SECONDS = 2.6;

/** Each caption's frames: from just after its step opens to just before the next one does (or the end card). */
function windows() {
  const last = log.frames - Math.round(END_SECONDS * log.fps);
  const starts = [{ key: "landing", frame: 0 }, ...log.steps];
  return starts
    .map((s, i) => {
      const caption = CAPTIONS.find((c) => c.key === s.key);
      const end = Math.min(i + 1 < starts.length ? starts[i + 1].frame : log.frames, last + 6);
      return caption ? { caption, from: s.frame + (s.key === "landing" ? 6 : 10), to: end - 4 } : null;
    })
    .filter((w): w is { caption: Caption; from: number; to: number } => w !== null && w.to > w.from + 20);
}

export const durationOf = () => log.frames;

export function Demo() {
  const { fps } = useVideoConfig();
  const video = log.videos.filter((v) => /\/demo\/[^/]+\/\d+\.mp4$/.test(v.src));
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <OffthreadVideo src={staticFile("plate.mp4")} muted />
      {windows().map(({ caption, from, to }) => (
        <Sequence key={caption.key} from={from} durationInFrames={to - from} layout="none">
          <CaptionCard caption={caption} length={to - from} />
        </Sequence>
      ))}
      {video.map((v, i) => {
        // Its sound from the moment it is on screen until the next step opens.
        const next = log.steps.find((s) => s.frame > v.frame + 5)?.frame ?? log.frames;
        const length = Math.max(1, next - v.frame);
        const file = v.src.split("/").pop()!;
        return (
          <Sequence key={`${file}-${i}`} from={v.frame} durationInFrames={length} layout="none">
            <Audio
              src={staticFile(`sound/${file}`)}
              volume={(f) => interpolate(f, [0, 6, length - 8, length], [0, 0.9, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
            />
          </Sequence>
        );
      })}
      <Sequence from={log.frames - Math.round(END_SECONDS * fps)} layout="none">
        <EndCard />
      </Sequence>
    </AbsoluteFill>
  );
}

// Where a caption sits (1920 x 1080), and how wide it may be there so it stays clear of the action:
// left of an open panel (it starts at x 1335), clear of the battle's scoreboard, beside a video.
const PLACE: Record<Place, { style: React.CSSProperties; width: number }> = {
  "bottom-left": { style: { left: 56, bottom: 56 }, width: 700 },
  "top-left": { style: { left: 56, top: 132 }, width: 640 },
  "top-right": { style: { right: 56, top: 132 }, width: 620 },
  right: { style: { right: 40, top: "50%" }, width: 440 },
};

function CaptionCard({ caption, length }: { caption: Caption; length: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 140, mass: 0.7 } });
  const exit = interpolate(frame, [length - 9, length], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const shift = (1 - enter) * 22 + (1 - exit) * 10;
  const { style: placed, width } = PLACE[caption.place];
  const middle = caption.place === "right";
  return (
    <div
      style={{
        position: "absolute",
        ...placed,
        transform: `translateY(${middle ? "-50%" : "0px"}) translateY(${shift}px)`,
        opacity: Math.min(enter, exit),
        maxWidth: width,
        background: PAPER,
        border: `4px solid ${INK}`,
        boxShadow: `0 6px 0 rgba(43,29,20,0.18)`,
        padding: "18px 26px 20px",
      }}
    >
      <div style={{ fontFamily: "Geist Mono", fontWeight: 500, fontSize: 20, letterSpacing: 1.5, textTransform: "uppercase", color: CRIMSON }}>{caption.kicker}</div>
      <div style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 40, lineHeight: 1.12, color: INK, marginTop: 6 }}>{caption.title}</div>
      {caption.body && <div style={{ fontFamily: "Inter", fontWeight: 400, fontSize: 25, lineHeight: 1.35, color: "#5a4636", marginTop: 8 }}>{caption.body}</div>}
    </div>
  );
}

function EndCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const rise = spring({ frame: frame - 6, fps, config: { damping: 16, stiffness: 120 } });
  return (
    <AbsoluteFill style={{ background: `rgba(251,246,234,${0.92 * fade})`, alignItems: "center", justifyContent: "center" }}>
      <div style={{ opacity: rise, transform: `translateY(${(1 - rise) * 24}px)`, textAlign: "center" }}>
        <div style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 96, color: INK, letterSpacing: -1 }}>Nomen</div>
        <div style={{ fontFamily: "Inter", fontWeight: 500, fontSize: 34, color: "#5a4636", marginTop: 10 }}>UGC ad campaigns, run by agents.</div>
      </div>
    </AbsoluteFill>
  );
}
