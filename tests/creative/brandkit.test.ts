import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteAssetRoute, GET as getKitRoute, POST as uploadRoute } from "@/app/api/brands/[id]/brandkit/route";
import { GET as fileRoute } from "@/app/api/brands/[id]/brandkit/file/route";
import { DELETE as forgetRepoRoute, POST as scanRoute } from "@/app/api/brands/[id]/brandkit/repo/route";
import {
  MAX_ASSETS,
  MAX_FILE_BYTES,
  addUploadedFiles,
  assetPath,
  captionAssets,
  classifyAsset,
  cleanRelativePath,
  getBrandKit,
  gitRunner,
  isCaptioning,
  parseColor,
  resolveRepoSource,
  svgSize,
} from "@/lib/creative/brandkit";
import type { BrandKit } from "@/lib/creative/types";
import { db, now } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { ffmpegPath } from "@/lib/media";
import { QC_MODEL } from "@/lib/qc";

// ---------- tiny real image files ----------

/** A real (tiny, black) PNG of the given size. */
function png(width: number, height: number) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  const rows = Buffer.alloc((width + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A JPEG header with a SOF0 marker: enough for the size reader (not decodable). */
function jpeg(width: number, height: number) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(200, 0x11), Buffer.from([0xff, 0xd9])]);
}

const ico = () => Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 32, 32, 0, 0, 1, 0, 32, 0]), Buffer.alloc(300, 3)]);
const svg = (label: string, extra = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"${extra}><rect width="120" height="40" fill="#6D28D9"/><text x="10" y="28" fill="#ffffff">${label}</text></svg>`);

// ---------- the fixture repo ----------

async function write(root: string, rel: string, content: string | Buffer) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

async function buildFixtureRepo(root: string) {
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "acme-cloud", description: "Deploy AI agents in one command.", bin: { acme: "bin/acme.js" }, dependencies: { next: "16.0.0", "@fontsource/space-grotesk": "5.0.0" } }, null, 2),
  );
  await write(root, "package-lock.json", JSON.stringify({ name: "acme-cloud", lockfileVersion: 3 }));
  await write(
    root,
    "README.md",
    [
      "# Acme Cloud",
      "",
      "[![build](https://img.shields.io/badge/build-passing-green.svg)](https://ci.example.com)",
      "",
      "Acme Cloud runs your AI agents on managed infrastructure.",
      "",
      "![The dashboard](docs/screenshot-dashboard.png)",
      "",
      "## Install",
      "",
      "```bash",
      "npx acme-cloud init",
      "npm i -g acme-cloud",
      "# then deploy",
      "acme deploy --prod",
      "npm run dev",
      "cd my-project",
      "```",
      "",
      "```sh",
      "curl -fsSL https://acme.dev/install.sh | sh",
      "```",
      "",
      "```",
      "$ pip install acme-cloud",
      "```",
      "",
      "```ts",
      "const client = new Acme();",
      "```",
    ].join("\n"),
  );
  await write(
    root,
    "tailwind.config.ts",
    `import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.tsx"],
  theme: {
    extend: {
      // brand colors
      colors: {
        brand: { DEFAULT: "#6D28D9", 500: "#8B5CF6", light: "rgb(237, 233, 254)" },
        ink: "#0B0B12",
        accent: "hsl(var(--accent))",
      },
      fontFamily: { display: ["Space Grotesk", "sans-serif"] },
    },
  },
} satisfies Config;
`,
  );
  await write(
    root,
    "app/globals.css",
    `:root {
  --primary: 262 83% 58%;
  --accent: 172 66% 50%;
  --radius: 0.5rem;
  --font-body: "Inter", system-ui;
}
.dark { --primary: 0 0% 100%; }
body { font-family: "Inter", sans-serif; background: var(--background); }
.btn { background: hsl(var(--primary)); }
`,
  );
  await write(
    root,
    "app/layout.tsx",
    `import { Inter, JetBrains_Mono } from "next/font/google";
const inter = Inter({ subsets: ["latin"] });
const mono = JetBrains_Mono({ subsets: ["latin"] });
export const metadata = { title: "Acme Cloud" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body className={inter.className}>{children}</body></html>;
}
`,
  );
  await write(
    root,
    "app/page.tsx",
    `import { Hero } from "@/components/Hero";
export default function Home() {
  return (
    <main className="bg-ink text-white">
      <Hero />
      <h2 className="text-brand">Agents that ship themselves</h2>
      <input placeholder="you@company.com" className="border-brand" />
      <button className="bg-brand text-white" onClick={() => track("start")}>Start free</button>
    </main>
  );
}
`,
  );
  await write(
    root,
    "app/(marketing)/pricing/page.tsx",
    `export default function Pricing() {
  return (
    <section className="bg-brand-500">
      <h1 className="text-4xl">Simple pricing for every team</h1>
      <p>Pay only for what your agents use.</p>
      <button className="bg-brand">Choose Pro</button>
      <a href="/contact" className="text-brand">Talk to sales</a>
    </section>
  );
}
`,
  );
  await write(
    root,
    "components/Hero.tsx",
    `import { Button } from "./ui/button";

export function Hero() {
  const items: Array<string> = [];
  return (
    <section className="flex flex-col items-center gap-6 bg-ink py-24">
      <h1 className="text-6xl font-bold text-white">Ship faster with Acme</h1>
      <p className="text-brand-500">Deploy an agent in one command.</p>
      <div className="rounded-xl bg-brand px-4 py-2 font-mono">npx acme-cloud init</div>
      <Button className="bg-brand">Get started</Button>
    </section>
  );
}
`,
  );
  await write(root, "components/helpers.ts", `export const twice = (n: number) => n * 2;\n`);
  await write(root, "components/Hero.test.tsx", `it("renders", () => render(<h1>Test only heading</h1>));\n`);
  await write(root, "public/logo.svg", svg("Acme"));
  await write(root, "public/next.svg", svg("Next.js boilerplate", ' data-x="next"'));
  await write(root, "public/favicon.ico", ico());
  await write(root, "public/fonts/Inter-Bold.woff2", Buffer.alloc(2000, 7));
  await write(root, "public/demo.mp4", Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(500, 9)]));
  await write(root, "docs/screenshot-dashboard.png", png(1280, 800));
  await write(root, "docs/architecture.png", png(1400, 800));
  await write(root, "tests/fixture-logo.png", png(300, 100));
  // everything below must be skipped
  await write(root, "node_modules/evil/package.json", JSON.stringify({ name: "evil", bin: "x.js" }));
  await write(root, "node_modules/evil/logo.svg", svg("Evil"));
  await write(root, "node_modules/evil/Hero.tsx", `export const X = () => <h1>Evil string from node_modules</h1>;\n`);
  await write(root, ".next/static/media/logo.png", png(200, 60));
  await symlink("/etc/hosts", join(root, "public", "linked-logo.svg"));
  await symlink("/etc", join(root, "public", "linked-dir"));
}

