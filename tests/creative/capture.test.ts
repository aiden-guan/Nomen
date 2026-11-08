import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSiteVisuals, pickPages, PHONE_VIEWPORT, type CaptureClient } from "@/lib/creative/capture";
import { ApiError } from "@/lib/http";
import type { BrowserAction, BrowserActionResult, Computer } from "@/lib/naive";

// A real (tiny) PNG of the given size, so the capture reads width and height from its header.
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // greyscale
  const rows = Buffer.alloc((width + 1) * height); // filter byte 0 + black pixels
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const computer = (status: Computer["status"]): Computer => ({
  id: "cmp_cap1",
  object: "computer",
  name: "nomen-capture-monid.ai",
  vcpu: 1,
  memory_mb: 1024,
  disk_gb: 5,
  status,
  browser: null,
  volume: null,
  snapshot_id: null,
  agent_id: null,
  created_at: "2026-11-07T10:00:00Z",
});

const result = (action: BrowserAction["action"], extra: Partial<BrowserActionResult> = {}): BrowserActionResult => ({
  object: "browser_action",
  action,
  url: "https://monid.ai/",
  text: null,
  data: null,
  links: null,
  elements: null,
  file_id: null,
  performed: true,
  ...extra,
});

const HOME_LINKS = [
  { href: "/", text: "Monid" },
  { href: "/pricing", text: "Pricing" },
  { href: "https://monid.ai/features", text: "Features" },
  { href: "https://docs.monid.ai/", text: "Docs" },
  { href: "https://docs.monid.ai/reference/tools/search", text: "Search tool" },
  { href: "/blog/how-agents-pay", text: "How agents pay" },
  { href: "/login", text: "Log in" },
  { href: "https://app.monid.ai/signup", text: "Sign up" },
  { href: "/privacy-policy", text: "Privacy" },
  { href: "/terms", text: "Terms" },
  { href: "https://twitter.com/monid", text: "Twitter" },
  { href: "/about", text: "About" },
  { href: "/customers", text: "Customers" },
  { href: "mailto:hi@monid.ai", text: "Email" },
];

type Options = { failGoto?: RegExp; bootStatuses?: Computer["status"][]; redirect?: Record<string, string> };

function fakeNaive(options: Options = {}) {
  const boot = [...(options.bootStatuses ?? ["running"])];
  let page = "https://monid.ai/";
  let shots = 0;
  const gotoKeys: string[] = [];
  const client = {
    createComputer: vi.fn(async () => computer("creating")),
    getComputer: vi.fn(async () => computer(boot.length > 1 ? boot.shift()! : boot[0])),
    browserAction: vi.fn(async (_id: string, action: BrowserAction, key?: string) => {
      switch (action.action) {
        case "goto": {
          gotoKeys.push(key ?? "");
          if (options.failGoto?.test(action.url)) throw new ApiError("naive", 403, "forbidden", "page URL is off the allow-list");
          page = options.redirect?.[action.url] ?? action.url;
          return result("goto", { url: page });
        }
        case "links":
          return result("links", { url: page, links: HOME_LINKS });
        case "extract":
          return result("extract", { url: page, text: `  ${new URL(page).pathname === "/" ? "Monid - tools for agents" : `${new URL(page).pathname.slice(1)} | Monid`}\n` });
        case "screenshot":
          return result("screenshot", { url: page, file_id: `fil_shot${++shots}` });
        default:
          throw new Error(`unexpected action ${action.action}`);
      }
    }),
    fileUrl: vi.fn(async (id: string) => ({ url: `https://files.naive.test/${id}.png?sig=x`, expires_at: "2026-11-07T11:00:00Z" })),
    closeBrowser: vi.fn(async () => null),
    deleteComputer: vi.fn(async () => ({ id: "cmp_cap1", object: "computer" as const, deleted: true })),
    pauseComputer: vi.fn(async () => ({ id: "cmp_cap1", status: "paused" as const })),
  };
  return { client: client as unknown as CaptureClient & typeof client, gotoKeys };
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nomen-capture-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://files.naive.test/")) return new Response("not found", { status: 404 });
      // The homepage is a tall capture; every other page is one phone screen.
      return new Response(new Uint8Array(url.includes("fil_shot1.") ? png(430, 2800) : png(430, 932)), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickPages", () => {
  it("picks pricing, product, docs and proof pages, one each, skipping login, legal, blog posts and other sites", () => {
    expect(pickPages(HOME_LINKS, "monid.ai")).toEqual(["https://monid.ai/pricing", "https://monid.ai/features", "https://docs.monid.ai/", "https://monid.ai/customers"]);
  });

  it("respects the page limit and prefers a section's front page", () => {
    const links = [
      { href: "https://shop.example.com/products/vintage-cola-12-pack", text: "Vintage Cola" },
      { href: "/collections/all", text: "Shop all" },
      { href: "/pages/how-it-works", text: "How it works" },
      { href: "/docs/getting-started/install/linux", text: "Install" },
    ];
    expect(pickPages(links, "https://www.example.com/", 2)).toEqual(["https://example.com/pages/how-it-works", "https://shop.example.com/products/vintage-cola-12-pack"]);
  });

  it("finds nothing worth showing on a page of off-site and legal links", () => {
    expect(pickPages([{ href: "https://instagram.com/x", text: "IG" }, { href: "/terms-of-service", text: "Terms" }], "monid.ai")).toEqual([]);
  });
});

