import { solid } from "../materials";
import { R } from "../palette";
import { type HitInfo, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";

// A Greek hoplite: Corinthian helmet with a horsehair crest, bronze cuirass, pteruges, greaves,
// a round aspis and a spear. Built facing +x around a few joints so every pose is just angles.

export type Look = {
  skin: number;
  crest: number;
  /** Skirt and cape colour. */
  tunic: number;
  /** Linothorax (linen armour) colour and its trim. */
  armour: number;
  trim: number;
  shield: number;
  emblem: "chevron" | "dot" | "n" | "bar" | "eye";
  cape: boolean;
};

export type Hold = "spear" | "scroll" | "case" | "magnifier" | "brush" | "trumpet" | "spyglass" | "point" | "none";

export type Pose = {
  /** Heading in radians around z: 0 faces +x. */
  facing: number;
  /** Walk cycle phase 0..1 and stride amplitude 0..1. */
  walk: number;
  stride: number;
  /** Sitting on a stool of this height (0 = standing). */
  sit: number;
  /** Forward lean of the torso, radians. */
  lean: number;
  /** Arm angles: pitch forward (radians) and how far the hand comes in front of the chest. */
  armL: number;
  armR: number;
  /** Typing / working hand bob, 0..1. */
  work: number;
  hold: Hold;
  shield: boolean;
  /** Head tilt down (radians). */
  nod: number;
  /** Astride a horse: `sit` is then the saddle height. */
  ride?: boolean;
};

export const STANDING: Pose = { facing: 0, walk: 0, stride: 0, sit: 0, lean: 0, armL: 0, armR: 0, work: 0, hold: "spear", shield: true, nod: 0 };

const LOOKS: Look[] = [
  { skin: R.skinLight, crest: R.crimson, tunic: R.crimson, armour: R.white, trim: R.crimson, shield: R.crimson, emblem: "chevron", cape: true },
  { skin: R.skinMid, crest: R.crimson, tunic: R.navy, armour: R.white, trim: R.navy, shield: R.cream, emblem: "n", cape: true },
  { skin: R.skinDeep, crest: R.navy, tunic: R.crimson, armour: R.white, trim: R.crimson, shield: R.navy, emblem: "dot", cape: true },
  { skin: R.skinMid, crest: R.gold, tunic: R.teal, armour: R.white, trim: R.teal, shield: R.teal, emblem: "bar", cape: true },
  { skin: R.skinLight, crest: R.white, tunic: R.crimson, armour: R.white, trim: R.gold, shield: R.cream, emblem: "eye", cape: true },
  { skin: R.skinDeep, crest: R.crimson, tunic: R.navy, armour: R.white, trim: R.crimson, shield: R.gold, emblem: "chevron", cape: true },
];

export function look(index: number): Look {
  return LOOKS[((index % LOOKS.length) + LOOKS.length) % LOOKS.length];
}

/** The strategist: purple-trimmed bronze, a tall crest and a long cape. */
export const GENERAL: Look = { skin: R.skinMid, crest: R.crimson, tunic: R.violet, armour: R.bronze, trim: R.violet, shield: R.crimson, emblem: "n", cape: true };

const skinMat = (rampId: number) => solid(rampId, 0.3, 0);

function greaveLeg(skin: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    // Local z runs from hip (negative) to foot (positive) along the capsule.
    if (h.lz > -0.6) {
      out.ramp = R.bronze;
      out.tone = 0.4;
    } else {
      out.ramp = skin;
      out.tone = 0.2;
    }
  };
}

function skirt(rampId: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    out.dither = 0;
    const strip = Math.floor(((Math.atan2(h.ly, h.lx) + Math.PI) / (Math.PI * 2)) * 12);
    out.tone = strip % 2 ? -0.7 : 0.3;
    if (h.lz < -1.1) out.tone -= 0.8;
  };
}

function cuirass(l: Look) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = l.armour;
    out.dither = 0;
    out.tone = l.armour === R.white ? -0.4 : 0.3;
    // Coloured yoke over the shoulders and a belt at the waist.
    if (h.lz > 1.3 || h.lz < -1.8) {
      out.ramp = l.trim;
      out.tone = 0.2;
    }
  };
}

function helmet(_h: HitInfo, out: ShadeOut) {
  out.ramp = R.bronze;
  out.dither = 0;
  out.tone = 1.1;
}