// ---------- setup ----------

const BRAND = "brd_acme";
let kitRoot: string;
let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "nomen-fixture-repo-"));
  await buildFixtureRepo(fixtureRoot);
});

beforeEach(async () => {
  kitRoot = await mkdtemp(join(tmpdir(), "nomen-brandkits-"));
  vi.stubEnv("NOMEN_BRANDKITS_DIR", kitRoot);
  vi.stubEnv("NAIVE_API_KEY", "");
  const conn = db();
  conn.exec("delete from settings; delete from events; delete from brands;");
  conn.prepare("insert into brands (id, name, domain, url, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(BRAND, "Acme", "acme.dev", "https://acme.dev", now(), now());
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ctx = (id = BRAND) => ({ params: Promise.resolve({ id }) });
const scan = (source: string, id = BRAND) => scanRoute(new Request(`http://localhost/api/brands/${id}/brandkit/repo`, { method: "POST", body: JSON.stringify({ source }) }), ctx(id));
const upload = (files: Array<[string, Buffer]>, id = BRAND) => {
  const form = new FormData();
  for (const [name, bytes] of files) form.append("files", new File([new Uint8Array(bytes)], name));
  return uploadRoute(new Request(`http://localhost/api/brands/${id}/brandkit`, { method: "POST", body: form }), ctx(id));
};
const getFile = (asset: string, id = BRAND, headers: Record<string, string> = {}) => fileRoute(new Request(`http://localhost/api/brands/${id}/brandkit/file?asset=${encodeURIComponent(asset)}`, { headers }), ctx(id));
type KitBody = BrandKit & { captioning: boolean; added?: string[]; skipped?: Array<{ name: string; reason: string }>; error?: string };
const json = async (response: Response) => (await response.json()) as KitBody;
const bySource = (kit: BrandKit, source: string) => kit.assets.find((asset) => asset.source === source);

// ---------- repo scan ----------

describe("repo scan (local folder, through the route)", () => {
  it("pulls brand assets and product facts out of the code without running it", async () => {
    const response = await scan(fixtureRoot);
    expect(response.status).toBe(200);
    const kit = await json(response);
    const repo = kit.repo!;
    expect(repo.origin).toBe(`local:${realpathSync(fixtureRoot)}`);
    expect(repo.name).toBe("Acme Cloud");
    expect(repo.description).toBe("Deploy AI agents in one command.");
    expect(repo.readme.startsWith("# Acme Cloud")).toBe(true);

    // colors: Tailwind config, CSS variables (HSL triplets converted), aliases resolved, most used first
    const colors = Object.fromEntries(repo.colors.map((c) => [c.name, c.hex]));
    expect(repo.colors[0]).toMatchObject({ name: "brand", hex: "#6d28d9", source: "tailwind.config.ts" });
    expect(colors["brand-500"]).toBe("#8b5cf6");
    expect(colors["brand-light"]).toBe("#ede9fe");
    expect(colors.ink).toBe("#0b0b12");
    expect(colors.primary).toBe("#7c3bed");
    expect(colors.accent).toBe(parseColor("hsl(172 66% 50%)"));
    expect(Object.keys(colors)).not.toContain("radius");
    expect(repo.colors.length).toBeLessThanOrEqual(12);

    // fonts: CSS font-family, next/font imports, Tailwind fontFamily and @fontsource deps
    expect(repo.fonts[0]).toBe("Inter");
    expect(repo.fonts).toEqual(expect.arrayContaining(["Inter", "JetBrains Mono", "Space Grotesk"]));

    // commands: shell blocks and $ lines, plus the package's bin; dev chores and code skipped
    expect(repo.commands).toEqual(["npx acme-cloud init", "npm i -g acme-cloud", "acme deploy --prod", "curl -fsSL https://acme.dev/install.sh | sh", "pip install acme-cloud", "npx acme-cloud"]);

    // screens: Next.js app routes (route groups dropped), home first, with a summary from the page
    expect(repo.screens.map((s) => s.route)).toEqual(["/", "/pricing"]);
    expect(repo.screens[0]).toMatchObject({ file: "app/page.tsx" });
    expect(repo.screens[0].summary).toContain("Agents that ship themselves");
    expect(repo.screens[0].summary).toContain('"Start free"');
    expect(repo.screens[1].summary).toContain("Simple pricing for every team");
    expect(repo.screens[1].file).toBe("app/(marketing)/pricing/page.tsx");

    // components: the hero, with its markup
    const hero = repo.components.find((c) => c.name === "Hero");
    expect(hero?.file).toBe("components/Hero.tsx");
    expect(hero?.excerpt).toContain('className="flex flex-col items-center gap-6 bg-ink py-24"');
    expect(hero?.excerpt).toContain("Ship faster with Acme");
    expect(hero?.excerpt).not.toContain("import");
    expect(repo.components.map((c) => c.name)).not.toContain("Helpers");

    // visible strings: headings first, then buttons and links, text and placeholders
    expect(repo.ui_strings.slice(0, 3)).toEqual(["Agents that ship themselves", "Simple pricing for every team", "Ship faster with Acme"]);
    expect(repo.ui_strings).toEqual(expect.arrayContaining(["Start free", "Choose Pro", "Talk to sales", "Get started", "Pay only for what your agents use.", "you@company.com"]));
    expect(repo.ui_strings.join("|")).not.toMatch(/Evil string|Test only heading|className|flex-col/);

    // assets copied in, classified, sized
    expect(bySource(kit, "repo:public/logo.svg")).toMatchObject({ kind: "logo", width: 120, height: 40 });
    expect(bySource(kit, "repo:docs/screenshot-dashboard.png")).toMatchObject({ kind: "screenshot", width: 1280, height: 800 });
    expect(bySource(kit, "repo:docs/architecture.png")).toMatchObject({ kind: "screenshot", width: 1400, height: 800 });
    expect(bySource(kit, "repo:public/favicon.ico")).toMatchObject({ kind: "icon", width: 32, height: 32 });
    expect(bySource(kit, "repo:public/fonts/Inter-Bold.woff2")).toMatchObject({ kind: "font", caption: "Inter Bold (font)" });
    expect(bySource(kit, "repo:public/demo.mp4")).toMatchObject({ kind: "video" });
    const sources = kit.assets.map((a) => a.source).join("|");
    expect(sources).not.toMatch(/node_modules|\.next|next\.svg|linked|tests\//);
    expect(kit.assets).toHaveLength(6);

    // the files really are in the kit, and nothing else is
    for (const asset of kit.assets) {
      expect(asset.path.startsWith(join(kitRoot, BRAND, "files"))).toBe(true);
      expect(existsSync(asset.path)).toBe(true);
    }
    expect(await readFile(bySource(kit, "repo:public/logo.svg")!.path)).toEqual(svg("Acme"));
    // the local folder is read in place, never modified or deleted
    expect(existsSync(join(fixtureRoot, "package.json"))).toBe(true);
  });

  it("replaces the previous scan's assets on a rescan (same bytes keep their ids) and forgets them on DELETE", async () => {
    await upload([["brand/wordmark.svg", svg("Upload")]]);
    const first = await json(await scan(fixtureRoot));
    const second = await json(await scan(fixtureRoot));
    expect(second.assets.map((a) => a.id).sort()).toEqual(first.assets.map((a) => a.id).sort());
    expect(second.assets).toHaveLength(7);

    const repoPaths = second.assets.filter((a) => a.source.startsWith("repo:")).map((a) => a.path);
    const forgotten = await json(await forgetRepoRoute(new Request("http://localhost/x", { method: "DELETE" }), ctx()));
    expect(forgotten.repo).toBeNull();
    expect(forgotten.assets.map((a) => a.source)).toEqual(["upload"]);
    for (const path of repoPaths) expect(existsSync(path)).toBe(false);
  });

  it("refuses a missing body, a relative path and a folder that isn't there", async () => {
    const empty = await scanRoute(new Request("http://localhost/x", { method: "POST", body: "{}" }), ctx());
    expect(empty.status).toBe(400);
    expect((await json(await scan("relative/folder"))).error).toMatch(/absolute folder path/);
    expect((await json(await scan("/definitely/not/a/folder/here"))).error).toMatch(/no folder/);
    expect((await scan(fixtureRoot, "brd_nope")).status).toBe(404);
  });
});

describe("repo links", () => {
  it("accepts only public https GitHub and GitLab links and builds the clone URL itself", async () => {
    await expect(resolveRepoSource("https://github.com/acme/cloud/tree/main/src")).resolves.toEqual({ kind: "remote", host: "github", url: "https://github.com/acme/cloud.git", origin: "github:acme/cloud" });
    await expect(resolveRepoSource("github.com/acme/cloud.git")).resolves.toMatchObject({ url: "https://github.com/acme/cloud.git" });
    await expect(resolveRepoSource("https://gitlab.com/group/sub/repo/-/tree/main")).resolves.toMatchObject({ url: "https://gitlab.com/group/sub/repo.git", origin: "gitlab:group/sub/repo" });

    await expect(resolveRepoSource("https://example.com/acme/cloud")).rejects.toThrow(/Only GitHub and GitLab/);
    await expect(resolveRepoSource("https://github.com.evil.dev/acme/cloud")).rejects.toThrow(/Only GitHub and GitLab/);
    await expect(resolveRepoSource("http://github.com/acme/cloud")).rejects.toThrow(/Only https/);
    await expect(resolveRepoSource("git@github.com:acme/cloud.git")).rejects.toThrow(/SSH/);
    await expect(resolveRepoSource("ssh://git@github.com/acme/cloud")).rejects.toThrow(/Only https/);
    await expect(resolveRepoSource("https://github.com/acme")).rejects.toThrow(/Link to a repository/);
    await expect(resolveRepoSource("https://user:ghp_secret@github.com/acme/cloud")).rejects.toThrow(/token/);
    await expect(resolveRepoSource("https://github.com:8443/acme/cloud")).rejects.toThrow(/port/);
    await expect(resolveRepoSource("https://github.com/acme/..")).rejects.toThrow();
    await expect(resolveRepoSource("/")).rejects.toThrow(/too broad/);
  });

  it("never runs git for a refused link", async () => {
    const run = vi.spyOn(gitRunner, "run");
    const response = await scan("https://example.com/acme/cloud");
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatch(/Only GitHub and GitLab repositories can be linked/);
    expect(run).not.toHaveBeenCalled();
  });

  it("shallow-clones a public repo with no prompts, scans it and deletes the clone", async () => {
    let cloneDir = "";
    const run = vi.spyOn(gitRunner, "run").mockImplementation(async (args) => {
      cloneDir = args.at(-1)!;
      await cp(fixtureRoot, cloneDir, { recursive: true, verbatimSymlinks: true });
      return { stdout: "", stderr: "" };
    });
    const response = await scan("https://github.com/acme/cloud");
    expect(response.status).toBe(200);
    const kit = await json(response);
    expect(kit.repo?.origin).toBe("github:acme/cloud");
    expect(kit.repo?.commands).toContain("npx acme-cloud init");
    expect(bySource(kit, "repo:public/logo.svg")?.kind).toBe("logo");

    const [args, options] = run.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(["clone", "--depth", "1", "--single-branch", "--filter=blob:limit=25m", "https://github.com/acme/cloud.git"]));
    expect(args.indexOf("--")).toBe(args.length - 3);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.env).not.toHaveProperty("NAIVE_API_KEY");
    expect(options.timeout).toBeLessThanOrEqual(90_000);
    expect(existsSync(cloneDir)).toBe(false);
    expect(existsSync(dirname(cloneDir))).toBe(false);
  });

  it("explains that private repos aren't supported when the clone asks for credentials", async () => {
    vi.spyOn(gitRunner, "run").mockRejectedValue(Object.assign(new Error("Command failed: git clone"), { code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }));
    const response = await scan("https://github.com/acme/secret");
    expect(response.status).toBe(422);
    expect((await json(response)).error).toMatch(/private.*Only public repositories/);
    expect(getBrandKit(BRAND).repo).toBeNull();
  });

  it("gives up on a slow clone", async () => {
    vi.spyOn(gitRunner, "run").mockRejectedValue(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", stderr: "" }));
    const response = await scan("https://github.com/acme/huge");
    expect(response.status).toBe(504);
    expect((await json(response)).error).toMatch(/longer than 90 seconds/);
  });
});

// ---------- uploads ----------

describe("uploads", () => {
  it("classifies files and folders, skips duplicates, unsupported types and unsafe paths", async () => {
    const response = await upload([
      ["brand/mark.svg", svg("Mark")],
      ["Screens/app-home.png", png(1170, 2532)],
      ["icons/favicon-32.png", png(32, 32)],
      ["badge.png", png(64, 64)],
      ["product-photo.jpg", jpeg(2000, 1500)],
      ["clips/demo.mp4", Buffer.alloc(500, 1)],
      ["fonts/Brand Sans.woff2", Buffer.alloc(300, 2)],
      ["Brand Guidelines.pdf", Buffer.from("%PDF-1.4 brand guidelines")],
      ["../../etc/passwd", Buffer.from("root:x:0:0")],
      ["..\\..\\evil.png", png(10, 10)],
      ["/etc/hosts.png", png(11, 11)],
      ["tool.exe", Buffer.from("MZ")],
      [".DS_Store", Buffer.from("junk")],
      ["copy-of-mark.svg", svg("Mark")],
      ["empty.png", Buffer.alloc(0)],
    ]);
    expect(response.status).toBe(200);
    const kit = await json(response);
    const kinds = Object.fromEntries(kit.assets.map((a) => [a.path.split("/").pop()!.replace(/^a\d+-/, ""), a.kind]));
    expect(kinds).toEqual({
      "mark.svg": "logo",
      "app-home.png": "screenshot",
      "favicon-32.png": "icon",
      "badge.png": "icon",
      "product-photo.jpg": "image",
      "demo.mp4": "video",
      "Brand-Sans.woff2": "font",
      "Brand-Guidelines.pdf": "doc",
    });
    expect(kit.added).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    expect(kit.assets.every((a) => a.source === "upload")).toBe(true);
    expect(kit.assets.find((a) => a.kind === "image")).toMatchObject({ width: 2000, height: 1500 });
    expect(kit.assets.find((a) => a.kind === "doc")?.caption).toBe("Brand Guidelines (PDF)");

    const reasons = Object.fromEntries(kit.skipped!.map((s) => [s.name, s.reason]));
    expect(reasons["../../etc/passwd"]).toMatch(/unsafe path/);
    expect(reasons["..\\..\\evil.png"]).toMatch(/unsafe path/);
    expect(reasons["/etc/hosts.png"]).toMatch(/unsafe path/);
    expect(reasons["tool.exe"]).toMatch(/unsupported type/);
    expect(reasons[".DS_Store"]).toMatch(/hidden/);
    expect(reasons["copy-of-mark.svg"]).toBe("already in the kit (a1)");
    expect(reasons["empty.png"]).toBe("empty file");

    // only the eight kit files were written, all inside files/
    const written = await readdir(join(kitRoot, BRAND, "files"));
    expect(written).toHaveLength(8);
    for (const name of written) expect(name).toMatch(/^a\d+-[A-Za-z0-9_][A-Za-z0-9_.-]*\.[a-z0-9]+$/);
    expect((await readdir(kitRoot)).sort()).toEqual([BRAND]);
    expect(await readdir(join(kitRoot, BRAND))).toEqual(expect.arrayContaining(["files", "kit.json"]));

    // the same file again is a duplicate across requests too
    const again = await json(await upload([["logo-again.svg", svg("Mark")]]));
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual([{ name: "logo-again.svg", reason: "already in the kit (a1)" }]);
  });

  it("enforces the 25 MB file cap and the 60-asset kit cap", async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 1);
    const viaRoute = await json(await upload([["huge-demo.mp4", big]]));
    expect(viaRoute.skipped).toEqual([{ name: "huge-demo.mp4", reason: "too big (25 MB; the limit is 25 MB)" }]);
    const direct = await addUploadedFiles(BRAND, [{ name: "huge.png", bytes: big }]);
    expect(direct.skipped[0].reason).toMatch(/^too big/);

    const many = Array.from({ length: MAX_ASSETS + 1 }, (_, i) => ({ name: `logos/logo-${i}.svg`, bytes: svg(`Logo ${i}`) }));
    const result = await addUploadedFiles(BRAND, many);
    expect(result.added).toHaveLength(MAX_ASSETS);
    expect(result.skipped).toEqual([{ name: `logos/logo-${MAX_ASSETS}.svg`, reason: `the kit is full (${MAX_ASSETS} files); remove some first` }]);
    expect(getBrandKit(BRAND).assets).toHaveLength(MAX_ASSETS);
  });

  it("refuses a request that isn't multipart, and an unknown brand", async () => {
    const notForm = await uploadRoute(new Request("http://localhost/x", { method: "POST", body: "hello", headers: { "content-type": "text/plain" } }), ctx());
    expect(notForm.status).toBe(400);
    expect((await upload([["logo.svg", svg("X")]], "brd_nope")).status).toBe(404);
    expect(existsSync(join(kitRoot, "brd_nope"))).toBe(false);
  });

  it("removes an asset and its file", async () => {
    const kit = await json(await upload([["logo.svg", svg("A")], ["shot.png", png(400, 800)]]));
    const path = kit.assets[0].path;
    const response = await deleteAssetRoute(new Request("http://localhost/x?asset=a1", { method: "DELETE" }), ctx());
    expect(response.status).toBe(200);
    expect((await json(response)).assets.map((a) => a.id)).toEqual(["a2"]);
    expect(existsSync(path)).toBe(false);
    const missing = await deleteAssetRoute(new Request("http://localhost/x?asset=a1", { method: "DELETE" }), ctx());
    expect(missing.status).toBe(404);
    // ids are never reused
    expect((await json(await upload([["logo.svg", svg("A")]]))).added).toEqual(["a3"]);
  });

  it("GET returns an empty kit for a brand that gave us nothing", async () => {
    const response = await getKitRoute(new Request("http://localhost/x"), ctx());
    expect(await response.json()).toEqual({ brand_id: BRAND, updated_at: "", assets: [], repo: null, captioning: false });
    expect((await getKitRoute(new Request("http://localhost/x"), ctx("brd_nope"))).status).toBe(404);
  });
});

// ---------- serving files ----------

describe("file route", () => {
  it("serves kit files by id with the right type, and nothing else", async () => {
    await upload([["logo.svg", svg("Served")], ["shot.png", png(300, 600)]]);
    const ok = await getFile("a1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/svg+xml");
    expect(ok.headers.get("content-security-policy")).toContain("sandbox");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(svg("Served"));
    expect((await getFile("a2")).headers.get("content-type")).toBe("image/png");

    const partial = await getFile("a2", BRAND, { range: "bytes=0-7" });
    expect(partial.status).toBe(206);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(png(300, 600).subarray(0, 8));

    for (const bad of ["a99", "../kit.json", "a1/../../kit.json", "kit.json", "", "a1%00"]) expect((await getFile(bad)).status).toBe(404);
    expect((await getFile("a1", "brd_nope")).status).toBe(404);
    expect((await getFile("a1", "../brd_acme")).status).toBe(404);
  });

  it("never follows a tampered kit.json or a symlink out of the kit", async () => {
    await upload([["logo.svg", svg("Tamper")], ["shot.png", png(300, 600)]]);
    const kitFile = join(kitRoot, BRAND, "kit.json");
    const stored = JSON.parse(await readFile(kitFile, "utf8"));
    stored.assets[0].path = "/etc/passwd";
    await writeFile(kitFile, JSON.stringify(stored));
    expect(assetPath(BRAND, "a1")).toBeNull();
    expect((await getFile("a1")).status).toBe(404);

    const shot = stored.assets[1].path as string;
    await rm(shot);
    await symlink("/etc/hosts", shot);
    expect(assetPath(BRAND, "a2")).toBeNull();
    expect((await getFile("a2")).status).toBe(404);
  });
});

// ---------- classification and parsing ----------

describe("classification and parsing", () => {
  it("classifies by name, folder and size", () => {
    expect(classifyAsset("public/logo-dark.png", { width: 800, height: 200 })).toBe("logo");
    expect(classifyAsset("assets/wordmark.png")).toBe("logo");
    expect(classifyAsset("brand/symbol.svg")).toBe("logo");
    expect(classifyAsset("public/apple-touch-icon.png", { width: 180, height: 180 })).toBe("icon");
    expect(classifyAsset("img/check.svg", { width: 24, height: 24 })).toBe("icon");
    expect(classifyAsset("docs/Screenshot 2026-01-02.png", { width: 2880, height: 1800 })).toBe("screenshot");
    expect(classifyAsset("docs/flow.png", { width: 1600, height: 900 })).toBe("screenshot");
    expect(classifyAsset("public/hero-photo.jpg", { width: 1600, height: 900 })).toBe("image");
    expect(classifyAsset("bookmark.png", { width: 600, height: 400 })).toBe("image");
    expect(classifyAsset("a.webm")).toBe("video");
    expect(classifyAsset("a.otf")).toBe("font");
    expect(classifyAsset("guide.md")).toBe("doc");
    expect(classifyAsset("a.exe")).toBeNull();
  });

  it("cleans relative paths", () => {
    expect(cleanRelativePath("brand/./logos/logo.svg")).toEqual({ rel: "brand/logos/logo.svg" });
    expect(cleanRelativePath("a/../b.png")).toHaveProperty("error");
    expect(cleanRelativePath("C:\\x.png")).toHaveProperty("error");
    expect(cleanRelativePath("x\0.png")).toHaveProperty("error");
  });

  it("converts CSS colors to hex", () => {
    expect(parseColor("#ABC")).toBe("#aabbcc");
    expect(parseColor("#6D28D9CC")).toBe("#6d28d9");
    expect(parseColor("rgb(237 233 254 / 50%)")).toBe("#ede9fe");
    expect(parseColor("hsl(262, 83%, 58%)")).toBe("#7c3bed");
    expect(parseColor("222.2 84% 4.9%")).toBe("#020817");
    expect(parseColor("oklch(0.627 0.258 29.23)")).toBe("#ff0000");
    expect(parseColor("oklch(62.8% 0.2577 29.23)")).toBe("#ff0000");
    expect(parseColor("var(--primary)")).toBeNull();
    expect(parseColor("0.5rem")).toBeNull();
  });

  it("reads SVG sizes from width/height or the viewBox", () => {
    expect(svgSize('<svg width="64px" height="32" viewBox="0 0 10 10">')).toEqual({ width: 64, height: 32 });
    expect(svgSize('<svg width="100%" viewBox="0 0 120 40">')).toEqual({ width: 120, height: 40 });
    expect(svgSize("<html>")).toBeNull();
  });
});

// ---------- captions ----------

// Thumbnails for the vision model need ffmpeg; without it the pass reports an error instead.
const hasFfmpeg = Boolean(await ffmpegPath());

describe.skipIf(!hasFfmpeg)("caption pass", () => {
  const reply = (captions: Array<{ n: number; caption: string; kind: string }>) => ({ content: [{ type: "tool_use", name: "describe_assets", input: { assets: captions } }], stop_reason: "tool_use" });

  it("describes images in batches of at most 12, fixes obvious kinds, and sends no paths or names", async () => {
    const files = Array.from({ length: 13 }, (_, i) => ({ name: `shots/frame-${i}.png`, bytes: png(200 + i, 120) }));
    await addUploadedFiles(BRAND, [{ name: "brand/wordmark.svg", bytes: svg("Acme") }, ...files]);
    const message = vi.fn(async (input: { model: string; messages: Array<{ content: Array<{ type: string }> }> }) => {
      const count = input.messages[0].content.filter((block) => block.type === "image").length;
      return reply(Array.from({ length: count }, (_, i) => ({ n: i + 1, caption: `frame number ${i + 1} of the batch`, kind: i === 0 ? "logo" : "screenshot" })));
    });
    const result = await captionAssets({ message } as never, BRAND);
    expect(result).toMatchObject({ captioned: 13, failed: 0, errors: [] });
    expect(message).toHaveBeenCalledTimes(2);
    const [first, second] = message.mock.calls.map(([input]) => input);
    expect(first.model).toBe(QC_MODEL);
    expect(first.messages[0].content.filter((b) => b.type === "image")).toHaveLength(12);
    expect(second.messages[0].content.filter((b) => b.type === "image")).toHaveLength(1);
    const sent = JSON.stringify(message.mock.calls);
    expect(sent).not.toContain(kitRoot);
    expect(sent).not.toMatch(/frame-\d+\.png|wordmark\.svg|shots\/|brand\/|a\d+-[A-Za-z]/);

    const kit = getBrandKit(BRAND);
    expect(kit.assets[0]).toMatchObject({ kind: "logo", caption: "wordmark (logo)" }); // SVGs are not sent
    expect(kit.assets[1]).toMatchObject({ kind: "logo", caption: "frame number 1 of the batch" });
    expect(kit.assets[2]).toMatchObject({ kind: "screenshot", caption: "frame number 2 of the batch" });

    // already described images are not sent again
    message.mockClear();
    expect(await captionAssets({ message } as never, BRAND)).toMatchObject({ captioned: 0 });
    expect(message).not.toHaveBeenCalled();
  });

  it("tolerates a failing model and retries those images on the next pass", async () => {
    await addUploadedFiles(BRAND, [{ name: "hero.png", bytes: png(640, 360) }]);
    const failing = vi.fn(async () => {
      throw new ApiError("naive", 402, "insufficient_credits", "out of credits");
    });
    const failed = await captionAssets({ message: failing } as never, BRAND);
    expect(failed.captioned).toBe(0);
    expect(failed.errors[0]).toMatch(/out of credits/);
    expect(getBrandKit(BRAND).assets[0].caption).toBe("hero (image)");

    const working = vi.fn(async () => reply([{ n: 1, caption: "landing page hero with a big headline", kind: "screenshot" }]));
    expect((await captionAssets({ message: working } as never, BRAND)).captioned).toBe(1);
    expect(getBrandKit(BRAND).assets[0]).toMatchObject({ kind: "screenshot", caption: "landing page hero with a big headline" });
  });

  it("runs in the background after an upload when a Naive key is set, without failing the request", async () => {
    vi.stubEnv("NAIVE_API_KEY", "sk_test_brandkit");
    const fetchMock = vi.fn(async () => Response.json(reply([{ n: 1, caption: "pricing table with three plans", kind: "screenshot" }])));
    vi.stubGlobal("fetch", fetchMock);
    const response = await upload([["pricing.png", png(900, 600)]]);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(isCaptioning(BRAND)).toBe(false), { timeout: 15_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getBrandKit(BRAND).assets[0]).toMatchObject({ kind: "screenshot", caption: "pricing table with three plans" });

    // a provider error is logged, the upload still succeeds
    fetchMock.mockImplementation(async () => Response.json({ error: { code: "bad_request", message: "nope" } }, { status: 400 }));
    expect((await upload([["second.png", png(901, 600)]])).status).toBe(200);
    await vi.waitFor(() => expect(isCaptioning(BRAND)).toBe(false), { timeout: 15_000 });
    const events = db().prepare("select level, message from events where brand_id = ? order by id").all(BRAND) as Array<{ level: string; message: string }>;
    expect(events.some((e) => e.level === "warn" && /couldn't describe/.test(e.message))).toBe(true);
  });
});
