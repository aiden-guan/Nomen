// The code ads' sets. Each builder returns { root, stations: { hero, rival? }, update(t), wide?(yaw), end?(yaw), cheer?(t, k) }:
// a station is where one character works (feet x/y/z, the work surface's height `top`, the laptop, the button, the power
// strip, the crate's landing spot, the robots' orbit, where purchases land, the big screen it shows, optional framing
// overrides `frames(base, head, screen)`, a pose hook `pose(p, t, gag)` and props to `attach(toon)`). Heights in a
// station are above its floor `y`; x/z are the world's. See engine/codead.js.
//   office   the dev office (a standing desk under a wall screen)
//   stage    a launch keynote: a giant LED wall, spotlights, an audience
//   gym      a weight room: he curls a dumbbell while he types
//   rooftop  a rooftop pool at golden hour
//   versus   two floors: the rival's basement under the lead's penthouse
import { buildDevOffice } from './devoffice.js';
import { buildVersus } from './versus.js';
import { buildStage } from './stage.js';
import { buildGym } from './gym.js';
import { buildRooftop } from './rooftop.js';

export const SETS = { office: buildDevOffice, stage: buildStage, gym: buildGym, rooftop: buildRooftop, versus: buildVersus };
