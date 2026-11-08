import { loadFont } from "@remotion/fonts";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import film from "../public/plate.json";
import { type Caption, CAPTIONS, type Place } from "./captions";
import { OUTREACH } from "./outreach";

// The edited demo video: the filmed walk-through (scripts/film-demo.cjs), a caption for each part
// of it placed where it covers nothing, the demo videos' own sound while they play, the creator
// outreach as a DM thread (drafted, approved, sent from the brand's phone), and an end card.
//
// The film is cut in two places: a little of the wait before the website is typed comes off the
// start, and at the creators step it holds still while the outreach draft types into its thread.

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
const stepAt = (key: string) => log.steps.find((s) => s.key === key)?.frame ?? null;

/** Seconds the end card holds at the close. */
const END_SECONDS = 2.6;
/**
 * Frames off the start (the wait before the website is typed): the edit opens 56 frames (about
 * 1.9 s) before the website is entered, however long it took to type.
 */
const SKIP = Math.max(0, log.enter - 56);
/** Where the film holds still for the outreach thread, and for how long (frames). */
const CREATORS = stepAt("creators");
// Keep in step with prepare.mjs, which cuts this frame as public/freeze.png.
const FREEZE_AT = CREATORS !== null ? CREATORS + 15 : null;
const HOLD = FREEZE_AT !== null ? 105 : 0;
/** The opening card waits until the doors are open and the soldiers come out of the horse. */
const LANDING_FROM = log.enter + 100;

/** A frame of the film, on the edit's timeline. */
const at = (plate: number) => Math.max(0, plate - SKIP + (FREEZE_AT !== null && plate >= FREEZE_AT ? HOLD : 0));

export const durationOf = () => at(log.frames);

/** Each caption's frames on the edit: from just after its step opens to just before the next one does (or the end card). */
function windows() {
  const last = log.frames - Math.round(END_SECONDS * log.fps);
  const starts = [{ key: "landing", frame: LANDING_FROM - 10 }, ...log.steps];
  return starts
    .map((s, i) => {
      const caption = CAPTIONS.find((c) => c.key === s.key);
      const end = Math.min(i + 1 < starts.length ? starts[i + 1].frame : log.frames, last + 6);
      return caption ? { caption, from: at(s.frame + 10), to: at(end - 4) } : null;
    })
    .filter((w): w is { caption: Caption; from: number; to: number } => w !== null && w.to > w.from + 20);
}

