import { solid } from "../materials";
import { R } from "../palette";
import { type HitInfo, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";

// A Greek hoplite: Corinthian helmet with a horsehair crest, bronze cuirass, pteruges, greaves,
// a round aspis and a spear. Built facing +x around a few joints so every pose is just angles.
// The same body wears the other kits of the battle below the agora: the Greek archer (Scythian
// cap, patterned trousers, bow and quiver) and the Roman legionary and centurion (galea, banded
// armour, curved scutum, pilum and gladius).

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
  /** What the body wears: a hoplite unless said otherwise. */
  kit?: "hoplite" | "archer" | "legionary" | "centurion";
};

/**
 * What the hands hold. `lance`: the spear levelled to fight (a Roman holds his gladius instead);
 * `bow`: drawn by `Pose.draw`; `standard`: a company's flag on a tall pole.
 */
export type Hold = "spear" | "scroll" | "case" | "magnifier" | "brush" | "trumpet" | "spyglass" | "point" | "none" | "lance" | "sword" | "bow" | "standard";

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
  /** How far the bowstring is drawn, 0..1 (hold "bow"). */
  draw?: number;
  /** Knocked flat on his back, weapon and shield dropped beside him. */
  fallen?: boolean;
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

/** Greek archers: Scythian caps and patterned trousers, as on the vases. */
const ARCHERS: Look[] = [
  { skin: R.skinLight, crest: R.crimson, tunic: R.teal, armour: R.cream, trim: R.crimson, shield: R.cream, emblem: "dot", cape: false, kit: "archer" },
  { skin: R.skinMid, crest: R.gold, tunic: R.crimson, armour: R.cream, trim: R.navy, shield: R.cream, emblem: "dot", cape: false, kit: "archer" },
  { skin: R.skinDeep, crest: R.teal, tunic: R.navy, armour: R.cream, trim: R.gold, shield: R.cream, emblem: "dot", cape: false, kit: "archer" },
];

/** Roman legionaries: red tunics and scuta, iron armour; the centurion's crest runs across his helmet. */
const ROMANS: Look[] = [
  { skin: R.skinLight, crest: R.crimson, tunic: R.crimson, armour: R.iron, trim: R.gold, shield: R.crimson, emblem: "bar", cape: false, kit: "legionary" },
  { skin: R.skinMid, crest: R.crimson, tunic: R.crimson, armour: R.iron, trim: R.gold, shield: R.crimson, emblem: "bar", cape: false, kit: "legionary" },
  { skin: R.skinDeep, crest: R.crimson, tunic: R.crimson, armour: R.iron, trim: R.gold, shield: R.crimson, emblem: "bar", cape: false, kit: "legionary" },
];
const CENTURION: Look = { skin: R.skinMid, crest: R.crimson, tunic: R.crimson, armour: R.marble, trim: R.gold, shield: R.crimson, emblem: "bar", cape: true, kit: "centurion" };

/** Look indices for the battle's kits, beside the hoplites' 0..5 and the strategist's -1. */
export const LOOK = { archer: 200, roman: 100, centurion: 150 } as const;

/** Any look by its index: hoplites, the strategist, archers, legionaries and the centurion. */
export function lookByIndex(index: number): Look {
  if (index < 0) return GENERAL;
  if (index >= LOOK.archer) return ARCHERS[(index - LOOK.archer) % ARCHERS.length];
  if (index === LOOK.centurion) return CENTURION;
  if (index >= LOOK.roman) return ROMANS[(index - LOOK.roman) % ROMANS.length];
  return look(index);
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

/** Bare legs and caligae: hobnailed sandals strapped up the ankle. */
function romanLeg(skin: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = h.lz > 1.4 && Math.floor(h.lz * 2.4) % 2 === 0 ? R.woodDark : skin;
    out.tone = out.ramp === skin ? 0.2 : 0.6;
  };
}

/** The archer's trousers: a zigzag of two colours, as the vase painters drew them. */
function trousers(l: Look) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const zig = Math.floor(h.lz * 1.6 + Math.abs(((Math.atan2(h.ly, h.lx) / Math.PI) * 3) % 2) * 0.8) % 2 === 0;
    out.ramp = zig ? l.tunic : R.cream;
    out.tone = zig ? 0.2 : 0.4;
  };
}

