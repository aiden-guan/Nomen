#!/usr/bin/env node
// naive-guard: runs this repo's pinned Naive CLI with guard rails, so Naive cannot overwrite
// work in this repository or touch Naive resources that Nomen does not own.
//
//   npm run naive -- <naive command>   e.g. npm run naive -- whoami
//   npm run naive:plan                 naive up --dry-run (reads only, changes nothing)
//   npm run naive:apply                prints the dry-run, then asks before the real naive up
//
// What it refuses, and why (checked against @usenaive-sdk/cli 1.0.3; see docs/naive.md):
//   --force    `naive init --force` overwrites naive.config.ts.
//   --adopt    `naive up --adopt` takes over apps another project owns and replaces their live site.
//   template   `naive template` clones a whole Naive company repo; it must land outside this repo.
//   --out      a download may not replace a file that already exists.
//   --api-key, --key on the command line: the key would end up in shell history.
//   names      every agent, app, skill, vault and identity in naive.config.ts, and every name under
//              `removed`, must start with "nomen-". `naive up` matches resources by name across the
//              whole Naive organization; the prefix keeps it to Nomen's own.
//   tasks      `tasks` makes `naive up` create or edit the organization's CEO agent.
//   real up    needs a clean git tree (what is live is always a commit), prints the dry-run first,
//              and waits for you to type "apply".
//
// To do something it refuses, run the CLI directly (npx naive ...) as a deliberate choice.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

const PREFIX = "nomen-";
// Global flags that take a value, so the value is never mistaken for the command name.
const VALUE_FLAGS = new Set(["--org", "--api-key", "--profile", "--api-base-url"]);

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`Usage: npm run naive -- <naive command>   e.g. npm run naive -- whoami
       npm run naive:plan    preview naive.config.ts against Naive (changes nothing)
       npm run naive:apply   preview, then apply after you type "apply"
See docs/naive.md.`);
  process.exit(0);
}

const repoRoot = git(["rev-parse", "--show-toplevel"])?.trim();
if (!repoRoot) refuse("this is not inside the nomen git repository.");

const [command, ...rest] = positionals();

if (has("--api-key") || has("--key")) {
  refuse(
    "an API key on the command line ends up in your shell history.",
    "pipe it from a file: npm run naive -- claim < key.txt (key.txt is gitignored).",
  );
}
if (has("--force")) {
  refuse("--force lets naive overwrite files (naive init --force replaces naive.config.ts).", "edit naive.config.ts by hand.");
}
if (has("--adopt")) {
  refuse(
    "--adopt makes naive up take over apps another project owns and replace their live site.",
    `give the app its own name starting with "${PREFIX}".`,
  );
}
if (command === "template") {
  const dir = valueOf("--dir") ?? rest[0];
  if (!dir || insideRepo(dir)) {
    refuse(
      "naive template would clone a whole Naive company repo inside Nomen.",
      `clone it next to this repo by adding --dir ../${rest[0] ?? "<blueprint>"}`,
    );
  }
}
for (const flag of ["--out", "-o"]) {
  const target = valueOf(flag);
  if (target && existsSync(target)) refuse(`${target} already exists and ${flag} would overwrite it.`, "choose a new file name.");
}

if (command === "up") {
  await checkConfig(valueOf("--dir") ?? ".");
  if (!has("--dry-run")) {
    if (status() !== "") {
      refuse("you have uncommitted changes; what you apply should be a commit you can return to.", "commit, then run npm run naive:apply again.");
    }
    const planned = run([...args, "--dry-run"]);
    if (planned !== 0) process.exit(planned);
    await confirmApply();
  }
}

const before = status();
const code = run(args);
reportChanges(before);
process.exit(code);

function refuse(why, instead) {
  console.error(`naive-guard: refused: ${why}`);
  if (instead) console.error(`naive-guard: instead, ${instead}`);
  process.exit(2);
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function status() {
  return git(["status", "--porcelain", "--untracked-files=all"]) ?? "";
}

function has(flag) {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function valueOf(flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

function positionals() {
  const found = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith("-")) found.push(args[i]);
  }
  return found;
}

// Resolves symlinks on the part of the path that exists, so /tmp vs /private/tmp style
// aliases cannot make a path inside the repo look like it is outside.
function realish(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...tail);
}

function insideRepo(path) {
  const rel = relative(realpathSync(repoRoot), realish(path));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function checkConfig(dir) {
  let loadConfig;
  try {
    ({ loadConfig } = await import("@usenaive-sdk/blueprints"));
  } catch {
    refuse("the Naive packages are not installed.", "run npm install.");
  }
  const load = await loadConfig(resolve(dir));
  if (!load.ok) return; // The CLI reports a missing or invalid config in its own words.
  const config = load.config;
  const names = [
    ...config.agents.map((agent) => ["agent", agent.name]),
    ...config.apps.map((app) => ["app", app.name]),
    ...config.skills.map((skill) => ["skill", skill.slug]),
    ...config.vaults.map((vault) => ["vault", vault.name]),
    ...config.identities.map((identity) => ["identity", identity.name]),
    ...Object.entries(config.removed).flatMap(([kind, list]) => list.map((name) => [`removed ${kind}`, name])),
  ];
  const outside = names.filter(([, name]) => !name.startsWith(PREFIX));
  if (outside.length > 0) {
    refuse(
      `these names in naive.config.ts do not start with "${PREFIX}": ${outside.map(([kind, name]) => `${kind} "${name}"`).join(", ")}.`,
      `rename them so naive up only creates, changes or deletes Nomen's own resources.`,
    );
  }
  if (config.tasks.length > 0) {
    refuse(
      "naive.config.ts declares tasks, which makes naive up create or edit the organization's CEO agent.",
      "remove tasks, or run npx naive up directly if you mean it.",
    );
  }
}

function run(cliArgs) {
  const manifest = join(repoRoot, "node_modules", "@usenaive-sdk", "cli", "package.json");
  if (!existsSync(manifest)) refuse("the Naive CLI is not installed.", "run npm install.");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const entry = join(dirname(manifest), typeof bin === "string" ? bin : bin.naive);
  const result = spawnSync(process.execPath, [entry, ...cliArgs], { stdio: "inherit" });
  return result.status ?? 1;
}

async function confirmApply() {
  if (process.env.NAIVE_GUARD_CONFIRM === "apply") return;
  if (!process.stdin.isTTY) {
    refuse("this is not a terminal, so nobody can confirm the apply.", "after a person has read the dry-run above, re-run with NAIVE_GUARD_CONFIRM=apply.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await prompt.question('\nAbove is the dry-run. Applying it can create agents that spend credits.\nType "apply" to apply it: ');
  prompt.close();
  if (answer.trim() !== "apply") {
    console.error("naive-guard: nothing was applied.");
    process.exit(1);
  }
}

function reportChanges(before) {
  const after = status();
  if (after === before) {
    console.error("naive-guard: git status shows no new changes in this repo.");
    return;
  }
  const seen = new Set(before.split("\n"));
  const changed = after.split("\n").filter((line) => line !== "" && !seen.has(line));
  console.error(
    `naive-guard: this command changed files in the repo:\n${changed.map((line) => `  ${line}`).join("\n")}\n` +
      "naive-guard: review with git diff; undo with git restore <file>, or delete a new file.",
  );
}