function shieldFace(l: Look) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const r = Math.hypot(h.lx, h.ly);
    const onFace = Math.abs(h.lz) > 0.3;
    if (!onFace || r > 3.75) {
      out.ramp = R.bronze;
      out.tone = 0.8;
      return;
    }
    out.ramp = l.shield;
    out.tone = 0.4;
    // Emblem in the disc plane; ly runs up the shield, lx across it.
    const u = h.lx;
    const v = h.ly;
    const contrast = l.shield === R.cream || l.shield === R.gold ? R.crimson : R.cream;
    let mark = false;
    if (l.emblem === "chevron") mark = Math.abs(Math.abs(u) * 1.05 - (v + 1.6)) < 0.75 && v > -2.3 && v < 2.2;
    else if (l.emblem === "dot") mark = r < 1.3;
    else if (l.emblem === "bar") mark = Math.abs(v) < 0.75;
    else if (l.emblem === "eye") mark = Math.hypot(u, v * 1.8) < 2.2 && Math.hypot(u, v * 1.8) > 1.1;
    else mark = (Math.abs(u) > 1.2 && Math.abs(u) < 2.1 && Math.abs(v) < 2.1) || (Math.abs(u + v * 0.85) < 0.6 && Math.abs(v) < 2.1);
    if (mark) {
      out.ramp = contrast;
      out.tone = 0.6;
    }
  };
}

