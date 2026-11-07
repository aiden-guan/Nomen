// Read-only check of the Mobilerun client against the live API. Skipped unless MOBILERUN_LIVE=1.
// Run: MOBILERUN_LIVE=1 npx vitest run tests/phones/live.test.ts
// The key comes from MOBILERUN_API_KEY or .env.local. Nothing is created, started or billed.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MobilerunClient } from "@/lib/phones/mobilerun";

const live = process.env.MOBILERUN_LIVE === "1";
if (live && !process.env.MOBILERUN_API_KEY && existsSync(".env.local")) process.loadEnvFile(".env.local");

describe.skipIf(!live)("Mobilerun live API (read-only)", () => {
  it("lists phones and saved login names in the shapes the client expects", async () => {
    const client = new MobilerunClient();

    const devices = await client.listDevices();
    expect(Array.isArray(devices)).toBe(true);
    for (const device of devices) {
      expect(typeof device.id).toBe("string");
      expect(typeof device.state).toBe("string");
    }
    if (devices[0]) {
      const one = await client.getDevice(devices[0].id);
      expect(one.id).toBe(devices[0].id);
    }

    const names = await client.listCredentialNames();
    for (const name of names) expect(Object.keys(name).sort()).toEqual(["credentialName", "packageName"]);

    // Counts and states only: no ids, names or secrets in the output.
    console.info(
      `[phones live] ${devices.length} phone(s): ${devices.map((d) => `${d.type}/${d.state}`).join(", ") || "none"}; ${names.length} saved login(s) for ${[...new Set(names.map((n) => n.packageName))].join(", ") || "no apps"}`,
    );
  }, 60_000);
});
