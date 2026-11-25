import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordAntigravityAuthState } from "@/lib/accounts/antigravity";

/*
 * `GET /api/accounts/antigravity` reads the recorded sign-in and starts
 * nothing; `POST {action:"probe"}` is same-origin only and runs the real check.
 * The probe itself is covered with a stubbed agy in antigravityAuthProbe.test.ts;
 * here `agy` is a missing path, so a POST that passes the guard answers without a child.
 */

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-route-test-"));
  for (const name of ["LLV_STATE_DIR", "LLV_ANTIGRAVITY_BIN", "XDG_CONFIG_HOME"]) saved[name] = process.env[name];
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.LLV_ANTIGRAVITY_BIN = path.join(root, "no-such-agy");
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const { GET, POST } = await import("./route");
const post = (body: unknown, headers: Record<string, string> = {}) => POST(new Request("http://127.0.0.1:8898/api/accounts/antigravity", {
  method: "POST",
  headers: { "content-type": "application/json", host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", ...headers },
  body: JSON.stringify(body),
}) as never);

test("GET answers the command's presence and the recorded sign-in with its tier", async () => {
  recordAntigravityAuthState({ authenticated: true, tierName: "Google AI Pro", tierId: "p", checkedAt: "2026-11-25T00:00:00.000Z" });
  const body = await (await GET()).json() as { cli: string; active: string; accounts: Record<string, unknown>[] };
  expect(body.cli).toBe("missing");
  expect(body.active).toBe("default");
  expect(body.accounts).toEqual([{ id: "default", label: "Default", kind: "legacy", auth: "signed_in", plan: "Google AI Pro", checkedAt: "2026-11-25T00:00:00.000Z", authPresent: true }]);
});

test("with nothing recorded the state is unknown, never signed in", async () => {
  const body = await (await GET()).json() as { accounts: { auth: string; plan: string | null; authPresent: boolean }[] };
  expect(body.accounts[0]).toMatchObject({ auth: "unknown", plan: null, authPresent: false });
});

test("a cross-origin POST is refused before anything runs", async () => {
  const response = await post({ action: "probe" }, { origin: "https://evil.example" });
  expect(response.status).toBe(403);
});

test("POST with another action is a 400", async () => {
  const response = await post({ action: "login" });
  expect(response.status).toBe(400);
});

test("a probe of a missing agy answers cli missing and records nothing", async () => {
  const response = await post({ action: "probe" });
  expect(response.status).toBe(200);
  const body = await response.json() as { cli: string; accounts: { auth: string }[]; probe: { inconclusive: boolean } };
  expect(body.cli).toBe("missing");
  expect(body.accounts[0]!.auth).toBe("unknown");
});
