import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionApiConsent, setSubscriptionApiConsent } from "./subscriptionApiConsent";
import * as stateOwnership from "@/lib/stateOwnership";

const prior = process.env.LLV_STATE_DIR;
const roots: string[] = [];
afterEach(() => { process.env.LLV_STATE_DIR = prior; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function isolated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consent-test-")); roots.push(root); process.env.LLV_STATE_DIR = root; return root;
}
test("a new install persists off before any CLI limit cache can be written", () => {
  const root = isolated();
  expect(subscriptionApiConsent().enabled).toBe(false);
  fs.writeFileSync(path.join(root, "limits-cache.json"), JSON.stringify({ version: 2, engines: { claude: { sample: { parser: 3, data: { session: { usedPercent: 12 } }, provenance: { source: "live" } } } } }));
  expect(subscriptionApiConsent().enabled).toBe(false);
});
test("prior direct usage migrates on, and a later explicit off survives old cache", () => {
  const root = isolated();
  fs.writeFileSync(path.join(root, "limits-cache.json"), JSON.stringify({ version: 2, engines: { claude: { sample: { parser: 2, data: { session: { usedPercent: 12 } }, provenance: { source: "cache" } } } } }));
  expect(subscriptionApiConsent()).toMatchObject({ enabled: true, source: "migration" });
  setSubscriptionApiConsent(false);
  expect(subscriptionApiConsent()).toMatchObject({ enabled: false, source: "operator" });
});
test("corrupt consent never reenables direct requests through migration", () => {
  const root = isolated();
  fs.writeFileSync(path.join(root, "subscription-api-consent.json"), "{");
  expect(subscriptionApiConsent().enabled).toBe(false);
});
test("initial consent migration obeys the startup mutation guard", () => {
  const root = isolated();
  const guard = spyOn(stateOwnership, "assertStateStartupMutation").mockImplementation(() => { throw Error("startup guard refused"); });
  try {
    expect(() => subscriptionApiConsent()).toThrow("startup guard refused");
    expect(fs.existsSync(path.join(root, "subscription-api-consent.json"))).toBe(false);
  } finally { guard.mockRestore(); }
});
test("a real process restart retains explicit revocation and default-off", async () => {
  const root = isolated();
  const modulePath = fileURLToPath(new URL("./subscriptionApiConsent.ts", import.meta.url));
  const run = async (action: string) => {
    const child = Bun.spawn([process.execPath, "-e", `const m = await import(${JSON.stringify(modulePath)}); ${action}; console.log(JSON.stringify(m.subscriptionApiConsent()));`], { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0); return JSON.parse(output);
  };
  expect(await run("void 0")).toMatchObject({ enabled: false });
  expect(await run("m.setSubscriptionApiConsent(true)")).toMatchObject({ enabled: true });
  expect(await run("m.setSubscriptionApiConsent(false)")).toMatchObject({ enabled: false });
  expect(await run("void 0")).toMatchObject({ enabled: false, source: "operator" });
});