/** Lorica segmentata: iron bands round the body, brass buckles down the front. */
function segmentata(l: Look) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = l.armour;
    const band = Math.floor((h.lz + 4) * 1.55) % 2;
    out.tone = (l.armour === R.marble ? 0.2 : 0.9) + (band ? 0.45 : -0.35);
    if (h.lx > 1.6 && Math.abs(h.ly) < 0.35 && band) {
      out.ramp = l.trim;
      out.tone = 0.9;
    }
  };
}

/** The galea: a polished iron bowl with a brass brow band. */
function galea(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = h.lz < 0.75 && h.lz > 0.25 ? R.bronze : R.iron;
  out.tone = out.ramp === R.bronze ? 1.2 : 1.35;
}

/** The scutum: red, edged in brass, with golden wings out from the boss. */
function scutumFace(l: Look) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const onFace = Math.abs(h.ly) > 0.12;
    if (!onFace || Math.abs(h.lz) > 4.3 || Math.abs(h.lx) > 1.05) {
      out.ramp = R.bronze;
      out.tone = 0.9;
      return;
    }
    out.ramp = l.shield;
    out.tone = 0.35;
    const wing = Math.abs(Math.abs(h.lz) - 1.5 - Math.abs(h.lx) * 0.3) < 0.32;
    if (wing || Math.abs(h.lz) < 0.3) {
      out.ramp = R.gold;
      out.tone = 0.8;
    }
  };
}

/** The archer's soft cap, its band patterned like his trousers. */
function capMat(l: Look) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = l.crest;
    out.tone = 0.3;
    if (h.lz < 0.5 && Math.floor((h.lx + h.ly) * 1.4) % 2 === 0) out.ramp = R.cream;
  };
}

