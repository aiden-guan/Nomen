import { describe, expect, it } from "vitest";
import { CLONE_GATE, CLONE_SCHEMA, cloneabilityOf, cloneabilityPrior, cloneable, cloneLine, cloneOf, cloneSignals, faceShare, readFootage } from "@/lib/creative/cloneability";
import type { FootageRead } from "@/lib/creative/types";

// Cloneability: how faithfully the footage clone (one AI persona performing the original's motion,
// the audio re-voiced, graphics replaced in place) can remake a reference. Face-to-camera UGC from
// one person is the target; several people, moving cameras, crowds, hands on a product and songs
// are what it cannot reproduce.

const prior = (caption: string, duration: number | null = 25) => cloneabilityPrior({ caption, duration });

describe("the cloneability prior, from caption and length", () => {
  it("starts an unwatched video at 5 and says so", () => {
    const neutral = prior("agent tools that save me hours");
    expect(neutral).toEqual({ score: 5, basis: "metadata", parts: [{ name: "base", points: 5, signal: "not watched yet: 5 to start" }] });
    expect(cloneSignals(neutral)).toEqual(["not watched yet: 5 to start"]);
  });

  it("adds 2 for a face-to-camera format named in the caption, quoting the cue", () => {
    for (const caption of ["storytime: how I lost my first client", "POV: your agent pays for itself", "I tried every AI note taker", "Replying to @sam here is how", "honest opinion on cursor", "#ugc #skincare", "my take on the new pricing", "hot take: you don't need 12 API keys"]) {
      expect(prior(caption).score, caption).toBe(7);
    }
    expect(cloneSignals(prior("storytime: how I lost my first client"))).toContain('caption names a face-to-camera format ("storytime") +2');
  });

  it("adds half a point more for green screen: the set is a picture", () => {
    const green = prior("green screen rant about API pricing #greenscreen");
    expect(green.score).toBe(7.5);
    expect(green.parts.map((part) => [part.name, part.points])).toEqual([
      ["base", 5],
      ["face_format", 2],
      ["green_screen", 0.5],
    ]);
  });

  it("takes points off for what the clone cannot reproduce, each cue once", () => {
    expect(prior("prank on my boyfriend").score).toBe(2.5); // several people -2.5 (one cue, counted once)
    expect(prior("duet with @creator").score).toBe(2.5);
    expect(prior("we tried the viral soda").score).toBe(2.5);
    expect(prior("day in my life as a founder").score).toBe(3.5); // moving -1.5
    expect(prior("dance challenge #fyp").score).toBe(3.5); // music -1.5
    expect(prior("unboxing the new headphones").score).toBe(4); // hands -1
    expect(prior("part 2 of the saga").score).toBe(4.5); // tied -0.5
    expect(cloneSignals(prior("prank on my boyfriend"))).toContain('caption suggests several people ("prank") -2.5');
  });

  it("adds the cues up and clamps at 0", () => {
    expect(prior("storytime with my bestie").score).toBe(4.5); // 5 + 2 - 2.5
    expect(prior("vlog: my boyfriend and I dance at the festival, part 3").score).toBe(0); // 5 - 2.5 - 1.5 - 1.5 - 0.5 = -1
  });

  it("charges for length past 45 s, at most 2 points, and never rewards an unknown length", () => {
    expect(prior("agent tools", 45).score).toBe(5);
    expect(prior("agent tools", 60).score).toBe(4);
    expect(prior("agent tools", 75).score).toBe(3);
    expect(prior("agent tools", 400).score).toBe(3);
    expect(prior("agent tools", null).score).toBe(5);
    expect(cloneSignals(prior("agent tools", 60))).toContain("60 s: past 45 s, every take is more to clone -1");
  });

  it("never calls an unwatched video an easy clone: 7.5 at most", () => {
    expect(prior("green screen storytime POV #ugc", 20).score).toBe(7.5);
  });
});

const face: FootageRead = { people: 1, face_to_camera: 1, camera: "static", set: "plain", product: "none", overlays: "separable", audio: "speech", script: "template", hardest: "nothing hard" };
const read = (over: Partial<FootageRead> = {}, extra: Partial<{ duration: number; cuts: number; speech: boolean }> = {}) =>
  cloneabilityOf({ footage: { ...face, ...over }, duration: 30, cuts: 3, speech: true, ...extra });