describe("captureSiteVisuals", () => {
  it("captures the homepage and the important pages on one phone-shaped browser, then destroys the computer", async () => {
    const { client, gotoKeys } = fakeNaive({ bootStatuses: ["creating", "running"] });
    const dir = join(root, "monid");
    const visuals = await captureSiteVisuals(client, { domain: "https://monid.ai/", dir, pollMs: 1 });

    const [create] = client.createComputer.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(create).toMatchObject({ name: "nomen-capture-monid.ai", vcpu: 1, browser: { viewport: PHONE_VIEWPORT, allowed_domains: ["monid.ai", "*.monid.ai"] } });
    expect((create as { browser: Record<string, unknown> }).browser.os).toBeUndefined(); // "mobile" leaves the live browser unavailable
    expect(client.getComputer).toHaveBeenCalledTimes(2);

    expect(visuals.map((v) => v.source)).toEqual(["capture:mobile:/", "capture:mobile:/pricing", "capture:mobile:/features", "capture:mobile:docs.monid.ai", "capture:mobile:/customers"]);
    expect(visuals.map((v) => v.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(visuals.every((v) => v.kind === "screenshot" && existsSync(v.url) && v.url.startsWith(dir))).toBe(true);
    expect(visuals[0]).toMatchObject({ width: 430, height: 2800, caption: 'homepage, as a phone shows it: "Monid - tools for agents"' });
    expect(visuals[1]).toMatchObject({ width: 430, height: 932, caption: 'pricing page (/pricing), as a phone shows it: "pricing | Monid"' });
    expect((await readdir(dir)).sort()).toEqual(["site-customers.png", "site-docs-monid-ai.png", "site-features.png", "site-home.png", "site-pricing.png"]);

    // every navigation has its own Idempotency-Key (a reused key would replay the old page)
    expect(gotoKeys).toHaveLength(5);
    expect(new Set(gotoKeys).size).toBe(5);
    expect(client.closeBrowser).toHaveBeenCalledWith("cmp_cap1");
    expect(client.deleteComputer).toHaveBeenCalledWith("cmp_cap1");
    expect(client.pauseComputer).not.toHaveBeenCalled();
  });

  it("uses the paths it is given instead of discovering them, and ignores other domains", async () => {
    const { client } = fakeNaive();
    const visuals = await captureSiteVisuals(client, { domain: "monid.ai", pollMs: 1, dir: join(root, "paths"), paths: ["/pricing", "https://evil.example.com/x", "how-it-works"] });
    expect(visuals.map((v) => v.source)).toEqual(["capture:mobile:/", "capture:mobile:/pricing", "capture:mobile:/how-it-works"]);
    expect(client.browserAction.mock.calls.some(([, action]) => (action as BrowserAction).action === "links")).toBe(false);
  });

  it("tolerates pages that fail and pages that redirect to one already captured", async () => {
    const { client } = fakeNaive({ failGoto: /docs\.monid\.ai/, redirect: { "https://monid.ai/features": "https://monid.ai/" } });
    const visuals = await captureSiteVisuals(client, { domain: "monid.ai", pollMs: 1, dir: join(root, "flaky") });
    expect(visuals.map((v) => v.source)).toEqual(["capture:mobile:/", "capture:mobile:/pricing", "capture:mobile:/customers"]);
    expect(client.deleteComputer).toHaveBeenCalled();
  });

  it("still tries the given paths when the homepage fails", async () => {
    const { client } = fakeNaive({ failGoto: /^https:\/\/monid\.ai\/$/ });
    const visuals = await captureSiteVisuals(client, { domain: "monid.ai", pollMs: 1, dir: join(root, "nohome"), paths: ["/pricing"] });
    expect(visuals.map((v) => v.source)).toEqual(["capture:mobile:/pricing"]);
  });

  it("pauses the computer when it cannot be destroyed", async () => {
    const { client } = fakeNaive();
    client.deleteComputer.mockRejectedValueOnce(new ApiError("naive", 409, "computer_unavailable", "busy"));
    const visuals = await captureSiteVisuals(client, { domain: "monid.ai", pollMs: 1, dir: join(root, "pause"), maxPages: 1 });
    expect(visuals).toHaveLength(2);
    expect(client.pauseComputer).toHaveBeenCalledWith("cmp_cap1");
  });

  it("throws when the computer never starts, and still cleans it up", async () => {
    const { client } = fakeNaive({ bootStatuses: ["failed"] });
    const error = await captureSiteVisuals(client, { domain: "monid.ai", pollMs: 1, dir: join(root, "failed") }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("computer_unavailable");
    expect(client.browserAction).not.toHaveBeenCalled();
    expect(client.deleteComputer).toHaveBeenCalledWith("cmp_cap1");
  });

  it("stops starting new pages when the time budget runs out", async () => {
    const { client } = fakeNaive();
    const visuals = await captureSiteVisuals(client, { domain: "monid.ai", pollMs: 1, dir: join(root, "budget"), budgetMs: 10_000 });
    expect(visuals.map((v) => v.source)).toEqual(["capture:mobile:/"]);
  });
});