export function Demo() {
  const { fps } = useVideoConfig();
  const total = durationOf();
  const video = log.videos.filter((v) => /\/demo\/[^/]+\/\d+\.mp4$/.test(v.src));
  const plate = staticFile("plate.mp4");
  const post = stepAt("post");
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      {FREEZE_AT === null ? (
        <OffthreadVideo src={plate} muted startFrom={SKIP} />
      ) : (
        <>
          <Sequence durationInFrames={FREEZE_AT - SKIP} layout="none">
            <OffthreadVideo src={plate} muted startFrom={SKIP} />
          </Sequence>
          <Sequence from={FREEZE_AT - SKIP} durationInFrames={HOLD} layout="none">
            {/* The film's frame there, as a still (node prepare.mjs cuts it). */}
            <Img src={staticFile("freeze.png")} style={{ width: "100%", height: "100%" }} />
          </Sequence>
          <Sequence from={at(FREEZE_AT)} layout="none">
            <OffthreadVideo src={plate} muted startFrom={FREEZE_AT} />
          </Sequence>
        </>
      )}
      {windows().map(({ caption, from, to }) => (
        <Sequence key={caption.key} from={from} durationInFrames={to - from} layout="none">
          <CaptionCard caption={caption} length={to - from} />
        </Sequence>
      ))}
      {CREATORS !== null && post !== null && (
        <Sequence from={at(CREATORS + 12)} durationInFrames={at(post - 4) - at(CREATORS + 12)} layout="none">
          <DmThread length={at(post - 4) - at(CREATORS + 12)} />
        </Sequence>
      )}
      {video.map((v, i) => {
        // Its sound from the moment it is on screen until the next step opens.
        const next = log.steps.find((s) => s.frame > v.frame + 5)?.frame ?? log.frames;
        const from = at(v.frame);
        const length = Math.max(1, at(next) - from);
        const file = v.src.split("/").pop()!;
        return (
          <Sequence key={`${file}-${i}`} from={from} durationInFrames={length} layout="none">
            <Audio
              src={staticFile(`sound/${file}`)}
              volume={(f) => interpolate(f, [0, 6, length - 8, length], [0, 0.9, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
            />
          </Sequence>
        );
      })}
      <Sequence from={total - Math.round(END_SECONDS * fps)} layout="none">
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

/**
 * The creator outreach as a DM thread on a phone: the casting agent's draft types in, you approve it,
 * and the phone agent sends it from the brand's own account (the phones track's outreach session,
 * src/lib/phones). It ends sent: Nomen sends the first message; it does not carry on a conversation.
 */
function DmThread({ length }: { length: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 17, stiffness: 120, mass: 0.8 } });
  const exit = interpolate(frame, [length - 10, length], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // Drafted (the message types in), approved, sent from the phone.
  const typeFrom = 20;
  const typeTo = typeFrom + Math.round(3.8 * fps);
  const approveAt = typeTo + 10;
  const pressAt = approveAt + 16;
  const sentAt = pressAt + 30;
  const bubble = spring({ frame: frame - 14, fps, config: { damping: 18, stiffness: 160 } });
  const typed = Math.round(interpolate(frame, [typeFrom, typeTo], [0, OUTREACH.message.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const drafting = frame < typeTo;
  const approved = frame >= approveAt;
  const sending = frame >= pressAt && frame < sentAt;
  const sent = frame >= sentAt;
  const press = interpolate(frame, [pressAt, pressAt + 4, pressAt + 9], [1, 0.9, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const approvedPop = spring({ frame: frame - approveAt, fps, config: { damping: 14, stiffness: 180 } });
  const sentPop = spring({ frame: frame - sentAt, fps, config: { damping: 14, stiffness: 180 } });
  const scrim = interpolate(Math.min(enter, exit), [0, 1], [0, 0.32]);
  const dots = ".".repeat(1 + (Math.floor(frame / 6) % 3));
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: `rgba(43,29,20,${scrim})` }} />
      <div
        style={{
          position: "absolute",
          right: 150,
          top: 70,
          width: 560,
          height: 940,
          opacity: Math.min(enter, exit),
          transform: `translateY(${(1 - enter) * 40}px) scale(${0.96 + 0.04 * enter})`,
          background: "#ffffff",
          borderRadius: 44,
          border: "10px solid #111114",
          boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          fontFamily: "Inter",
        }}
      >
        {/* The thread's header: the creator. */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "26px 24px 18px", borderBottom: "1px solid #ececec" }}>
          <span style={{ fontSize: 34, color: "#111", lineHeight: 1, marginTop: -4 }}>‹</span>
          <div style={{ width: 52, height: 52, borderRadius: 26, background: "linear-gradient(135deg,#c9a77c,#7a5a3e)", display: "grid", placeItems: "center", color: "#fff", fontFamily: "Geist", fontWeight: 700, fontSize: 24 }}>M</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 24, color: "#111" }}>@{OUTREACH.handle}</div>
            <div style={{ fontSize: 17, color: "#777", marginTop: 2 }}>
              {OUTREACH.platform} · {OUTREACH.followers.toLocaleString("en-US")} followers
            </div>
          </div>
          <span style={{ fontFamily: "Geist Mono", fontSize: 14, letterSpacing: 1, textTransform: "uppercase", color: "#777", border: "1px solid #ddd", borderRadius: 999, padding: "5px 10px" }}>Direct message</span>
        </div>
        {/* The thread: the brand's first message. */}
        <div style={{ flex: 1, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10, background: "#fafafa" }}>
          <div style={{ alignSelf: "center", fontSize: 15, color: "#999", fontFamily: "Geist Mono", letterSpacing: 1, textTransform: "uppercase" }}>{sent ? "Today" : "Draft"}</div>
          <div style={{ alignSelf: "flex-end", display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 16, color: "#777" }}>{OUTREACH.brand}</span>
            <Img src={staticFile("naive-logo.svg")} style={{ width: 28, height: 28, borderRadius: 7 }} />
          </div>
          <div
            style={{
              alignSelf: "flex-end",
              maxWidth: 452,
              background: INK,
              color: PAPER,
              borderRadius: "22px 22px 6px 22px",
              padding: "16px 18px",
              fontSize: 19.5,
              lineHeight: 1.42,
              opacity: bubble * (sending ? 0.75 : 1),
              transform: `scale(${0.9 + 0.1 * bubble})`,
              transformOrigin: "bottom right",
              minHeight: 40,
            }}
          >
            {OUTREACH.message.slice(0, typed)}
            {drafting && <span style={{ display: "inline-block", width: 2, height: 20, background: PAPER, marginLeft: 2, verticalAlign: "-3px", opacity: Math.round(frame / 8) % 2 }} />}
          </div>
          <div style={{ alignSelf: "flex-end", fontSize: 15, color: sent ? "#2f7a3e" : "#888", textAlign: "right", maxWidth: 452, fontWeight: sent ? 500 : 400 }}>
            {sent ? (
              <span style={{ display: "inline-block", transform: `scale(${0.85 + 0.15 * sentPop})` }}>✓ Sent by the phone agent from {OUTREACH.brand}&apos;s own {OUTREACH.platform}</span>
            ) : sending ? (
              `Sending from the brand's phone${dots}`
            ) : (
              `Written by the outreach agent · client-taste agent approved @${OUTREACH.handle}, ${OUTREACH.score}/10`
            )}
          </div>
        </div>
        {/* The composer: drafted, approved by you, sent from the phone. */}
        <div style={{ padding: "16px 20px 22px", borderTop: "1px solid #ececec", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 18, color: approved ? "#111" : "#aaa", background: "#f1f1f1", borderRadius: 999, padding: "13px 18px", display: "flex", alignItems: "center", gap: 10 }}>
            {approved ? (
              <>
                <span style={{ display: "inline-grid", placeItems: "center", width: 24, height: 24, borderRadius: 12, background: "#2f7a3e", color: "#fff", fontSize: 15, transform: `scale(${approvedPop})` }}>✓</span>
                {sent ? "Sent" : "Approved by you"}
              </>
            ) : (
              "The outreach agent is drafting…"
            )}
          </div>
          <div
            style={{
              background: sent ? "#2f7a3e" : approved ? CRIMSON : "#d6d6d6",
              color: "#fff",
              fontFamily: "Geist",
              fontWeight: 700,
              fontSize: 19,
              borderRadius: 999,
              padding: "13px 22px",
              transform: `scale(${press})`,
            }}
          >
            {sent ? "Sent" : sending ? "Sending" : "Send"}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function EndCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const rise = spring({ frame: frame - 6, fps, config: { damping: 16, stiffness: 120 } });
  return (
    <AbsoluteFill style={{ background: `rgba(251,246,234,${0.92 * fade})`, alignItems: "center", justifyContent: "center" }}>
      <div style={{ opacity: rise, transform: `translateY(${(1 - rise) * 24}px)`, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Img src={staticFile("nomen-logo.png")} style={{ height: 230, width: "auto", marginBottom: 18, transform: `scale(${0.9 + 0.1 * rise})` }} />
        <div style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 96, color: INK, letterSpacing: -1, lineHeight: 1 }}>Nomen</div>
        <div style={{ fontFamily: "Inter", fontWeight: 500, fontSize: 34, color: "#5a4636", marginTop: 10 }}>UGC ad campaigns, run by agents.</div>
      </div>
    </AbsoluteFill>
  );
}
