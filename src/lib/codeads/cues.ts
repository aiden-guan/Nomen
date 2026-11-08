// The cue sheet for synth.py (ED Studio's audio/synth.py, vendored): music, beds and foley computed from story.json,
// the same clock the picture uses, so re-voicing never desyncs the sound (ED Studio's make_cues.py, one per video, made
// generic over the gags).
//
// Sound identity "WORKSHOP" (ED Studio video 024): a marimba ostinato in F major at 118 bpm (I–V–vi–IV), a piano bass
// every 4 steps, a soft F pad, a whisper of taiko, booms on the big impacts, and the build genre's signature: a rising
// marimba "ta-da" (F5–A5–C6) on every term callout, a two-note lift on labels and money, a falling pair on stamps. The hook
// is foley only; the music enters on the second beat and never stops. The narrator sits on top: music ducks ~9 dB under
// every phrase, the room ~5 dB.

import type { StoryJson } from "./layout";

type Event = { t: number; sound: string; gain_db: number; pan: number; args?: Record<string, number> };
type Bed = { sound: string; t0: number; t1: number; fade_in: number; fade_out: number; gain_db: number; args?: Record<string, number>; seed?: number };

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function buildCues(story: StoryJson, title = "code ad") {
  const D = story.duration;
  const beats = story.codead.beats;
  const BPM = 118, BEAT = 60 / BPM, E8 = BEAT / 2;
  // the hook is foley only: the music drops in on the second beat (ED Studio: on "Congratulations")
  const IN = Math.max(0.5, (beats[1]?.t0 ?? 1.5) - 0.02);
  const chords: Array<[number, string]> = [];
  const prog = [["F", "C", "Dm", "Bb"], ["Dm", "Bb", "F", "C"]];
  const last = beats[beats.length - 1];
  let cur = IN, cyc = 0;
  while (cur < D - 2.5) {
    const seq = cur < (last?.t0 ?? D) ? prog[Math.floor(cyc / 2) % 2] : ["Bb", "C", "F", "F"];
    for (const sym of seq) {
      if (cur >= D - 2.5) break;
      chords.push([r3(cur), sym]);
      cur += 2 * BEAT;
    }
    cyc++;
  }
  chords.push([r3(cur), "F"]);
  const sections = [{ t0: IN, t1: D, style: "ostinato", inst: "mallet", step: E8, pattern: [0, 2, 1, 2, 4, 2, 1, 2], vel: [[IN, 0.26], [(IN + D) / 2, 0.3], [D, 0.32]], len: 0.85, bass_every: 4, bass_vel: 0.7 }];
  const mallet: Array<[number, number, number, number]> = [];
  for (const c of story.callouts) {
    const a = c.t0 + 0.02;
    if (a < IN) continue;
    if (c.style === "term") mallet.push([r3(a), 77, 0.36, 0.18], [r3(a + 0.09), 81, 0.36, 0.18], [r3(a + 0.18), 84, 0.4, 0.4]);
    else if (c.style === "money" || c.style === "label") mallet.push([r3(a), 72, 0.3, 0.16], [r3(a + 0.1), 77, 0.32, 0.3]);
    else if (c.style === "stamp") mallet.push([r3(a), 70, 0.3, 0.14], [r3(a + 0.12), 65, 0.3, 0.3]);
  }
  const pad = [{ t0: IN, t1: D - 0.2, notes: [29, 41, 48, 53, 57], level: 0.42, attack: 0.3, release: 0.8, cutoff: 900, hp: 30 }];
  const booms = [IN, ...beats.filter((b) => ["explode", "bury", "deliver", "celebrate"].includes(b.gag)).map((b) => b.hit)];
  const drums = booms.filter((b) => b >= IN - 0.05).map((b) => [r3(b), 0.42, "boom"] as [number, number, string]);
  const music = {
    gain_db: 0.0, reverb_db: -12.0, pad_db: -5.0, pad_reverb_db: -6.0, mallet_db: 0.0, drums_db: -9.0, instrument: "piano",
    leveler: { thr_rel_db: 4.0, ratio: 2.0, tau: 0.3 }, end: D, chords, sections, melody: [], mallet_melody: mallet.sort((a, b) => a[0] - b[0]), pad, drums,
    drum_patterns: [{ t0: IN + 0.02, t1: Math.max(IN + 0.5, D - 1.0), step: BEAT, pattern: [1, 0, 0.55, 0], vel: 0.12, kind: "taiko" }],
  };

  // ---- foley, from the gags (soft and low-passed, ED Studio synth.py §6b)
  const ev: Event[] = [];
  const e = (t: number, sound: string, gain_db: number, pan = 0, args?: Record<string, number>) => ev.push({ t: r3(Math.max(0, Math.min(D - 0.05, t))), sound, gain_db, pan, ...(args ? { args } : {}) });
  for (const b of beats) {
    const h = b.hit;
    switch (b.gag) {
      case "hack":
        e(b.s0 + 0.05, "keyboard_type", -19, -0.05, { dur: Math.max(0.6, Math.min(3.5, b.s1 - b.s0)), rate: 12 });
        e(h, "knock", -22, 0.1, { pitch: 1.6 });
        break;
      case "explode":
        e(Math.max(b.s0, h - 1.0), "keyboard_type", -21, -0.05, { dur: 0.9, rate: 13 });
        e(h - 0.02, "whoomp", -10, 0, { size: 1.2 });
        e(h, "glass_crack", -18, 0.15, { dur: 0.6, n_pings: 4 });
        e(h + 0.05, "crumble", -16, 0, { dur: 0.9, size: 0.6 });
        e(h + 0.1, "hiss", -26, 0.1, { dur: 1.6 });
        e(h + 0.35, "plush_squeak", -21, 0, { pitch: 0.75 });
        break;
      case "bury":
        e(h - 0.45, "low_swell", -22, 0, { dur: 0.6, pitch: 1.3 });
        e(h, "crumble", -12, 0, { dur: 1.2, size: 1.1 });
        for (let k = 0; k < 8; k++) e(h + 0.04 + k * 0.07, "knock", -18 - (k % 3), -0.4 + k * 0.1, { pitch: 0.8 + 0.08 * (k % 4) });
        e(h + 0.15, "bonk", -14, 0);
        e(h + 0.55, "plush_squeak", -21, 0, { pitch: 0.9 });
        break;
      case "zap":
        e(h, "zap", -12, 0.2, { dur: 0.6 });
        e(h + 0.02, "zap", -18, -0.2, { dur: 0.45 });
        e(h + 0.62, "plush_squeak", -21, 0.1, { pitch: 1.4 });
        break;
      case "money":
        e(h - 0.05, "pop", -15, 0, { pitch: 0.8 });
        for (let k = 0; k < 6; k++) e(h + k * 0.24, "blanket_rustle", -21, -0.3 + k * 0.12, { dur: 0.35, intensity: 0.9 });
        e(h + 0.1, "slurp", -22, 0, { dur: 0.5 });
        break;
      case "deliver":
        e(h - 0.5, "whoosh_timeskip", -20, 0.3, { pre: 0.45, post: 0.1 });
        e(h, "giant_step", -12, 0.3, { size: 1.0 });
        e(h + 0.01, "clunk", -14, 0.3, { size: 0.9, metal: 0.3 });
        e(h + 0.06, "crumble", -21, 0.3, { dur: 0.5, size: 0.4 });
        e(h + 0.5, "wood_snap", -15, 0.3, { size: 0.7 });
        e(h + 0.55, "pop", -13, 0.3, { pitch: 1.0 });
        e(h + 0.62, "pop", -17, 0.25, { pitch: 1.5 });
        e(h + 1.2, "knock", -20, 0.2, { pitch: 1.2 });
        break;
      case "team":
        b.labels.slice(0, 5).forEach((_, j) => {
          e(h - 0.25 + j * 0.32, "pop", -14 - j, -0.4 + j * 0.2, { pitch: 1.0 + 0.15 * j });
          e(h - 0.22 + j * 0.32, "scan_beep", -24, -0.4 + j * 0.2, { pitch: 1.0 + 0.1 * j });
        });
        break;
      case "approve":
        e(b.t0 + 0.05, "pop", -16, -0.2, { pitch: 0.9 });
        e(h - 0.02, "knock", -14, -0.2, { pitch: 0.7 });
        e(h, "clunk", -13, -0.2, { size: 0.7, metal: 0.6 });
        e(h + 0.05, "alarm_beep", -24, -0.2, { dur: 0.5, n: 2, pitch: 1.2 });
        break;
      case "show":
        e(Math.max(b.t0, h - 0.3), "low_swell", -21, 0, { dur: 1.0, pitch: 1.4 });
        e(h, "pop", -17, 0, { pitch: 1.3 });
        break;
      case "celebrate":
        e(h, "pop", -12, -0.4, { pitch: 1.1 });
        e(h + 0.12, "pop", -13, 0.4, { pitch: 1.3 });
        e(h + 0.3, "gold_chime", -21, 0);
        break;
      default:
        break;
    }
  }
  // the agents' robots hum as they roam (a soft fan bed once the first one is out)
  const firstAgent = beats.find((b) => b.gag === "deliver" || b.gag === "team");
  const amb: Bed[] = [
    { sound: "room_tone", t0: 0, t1: D, fade_in: 0.2, fade_out: 0.5, gain_db: -40, seed: 1 },
    { sound: "city_day", t0: 0, t1: D, fade_in: 0.3, fade_out: 0.6, gain_db: -38, args: { murmur: 0.2, traffic: 0.4 }, seed: 2 },
    ...(firstAgent ? [{ sound: "fan", t0: firstAgent.hit + 0.6, t1: D, fade_in: 0.8, fade_out: 0.6, gain_db: -36, args: { rate: 14 }, seed: 3 }] : []),
  ];
  // each scene sounds like where it is: a keynote's room murmur and the applause on the payoff, the gym's clanking
  // plates under fluorescent hum, water and the city below a rooftop pool, a basement's drone under a versus ad
  const scene = story.codead.scene, cheer = beats.find((b) => b.gag === "celebrate" && b.who !== "rival");
  if (scene === "stage") {
    amb.push({ sound: "crowd_cheer", t0: 0, t1: D, fade_in: 0.3, fade_out: 0.6, gain_db: -46, args: { excite: 0.15 }, seed: 4 });
    if (cheer) {
      amb.push({ sound: "applause", t0: cheer.hit, t1: D, fade_in: 0.15, fade_out: 0.8, gain_db: -27, args: { density: 55, swell: 0.4 }, seed: 5 });
      amb.push({ sound: "crowd_cheer", t0: cheer.hit + 0.05, t1: D, fade_in: 0.2, fade_out: 0.8, gain_db: -31, args: { excite: 0.9 }, seed: 6 });
    }
  } else if (scene === "gym") {
    amb.push({ sound: "lamp_hum", t0: 0, t1: D, fade_in: 0.2, fade_out: 0.5, gain_db: -46, seed: 4 });
    for (let t = 1.3, k = 0; t < D - 1; t += 2.6 + (k % 3) * 0.45, k++) e(t, "metal_clang", -33 - (k % 2) * 3, k % 2 ? 0.55 : -0.55, { size: 0.6 + (k % 3) * 0.15, pitch: 1.2 + (k % 2) * 0.2, dur: 0.6 });
  } else if (scene === "rooftop") {
    amb.push({ sound: "surf", t0: 0, t1: D, fade_in: 0.4, fade_out: 0.6, gain_db: -42, args: { size: 0.3 }, seed: 4 });
  } else if (scene === "versus") {
    amb.push({ sound: "cabin_hum", t0: 0, t1: D, fade_in: 0.3, fade_out: 0.6, gain_db: -46, seed: 4 });
  }
  return {
    title: `${title} (Nomen code ad: WORKSHOP marimba groove + construction foley + narrator)`,
    duration: D,
    target_lufs: -14.0,
    limiter_ceiling_dbtp: -1.5,
    end_fade: [r3(D - 0.35), D],
    stem_gain_db: { music: -8.0, sfx: 5.0, amb: 5.0, voice: 0.0 },
    stem_dynamics: { music: { limit_dbfs: -6.0, lim_win: 0.015 }, sfx: { comp_thr_dbfs: -14.0, ratio: 2.5, win: 0.004, limit_dbfs: -5.0 }, voice: { comp_thr_dbfs: -10.0, ratio: 3.0, win: 0.006, limit_dbfs: -2.5 } },
    sfx_lowpass_hz: 5200,
    voice: { file: "voice.wav", gain_db: 0.0, duck_db: -9.0, amb_duck_db: -5.0, presence_db: 2.0, hp: 75 },
    shots: [...story.order.map((id) => story.beats[id].t0), D],
    music,
    ambience: amb,
    events: ev.sort((a, b) => a.t - b.t),
  };
}