/** Builds the soldier into `m` at the current frame (feet at the origin). */
export function soldierInto(m: Model, pose: Pose, l: Look) {
  const phase = pose.walk * Math.PI * 2;
  const swing = Math.sin(phase) * 0.5 * pose.stride;
  const bob = Math.abs(Math.cos(phase)) * 0.45 * pose.stride;
  const sitting = pose.sit > 0;
  const hipZ = sitting ? pose.sit + 1.2 : 7.4 + bob - 0.45 * pose.stride;

  m.with(rotZ(pose.facing), () => {
    // Legs.
    for (const side of [1, -1] as const) {
      const y = side * 1.15;
      let foot: [number, number, number];
      if (pose.ride) {
        // Astride: thighs out over the horse's flanks, shins hanging along them.
        const knee: [number, number, number] = [1.8, y * 2.6, hipZ - 3.2];
        foot = [1.2, y * 2.5, hipZ - 6.6];
        m.capsule([0.2, y, hipZ], knee, 1.05, { mat: skinMat(l.skin) });
        m.capsule(knee, foot, 1, { mat: greaveLeg(l.skin) });
        m.box(foot[0] + 0.7, foot[1], foot[2] - 0.3, 1.4, 0.85, 0.5, { mat: solid(R.woodDark, 0.6, 0) });
        continue;
      }
      if (sitting) {
        // Thighs forward, shins down to the floor.
        const knee: [number, number, number] = [3.6, y * 1.1, hipZ];
        foot = [4.2, y * 1.15, 0.9];
        m.capsule([0.2, y, hipZ], knee, 1.05, { mat: skinMat(l.skin) });
        m.capsule(knee, foot, 1, { mat: greaveLeg(l.skin) });
      } else {
        const a = swing * side;
        foot = [Math.sin(a) * 6.6, y, Math.max(0.9, hipZ - Math.cos(a) * 6.6)];
        m.capsule([0, y, hipZ], foot, 1.05, { mat: greaveLeg(l.skin) });
      }
      m.box(foot[0] + 0.7, foot[1], 0.55, 1.55, 0.95, 0.55, { mat: solid(R.woodDark, 0.6, 0) });
    }

    m.with(mul(translate(0, 0, hipZ), rotY(pose.lean)), () => {
      // Pteruges skirt, cuirass, belt.
      m.frustum(0, 0, -0.2, 2.65, 2.15, 1.55, { mat: skirt(l.tunic) });
      m.ellipsoid(0.1, 0, 3.4, 1.95, 2.45, 2.6, { mat: cuirass(l) });
      if (l.cape) m.box(-2.15, 0, 1.9, 0.4, 2.6, 3.9, { mat: solid(l.tunic, -0.2, 0), rot: rotY(0.12 + pose.stride * 0.15) });

      // Shoulders and arms.
      const shoulderZ = 5.1;
      const arm = (side: 1 | -1, pitch: number) => {
        const y = side * 2.55;
        const reach = 4.9;
        const hand: [number, number, number] = [Math.sin(pitch) * reach, y + side * 0.15 - (pitch > 0.6 ? side * 1.1 : 0), shoulderZ - Math.cos(pitch) * reach];
        m.capsule([0, y, shoulderZ], hand, 0.82, { mat: skinMat(l.skin) });
        m.sphere(0, y, shoulderZ + 0.1, 1.15, { mat: solid(l.trim, 0.3, 0) });
        return hand;
      };
      const walkArm = Math.sin(phase) * 0.45 * pose.stride;
      const workBob = Math.sin(pose.work * Math.PI * 2) * 0.12;
      const handL = arm(1, pose.armL + (pose.hold === "spear" || pose.armL ? 0 : -walkArm) + workBob);
      const handR = arm(-1, pose.armR + (pose.armR ? 0 : walkArm) - workBob);

      // Held things, in the hands' frame.
      if (pose.hold === "spear") {
        m.capsule([handR[0] + 0.4, handR[1] - 0.2, -6], [handR[0] + 1.4, handR[1] - 0.3, 19], 0.34, { mat: solid(R.wood, 0.4, 0) });
        m.frustum(handR[0] + 1.45, handR[1] - 0.3, 20.4, 0.7, 0.05, 1.4, { mat: solid(R.bronze, 1.2, 0) });
      } else if (pose.hold === "scroll") {
        m.cylinder((handL[0] + handR[0]) / 2 + 0.3, 0, (handL[2] + handR[2]) / 2 + 0.6, 0.8, 2.6, { mat: solid(R.cream, 0.6, 0), rot: rotX(Math.PI / 2) });
      } else if (pose.hold === "case") {
        // A leather scroll case held across the body, the rolled papyrus showing at both ends.
        const cx = (handL[0] + handR[0]) / 2 + 0.3;
        const cz = (handL[2] + handR[2]) / 2 + 0.9;
        m.cylinder(cx, 0, cz, 1.05, 2.4, { mat: solid(R.woodDark, 0.9, 0), rot: rotX(Math.PI / 2) });
        m.cylinder(cx, 0, cz, 1.12, 0.35, { mat: solid(R.bronze, 1.4, 0), rot: rotX(Math.PI / 2) });
        for (const y of [-2.75, 2.75]) m.cylinder(cx, y, cz, 0.85, 0.5, { mat: solid(R.cream, 1.4, 0), rot: rotX(Math.PI / 2) });
      } else if (pose.hold === "magnifier") {
        m.capsule([handR[0], handR[1], handR[2]], [handR[0] + 1.6, handR[1], handR[2] + 1.6], 0.3, { mat: solid(R.woodDark, 0.5, 0) });
        m.cylinder(handR[0] + 2.5, handR[1], handR[2] + 2.5, 1.5, 0.25, { mat: lensMat, rot: rotY(Math.PI / 2 - 0.5) });
      } else if (pose.hold === "brush") {
        m.capsule([handR[0], handR[1], handR[2]], [handR[0] + 2.4, handR[1], handR[2] + 1.6], 0.25, { mat: solid(R.woodDark, 0.8, 0) });
        m.sphere(handR[0] + 2.5, handR[1], handR[2] + 1.7, 0.45, { mat: solid(R.crimson, 1, 0) });
      } else if (pose.hold === "trumpet") {
        m.frustum(handR[0] + 2.4, handR[1] + 1.2, handR[2] + 0.7, 0.3, 1.2, 2.6, { mat: solid(R.gold, 0.6, 0), rot: rotY(Math.PI / 2 - 0.28) });
      } else if (pose.hold === "spyglass") {
        m.cylinder(handR[0] + 1.6, handR[1] + 1, handR[2] + 0.9, 0.55, 2.2, { mat: solid(R.gold, 0.2, 0), rot: rotY(Math.PI / 2 - 0.18) });
      } else if (pose.hold === "point") {
        m.capsule([handR[0], handR[1], handR[2]], [handR[0] + 1.1, handR[1], handR[2] - 0.2], 0.34, { mat: skinMat(l.skin) });
      }

      if (pose.shield) {
        m.with(translate(0.8, 3.75, 3.2), () => m.cylinder(0, 0, 0, 4.2, 0.42, { mat: shieldFace(l), rot: rotX(-Math.PI / 2) }));
      }

      // Head: face below a Corinthian helmet; crest on top.
      m.with(mul(translate(0.15, 0, 7.6), rotY(pose.nod)), () => {
        m.sphere(0.2, 0, 0, 2.05, { mat: skinMat(l.skin) });
        m.ellipsoid(-0.1, 0, 0.45, 2.45, 2.35, 2.45, { mat: helmet, clip: [0, 0, -1, 0.35] });
        // Cheek guards leave a T-shaped face opening.
        for (const side of [1, -1]) m.box(1.25, side * 1.45, -0.7, 0.9, 0.55, 1.15, { mat: helmet });
        m.box(-1.3, 0, -0.9, 0.9, 2.2, 1.2, { mat: helmet });
        m.ellipsoid(-0.5, 0, 3.0, 3.5, 0.75, 1.9, { mat: solid(l.crest, 0.5, 0), clip: [0, 0, -1, -0.15] });
        m.box(-0.4, 0, 2.55, 0.35, 0.3, 0.45, { mat: solid(R.bronze, 0.5, 0) });
      });
    });
  });
}

function lensMat(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  const r = Math.hypot(h.lx, h.ly);
  if (r > 1.15) {
    out.ramp = R.gold;
    out.tone = 0.6;
  } else {
    out.ramp = R.teal;
    out.tone = 2;
    out.glow = 0.4;
  }
}

export function soldierModel(pose: Pose, l: Look) {
  const m = new Model();
  soldierInto(m, pose, l);
  return m;
}
