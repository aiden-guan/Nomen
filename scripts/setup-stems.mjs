// Sets up the optional stem splitter for one-to-one remakes: a Python virtual environment with
// Demucs in data/tools/stems (data/ is gitignored). With it, a remake keeps the reference's music
// and sound effects under our voice; without it, the voice is isolated by ElevenLabs and the remake
// has no music bed. Run it once per machine:
//
//   npm run setup:stems            (creates the venv, installs Demucs, fetches its model once)
//   npm run setup:stems -- --no-warm   (skips the model download)
//
// A Python elsewhere can be used instead: set NOMEN_STEMS_PYTHON to a python that can `import demucs`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const venv = join(process.cwd(), "data", "tools", "stems");
const python = join(venv, "bin", "python");
const warm = !process.argv.includes("--no-warm");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
}

function findPython() {
  for (const candidate of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    try {
      const version = execFileSync(candidate, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).toString().trim();
      const [major, minor] = version.split(".").map(Number);
      if (major === 3 && minor >= 9) return { bin: candidate, version };
      console.log(`${candidate} is Python ${version}; Demucs needs 3.9 or newer`);
    } catch {
      // not installed under this name
    }
  }
  return null;
}

/** One second of silence as a 16-bit mono WAV, to make Demucs fetch its model now rather than mid-remake. */
function silence(path) {
  const rate = 44100;
  const data = Buffer.alloc(rate * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

try {
  if (!existsSync(python)) {
    const found = findPython();
    if (!found) throw new Error("No Python 3.9+ found. Install one (macOS: brew install python) or set PYTHON=/path/to/python3.");
    console.log(`Creating ${venv} with Python ${found.version}`);
    mkdirSync(join(venv, ".."), { recursive: true });
    run(found.bin, ["-m", "venv", venv]);
  }
  console.log("Installing Demucs (and PyTorch with it; this takes a few minutes the first time)");
  run(python, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  run(python, ["-m", "pip", "install", "--quiet", "demucs", "soundfile"]);
  run(python, ["-c", "import demucs, soundfile; print('demucs', demucs.__version__)"]);
  if (warm) {
    console.log("Fetching the htdemucs model once (about 80 MB)");
    const dir = mkdtempSync(join(tmpdir(), "nomen-stems-"));
    try {
      silence(join(dir, "silence.wav"));
      run(python, ["-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", join(dir, "out"), join(dir, "silence.wav")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`Stems are set up: remakes will keep the reference's music and effects (${python}).`);
} catch (error) {
  console.error(`Stem setup failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Remakes still work without it: the voice is isolated by ElevenLabs and there is no music bed.");
  process.exit(1);
}