/** Builds the soldier into `m` at the current frame (feet at the origin). */
export function soldierInto(m: Model, pose: Pose, l: Look) {
  if (pose.fallen) return fallenInto(m, pose, l);
  const roman = l.kit === "legionary" || l.kit === "centurion";
  const archer = l.kit === "archer";
  // An archer carries his bow where a hoplite would carry a spear or a shield.
  if (archer && (pose.hold === "spear" || pose.hold === "lance")) pose = { ...pose, hold: "bow", draw: 0, armL: Math.max(pose.armL, 0.5) };
  // A legionary is drawn shield-right, weapon-left: facing the Greeks, his scutum then faces the
  // viewer, as the most Roman thing about him should.
  const side = roman ? -1 : 1;
  if (roman) pose = { ...pose, armL: pose.armR, armR: pose.armL };
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
      const legMat = roman ? romanLeg(l.skin) : archer ? trousers(l) : greaveLeg(l.skin);
      if (sitting) {
        // Thighs forward, shins down to the floor.
        const knee: [number, number, number] = [3.6, y * 1.1, hipZ];
        foot = [4.2, y * 1.15, 0.9];
        m.capsule([0.2, y, hipZ], knee, 1.05, { mat: archer ? legMat : skinMat(l.skin) });
        m.capsule(knee, foot, 1, { mat: legMat });
      } else {
        const a = swing * side;
        foot = [Math.sin(a) * 6.6, y, Math.max(0.9, hipZ - Math.cos(a) * 6.6)];
        m.capsule([0, y, hipZ], foot, 1.05, { mat: legMat });
      }
      m.box(foot[0] + 0.7, foot[1], 0.55, 1.55, 0.95, 0.55, { mat: solid(R.woodDark, 0.6, 0) });
    }

    m.with(mul(translate(0, 0, hipZ), rotY(pose.lean)), () => {
      // Skirt (pteruges, or a Roman's tunic hem), body armour, belt.
      m.frustum(0, 0, -0.2, 2.65, 2.15, 1.55, { mat: roman ? solid(l.tunic, 0.2, 0) : skirt(l.tunic) });
      if (roman) {
        // The cingulum: leather straps hanging down the front.
        for (const y of [-0.9, -0.3, 0.3, 0.9]) m.box(2.45, y, -0.6, 0.18, 0.18, 1.3, { mat: solid(R.woodDark, 0.4, 0) });
      }
      m.ellipsoid(0.1, 0, 3.4, 1.95, 2.45, 2.6, { mat: roman ? segmentata(l) : cuirass(l) });
      if (l.cape) m.box(-2.15, 0, 1.9, 0.4, 2.6, 3.9, { mat: solid(l.tunic, -0.2, 0), rot: rotY(0.12 + pose.stride * 0.15) });
      if (archer) {
        // A quiver slung across the back, fletchings showing.
        m.with(mul(translate(-2.3, 0.9, 3.4), rotX(-0.35)), () => {
          m.cylinder(0, 0, 0, 0.8, 2.3, { mat: solid(l.trim, 0.2, 0) });
          for (const [dx, dy] of [[0.25, 0.2], [-0.25, -0.15], [0, -0.35]]) m.box(dx, dy, 2.8, 0.12, 0.3, 0.6, { mat: solid(R.cream, 0.8, 0) });
        });
      }

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
      let handR: [number, number, number];
      if (pose.hold === "bow") {
        // The string hand comes back from the bow to the cheek as the bow is drawn.
        const draw = pose.draw ?? 0;
        const grip: [number, number, number] = [handL[0] - 0.8, handL[1] - 1.4, handL[2]];
        const cheek: [number, number, number] = [1.6, -0.6, shoulderZ + 1.6];
        handR = [grip[0] + (cheek[0] - grip[0]) * draw, grip[1] + (cheek[1] - grip[1]) * draw, grip[2] + (cheek[2] - grip[2]) * draw];
        m.capsule([0, -2.55, shoulderZ], handR, 0.82, { mat: skinMat(l.skin) });
        m.sphere(0, -2.55, shoulderZ + 0.1, 1.15, { mat: solid(l.trim, 0.3, 0) });
      } else handR = arm(-1, pose.armR + (pose.armR ? 0 : walkArm) - workBob);

      // Held things, in the hands' frame. A Roman holds his in the left hand (see `side`).
      const weapon = roman ? handL : handR;
      if (pose.hold === "spear" && roman) {
        // The pilum: a wooden shaft, then a long thin iron shank to a small point.
        m.capsule([weapon[0] + 0.4, weapon[1] + 0.2, -6], [weapon[0] + 1.2, weapon[1] + 0.3, 16.5], 0.36, { mat: solid(R.wood, 0.45, 0) });
        m.capsule([weapon[0] + 1.2, weapon[1] + 0.3, 16.5], [weapon[0] + 1.45, weapon[1] + 0.3, 22], 0.22, { mat: solid(R.iron, 1.2, 0) });
        m.frustum(weapon[0] + 1.47, weapon[1] + 0.3, 22.6, 0.48, 0.05, 0.85, { mat: solid(R.iron, 1.6, 0) });
      } else if (pose.hold === "spear") {
        m.capsule([handR[0] + 0.4, handR[1] - 0.2, -6], [handR[0] + 1.4, handR[1] - 0.3, 19], 0.34, { mat: solid(R.wood, 0.4, 0) });
        m.frustum(handR[0] + 1.45, handR[1] - 0.3, 20.4, 0.7, 0.05, 1.4, { mat: solid(R.bronze, 1.2, 0) });
      } else if ((pose.hold === "lance" && roman) || pose.hold === "sword") {
        // The gladius, thrust from behind the shield.
        m.with(mul(translate(weapon[0], weapon[1], weapon[2]), rotY(Math.PI / 2 - 0.25)), () => {
          m.box(0, 0, 2.6, 0.38, 0.16, 2.3, { mat: solid(R.iron, 1.6, 0) });
          m.box(0, 0, 0.35, 0.75, 0.3, 0.2, { mat: solid(R.gold, 0.6, 0) });
          m.sphere(0, 0, -0.55, 0.38, { mat: solid(R.gold, 0.6, 0) });
        });
      } else if (pose.hold === "lance") {
        // The spear levelled overarm at the enemy, the butt spike behind.
        const tip: [number, number, number] = [handR[0] + 12, handR[1] + 0.4, handR[2] - 1.6];
        m.capsule([handR[0] - 8, handR[1] - 0.3, handR[2] + 1.1], tip, 0.34, { mat: solid(R.wood, 0.4, 0) });
        m.with(mul(translate(tip[0], tip[1], tip[2]), rotY(Math.PI / 2 + 0.13)), () => m.frustum(0, 0, 0.7, 0.62, 0.05, 1.3, { mat: solid(R.bronze, 1.2, 0) }));
      } else if (pose.hold === "bow") {
        // A recurved bow upright in the left hand; the string to the drawing hand, and an arrow on it.
        const g: [number, number, number] = [handL[0] + 0.3, handL[1] - 0.2, handL[2]];
        const at = (t: number): [number, number, number] => [g[0] + Math.cos(t) * 1.5 - 1.5 + Math.abs(Math.sin(t * 2.6)) * 0.4, g[1], g[2] + Math.sin(t) * 6.2];
        const wood = solid(R.woodDark, 0.2, 0);
        for (let i = 0; i < 6; i++) m.capsule(at(-1.25 + (i / 6) * 2.5), at(-1.25 + ((i + 1) / 6) * 2.5), 0.48, { mat: wood });
        // Horn tips, pale against the dark limbs.
        for (const t of [-1.25, 1.25]) m.sphere(...at(t), 0.5, { mat: solid(R.cream, 0.6, 0) });
        const top = at(1.25);
        const bottom = at(-1.25);
        const nock = (pose.draw ?? 0) > 0.05 ? handR : ([g[0] - 1.6, g[1], g[2]] as [number, number, number]);
        const string = solid(R.cream, 1.4, 0);
        m.capsule(top, nock, 0.2, { mat: string });
        m.capsule(bottom, nock, 0.2, { mat: string });
        if ((pose.draw ?? 0) > 0.05) {
          m.capsule(nock, [g[0] + 2.8, g[1], g[2] + 0.2], 0.22, { mat: solid(R.wood, 0.9, 0) });
          m.frustum(g[0] + 2.9, g[1], g[2] + 0.2, 0.42, 0.02, 0.8, { mat: solid(R.iron, 1.4, 0), rot: rotY(Math.PI / 2) });
          m.box(nock[0] + 0.5, nock[1], nock[2] + 0.1, 0.5, 0.08, 0.35, { mat: solid(R.cream, 1.2, 0) });
        }
      } else if (pose.hold === "standard") {
        // A company's flag on a tall pole, in the company's colour.
        m.capsule([handR[0] + 0.4, handR[1] - 0.2, -6], [handR[0] + 1.2, handR[1] - 0.3, 22], 0.3, { mat: solid(R.wood, 0.4, 0) });
        m.box(handR[0] + 1.2, handR[1] - 2.9, 19.4, 0.12, 2.6, 2.1, { mat: solid(l.trim, 0.4, 0) });
        m.box(handR[0] + 1.2, handR[1] - 2.9, 19.4, 0.16, 1.0, 0.8, { mat: solid(R.cream, 1.2, 0) });
        m.sphere(handR[0] + 1.25, handR[1] - 0.3, 22.4, 0.55, { mat: solid(R.gold, 0.9, 0) });
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

      if (pose.shield && roman) {
        // The scutum: tall, curved round the body in three slats.
        m.with(translate(1.1, side * 3.55, 3.0), () => {
          m.box(0, 0, 0, 1.15, 0.2, 4.6, { mat: scutumFace(l) });
          for (const edge of [1, -1]) m.with(mul(translate(edge * 1.95, -side * 0.45, 0), rotZ(-side * edge * 0.5)), () => m.box(0, 0, 0, 1.0, 0.2, 4.6, { mat: scutumFace(l) }));
          m.sphere(0, side * 0.3, 0, 0.75, { mat: solid(R.bronze, 1.3, 0) });
        });
      } else if (pose.shield && !archer) {
        m.with(translate(0.8, 3.75, 3.2), () => m.cylinder(0, 0, 0, 4.2, 0.42, { mat: shieldFace(l), rot: rotX(-Math.PI / 2) }));
      }

      // Head: face below a Corinthian helmet and its crest, a Roman galea, or an archer's cap.
      m.with(mul(translate(0.15, 0, 7.6), rotY(pose.nod)), () => {
        m.sphere(0.2, 0, 0, 2.05, { mat: skinMat(l.skin) });
        if (roman) {
          m.ellipsoid(-0.1, 0, 0.55, 2.35, 2.3, 2.3, { mat: galea, clip: [0, 0, -1, 0.15] });
          // The neck guard flares out behind; hinged cheek pieces at the sides.
          m.box(-2.15, 0, -0.35, 0.8, 2.25, 0.2, { mat: galea, rot: rotY(-0.55) });
          for (const side of [1, -1]) m.box(0.7, side * 1.9, -0.85, 0.95, 0.22, 1.25, { mat: galea });
          // A legionary's plume runs front to back; a centurion's crest runs across.
          if (l.kit === "centurion") m.ellipsoid(0, 0, 3.2, 0.75, 3.3, 1.6, { mat: solid(l.crest, 0.6, 0), clip: [0, 0, -1, -0.2] });
          else m.ellipsoid(-0.4, 0, 2.95, 2.1, 0.6, 1.15, { mat: solid(l.crest, 0.5, 0), clip: [0, 0, -1, -0.1] });
          m.box(0, 0, 2.5, 0.35, 0.35, 0.4, { mat: solid(R.bronze, 0.8, 0) });
        } else if (archer) {
          m.ellipsoid(-0.15, 0, 0.75, 2.25, 2.2, 1.9, { mat: capMat(l), clip: [0, 0, -1, 0.05] });
          m.frustum(0.2, 0, 2.55, 1.15, 0.25, 1.4, { mat: capMat(l), rot: rotY(0.55) });
          // Flaps over the ears and the nape.
          for (const side of [1, -1]) m.box(-0.2, side * 1.95, -0.9, 0.85, 0.3, 1.2, { mat: capMat(l) });
          m.box(-1.95, 0, -0.9, 0.3, 1.5, 1.1, { mat: capMat(l) });
        } else {
          m.ellipsoid(-0.1, 0, 0.45, 2.45, 2.35, 2.45, { mat: helmet, clip: [0, 0, -1, 0.35] });
          // Cheek guards leave a T-shaped face opening.
          for (const side of [1, -1]) m.box(1.25, side * 1.45, -0.7, 0.9, 0.55, 1.15, { mat: helmet });
          m.box(-1.3, 0, -0.9, 0.9, 2.2, 1.2, { mat: helmet });
          m.ellipsoid(-0.5, 0, 3.0, 3.5, 0.75, 1.9, { mat: solid(l.crest, 0.5, 0), clip: [0, 0, -1, -0.15] });
          m.box(-0.4, 0, 2.55, 0.35, 0.3, 0.45, { mat: solid(R.bronze, 0.5, 0) });
        }
      });
    });
  });
}

/**
 * Knocked flat on his back, head behind him, arms flung out; his shield and weapon lie beside him.
 * No wound and nothing grisly: he gets up again.
 */
function fallenInto(m: Model, pose: Pose, l: Look) {
  m.with(rotZ(pose.facing), () => {
    m.with(mul(translate(9, 0, 2.6), rotY(-Math.PI / 2 + 0.05)), () =>
      soldierInto(m, { ...STANDING, hold: "none", shield: false, armL: 2.6, armR: 2.9, nod: -0.3 }, { ...l, cape: false }),
    );
    const roman = l.kit === "legionary" || l.kit === "centurion";
    if (roman) {
      // The scutum face up beside him.
      m.with(translate(0, 5.2, 0.4), () => m.box(0, 0, 0, 4.6, 1.9, 0.22, { mat: scutumFace({ ...l }), rot: rotX(Math.PI / 2) }));
    } else if (l.kit !== "archer") {
      m.with(translate(1, 5.6, 0.45), () => m.cylinder(0, 0, 0, 4.2, 0.42, { mat: shieldFace(l) }));
    }
    m.capsule([-6, -4.6, 0.4], [7, -3.4, 0.4], 0.3, { mat: solid(R.wood, 0.4, 0) });
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