const points = (clone: ReturnType<typeof read>, name: string) => clone.parts.find((part) => part.name === name)?.points;

describe("cloneability from the breakdown", () => {
  it("gives one person talking to a propped-up phone in a plain room, in long takes, a 10", () => {
    const best = read();
    expect(best.score).toBe(10);
    expect(best.basis).toBe("breakdown");
    expect(best.parts.map((part) => part.name)).toEqual(["people", "face", "takes", "camera", "set", "audio", "script"]);
    expect(cloneSignals(best)).toEqual([
      "one person on camera +2.5",
      "face and mouth to camera 100% of the time +2",
      "1.0 cuts per 10 s: long continuous takes +1.5",
      "propped-up phone or tripod +1",
      "plain set +1",
      "one voice talking: re-voiced line for line +1.5",
      "a template script: hook, claim, ask +0.5",
    ]);
  });

  it("people: one person 2.5, nobody 1.5 (and no face), two 0.5, three or more 0", () => {
    expect(points(read({ people: 0 }), "people")).toBe(1.5);
    expect(points(read({ people: 0 }), "face")).toBe(0);
    expect(read({ people: 0 }).score).toBe(7);
    expect(read({ people: 2 }).score).toBe(8);
    expect(read({ people: 3 }).score).toBe(7.5);
    expect(cloneSignals(read({ people: 3 }))[0]).toBe("3 people on camera (the clone performs one) +0");
  });

  it("face: 2 points times the share of the video talking to the lens", () => {
    expect(points(read({ face_to_camera: 0.5 }), "face")).toBe(1);
    expect(read({ face_to_camera: 0.25 }).score).toBe(8.5);
  });

  it("takes: 1.5 at 2 cuts per 10 s or fewer, 0 at 6 or more (rapid jump cuts), linear between", () => {
    expect(points(read({}, { cuts: 6 }), "takes")).toBe(1.5);
    expect(points(read({}, { cuts: 12 }), "takes")).toBe(0.75);
    expect(points(read({}, { cuts: 18 }), "takes")).toBe(0);
    expect(points(read({}, { cuts: 40 }), "takes")).toBe(0);
    expect(cloneSignals(read({}, { cuts: 18 }))).toContain("6.0 cuts per 10 s: rapid jump cuts +0");
  });

  it("camera: static 1, handheld 0.5, moving 0", () => {
    expect(read({ camera: "handheld" }).score).toBe(9.5);
    expect(read({ camera: "moving" }).score).toBe(9);
  });

  it("set: plain or green screen 1, a real location 0.3, a crowd 0", () => {
    expect(read({ set: "green_screen" }).score).toBe(10);
    expect(read({ set: "location" }).score).toBe(9.3);
    expect(read({ set: "crowd" }).score).toBe(9);
  });

  it("audio: one voice 1.5, a voice-over 1, music or silence 0.5, dialogue or a song 0", () => {
    expect(read({ audio: "voiceover" }).score).toBe(9.5);
    expect(read({ audio: "music_only" }).score).toBe(9);
    expect(read({ audio: "none" }).score).toBe(9);
    expect(read({ audio: "dialogue" }).score).toBe(8.5);
    expect(read({ audio: "song" }).score).toBe(8.5);
  });

  it("trusts the transcript over the model: claimed speech with no words is music only", () => {
    const silent = read({ audio: "speech" }, { speech: false });
    expect(points(silent, "audio")).toBe(0.5);
    expect(cloneSignals(silent)).toContain("music only, no speech +0.5");
  });

  it("script: a template 0.5, tied to an event or person 0", () => {
    expect(read({ script: "tied" }).score).toBe(9.5);
  });

  it("takes points off for hands on the product, baked-in graphics and length past 45 s", () => {
    expect(read({ product: "close_up" }).score).toBe(8.5);
    expect(read({ product: "brief" }).score).toBe(9.5);
    expect(read({ overlays: "baked" }).score).toBe(9);
    expect(points(read({ overlays: "separable" }), "overlays")).toBeUndefined(); // captions laid over are replaced in place
    expect(read({}, { duration: 60, cuts: 4 }).score).toBe(9);
    expect(read({}, { duration: 90, cuts: 6 }).score).toBe(8);
  });

  it("scores the formats the way the team would: face UGC first, faceless screens next, skits last", () => {
    const greenScreenRant = read({ set: "green_screen", face_to_camera: 0.9, camera: "handheld" }, { cuts: 9 });
    const screenRecording = read({ people: 0, face_to_camera: 0, audio: "voiceover" });
    const skit = read({ people: 2, face_to_camera: 0.5, camera: "handheld", set: "location", audio: "dialogue", script: "tied" }, { cuts: 12 });
    const worst = read({ people: 4, face_to_camera: 0, camera: "moving", set: "crowd", product: "close_up", overlays: "baked", audio: "song", script: "tied" }, { duration: 120, cuts: 90 });
    expect(greenScreenRant.score).toBeGreaterThan(screenRecording.score);
    expect(screenRecording.score).toBe(6.5);
    expect(skit.score).toBeLessThan(CLONE_GATE);
    expect(worst.score).toBe(0);
  });
});

