// Prepares public/ for the edit after a new film: the still the edit holds on at the creators step
// (the film's frame where Demo.tsx pauses), cut from the plate with ffmpeg. Run: node prepare.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpeg = require("../node_modules/ffmpeg-static");
const log = JSON.parse(readFileSync("public/plate.json", "utf8"));
const creators = log.steps.find((s) => s.key === "creators");
if (!creators) throw new Error("The film has no creators step.");
// Keep in step with FREEZE_AT in src/Demo.tsx.
const frame = creators.frame + 15;
execFileSync(ffmpeg, ["-v", "error", "-y", "-i", "public/plate.mp4", "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "public/freeze.png"]);
console.log(`public/freeze.png: the film's frame ${frame}`);