describe("reading the breakdown's clone block", () => {
  const beats = [
    { start: 0, end: 6, shot: "talking_head" as const },
    { start: 6, end: 10, shot: "screen" as const },
  ];

  it("keeps a full block, clamped, with unknown words mapped to the middle of each scale", () => {
    expect(readFootage({ ...face, people: 2.6, face_to_camera: 1.4, hardest: "  her hands on the jar  " }, beats)).toEqual({ ...face, people: 3, face_to_camera: 1, hardest: "her hands on the jar" });
    expect(readFootage({ people: 1, face_to_camera: 0.5, camera: "drone", set: "space", product: "maybe", overlays: "?", audio: "podcast", script: "?", hardest: 3 }, beats)).toEqual({
      people: 1,
      face_to_camera: 0.5,
      camera: "handheld",
      set: "plain",
      product: "none",
      overlays: "separable",
      audio: "speech",
      script: "template",
      hardest: "",
    });
  });

  it("fills a missing face share and head count from the beats", () => {
    expect(readFootage({ camera: "static" }, beats)).toMatchObject({ people: 1, face_to_camera: 0.6 });
    expect(readFootage({}, [{ start: 0, end: 4, shot: "screen" }])).toMatchObject({ people: 0, face_to_camera: 0 });
    expect(faceShare([{ start: 0, end: 4, shot: "split" }, { start: 4, end: 8, shot: "reaction" }])).toBe(0.75);
    expect(faceShare([])).toBe(0);
  });

  it("is undefined when the model left the block out, so the candidate keeps its prior", () => {
    expect(readFootage(undefined, beats)).toBeUndefined();
    expect(readFootage("one person", beats)).toBeUndefined();
    expect(readFootage([face], beats)).toBeUndefined();
  });

  it("asks the model for every field the score uses", () => {
    expect([...CLONE_SCHEMA.required].sort()).toEqual(["audio", "camera", "face_to_camera", "hardest", "overlays", "people", "product", "script", "set"]);
    expect(CLONE_SCHEMA.description).toMatch(/one person, in continuous takes/);
  });
});

describe("a candidate's cloneability", () => {
  it("uses the scored value, else the prior from its caption and length, and gates at 4", () => {
    const scored = { caption: "dance challenge", duration: 20, score: { cloneability: { score: 8, basis: "breakdown" as const, parts: [] } } };
    expect(cloneOf(scored)).toBe(8);
    expect(cloneOf({ ...scored, score: {} })).toBe(3.5);
    expect(cloneable({ ...scored, score: {} })).toBe(false);
    expect(cloneable({ caption: "", duration: 20, score: {} })).toBe(true);
  });

  it("explains itself in one line for an agent", () => {
    expect(cloneLine(prior("POV: you found it"))).toBe('7/10 guessed from the caption and length: not watched yet: 5 to start, caption names a face-to-camera format ("POV") +2');
    expect(cloneLine(read({ product: "brief" }))).toMatch(/^9\.5\/10 from its frames: one person on camera \+2\.5, .*the product held up briefly -0\.5$/);
  });
});
