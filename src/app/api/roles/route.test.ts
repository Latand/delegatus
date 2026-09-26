import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-roles-route-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { GET, PUT } = await import("./route");

type Catalog = { schemaVersion: number; roles: { id: string; promptPreview: string; config: { engine: string; model: string; effort: string }; variants?: Record<string, { engine: string; model: string; effort: string }>; shipped: { config: unknown; variants?: unknown } }[] };
const file = path.join(sandbox, "role-presets.json");
const put = (body: unknown) => PUT(new NextRequest("http://127.0.0.1/api/roles", {
  method: "PUT",
  headers: { host: "127.0.0.1", "content-type": "application/json" },
  body: JSON.stringify(body),
}));

beforeEach(() => fs.rmSync(file, { force: true }));

test("roles route returns all merged role definitions with scaffold previews and shipped runtimes", async () => {
  const body = await (await GET()).json() as Catalog;
  expect(body.schemaVersion).toBe(3);
  expect(body.roles).toHaveLength(8);
  expect(body.roles[0]).toMatchObject({ id: "orchestrator" });
  expect(body.roles.find((role) => role.id === "deployer")?.promptPreview).toContain("blue/green");
  const builder = body.roles.find((role) => role.id === "builder")!;
  expect(builder.variants).toEqual({
    trivial: { engine: "claude", model: "sonnet", effort: "high" },
    frontend: { engine: "claude", model: "opus", effort: "high" },
    docs: { engine: "claude", model: "opus", effort: "medium" },
    "apply-fixes": { engine: "codex", model: "gpt-5.6-terra", effort: "low" },
  });
  expect(builder.shipped.variants).toEqual(builder.variants);
  const reviewer = body.roles.find((role) => role.id === "reviewer")!;
  expect(reviewer.variants).toEqual({ trivial: { engine: "codex", model: "gpt-6-luna", effort: "high" } });
  expect(reviewer.shipped.variants).toEqual(reviewer.variants);
  expect((body as Catalog & { resets: unknown[] }).resets).toEqual([]);
});

/* docs/design/model-sizing-tiers.md §5: a reset row is answered until the
   operator writes that row, and §2 R1 is the mapping writer's refusal. */
test("GET answers the rows a retirement reset, and a write to the row clears it", async () => {
  const from = { engine: "claude", model: "opus", effort: "xhigh" };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, overrides: {}, retirements: { "2026-09-builder-frontend-opus-xhigh": { at: "2026-09-27T08:00:00.000Z", reset: { row: "builder:frontend", from } } } }));
  const before = await (await GET()).json() as { resets: unknown[] };
  expect(before.resets).toEqual([{ id: "2026-09-builder-frontend-opus-xhigh", row: "builder:frontend", from, at: "2026-09-27T08:00:00.000Z" }]);
  const restored = await put({ overrides: { builder: { variants: { frontend: from } } } });
  expect(restored.status).toBe(200);
  expect((await restored.json() as { resets: unknown[] }).resets).toEqual([]);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    schemaVersion: 2,
    overrides: { builder: { variants: { frontend: from } } },
    retirements: { "2026-09-builder-frontend-opus-xhigh": { at: "2026-09-27T08:00:00.000Z" } },
  });
});

test("PUT refuses Sonnet or Haiku on the reviewer, the architect, the orchestrator or the verifier, in words", async () => {
  const refused = await put({ overrides: { reviewer: { variants: { trivial: { engine: "claude", model: "sonnet", effort: "high" } } } } });
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: string }).error).toBe("reviewer: Sonnet and Haiku do not run orchestrator, architect, reviewer or verifier work; name an Opus-class model or use the role's row.");
  expect((await put({ overrides: { architect: { config: { engine: "claude", model: "haiku", effort: "high" } } } })).status).toBe(400);
  expect(fs.existsSync(file)).toBe(false);
});

test("GET marks a malformed registry degraded while showing the shipped catalog", async () => {
  fs.writeFileSync(file, "{");
  const body = await (await GET()).json() as Catalog & { revision: string; health: { state: string; reason?: string } };
  expect(body.health).toEqual({ state: "degraded", reason: "preset unavailable" });
  expect(body.revision).toMatch(/^roles-1-/);
  expect(body.roles.find((role) => role.id === "builder")?.variants?.frontend).toEqual({ engine: "claude", model: "opus", effort: "high" });
});

test("PUT maps a role and a builder variant, keeps a scaffold override, and answers the merged catalog", async () => {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, overrides: { reviewer: { promptScaffold: "Custom reviewer scaffold" } } }));
  const response = await put({ overrides: {
    reviewer: { config: { engine: "claude", model: "opus", effort: "xhigh" } },
    builder: { variants: { "apply-fixes": { engine: "claude", model: "sonnet", effort: "low" } } },
  } });
  expect(response.status).toBe(200);
  const body = await response.json() as Catalog;
  expect(body.roles.find((role) => role.id === "reviewer")?.config).toEqual({ engine: "claude", model: "opus", effort: "xhigh" });
  expect(body.roles.find((role) => role.id === "builder")?.variants?.["apply-fixes"]).toEqual({ engine: "claude", model: "sonnet", effort: "low" });
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(stored).toEqual({
    schemaVersion: 2,
    overrides: {
      reviewer: { promptScaffold: "Custom reviewer scaffold", config: { engine: "claude", model: "opus", effort: "xhigh" } },
      builder: { variants: { "apply-fixes": { engine: "claude", model: "sonnet", effort: "low" } } },
    },
  });

  /* Resetting drops the rows back to the shipped value, and a file without
     variants is written as schema 1 again. */
  const reset = await put({ overrides: { builder: { variants: { "apply-fixes": null } }, reviewer: { config: null } } });
  expect(reset.status).toBe(200);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ schemaVersion: 1, overrides: { reviewer: { promptScaffold: "Custom reviewer scaffold" } } });
});

test("PUT refuses a stale catalog revision before it writes a newer mapping", async () => {
  const initial = await (await GET()).json() as Catalog & { revision: string };
  const first = await put({
    expectedRevision: initial.revision,
    overrides: { builder: { variants: { frontend: { engine: "claude", model: "sonnet", effort: "high" } } } },
  });
  expect(first.status).toBe(200);
  const current = await first.json() as Catalog & { revision: string };
  expect(current.revision).not.toBe(initial.revision);

  const stale = await put({
    expectedRevision: initial.revision,
    overrides: { reviewer: { config: { engine: "claude", model: "opus", effort: "xhigh" } } },
  });
  expect(stale.status).toBe(409);
  expect((await stale.json() as { revision: string }).revision).toBe(current.revision);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
    schemaVersion: 2,
    overrides: { builder: { variants: { frontend: { engine: "claude", model: "sonnet", effort: "high" } } } },
  });
});

test("PUT refuses a malformed body and an invalid runtime, and changes nothing", async () => {
  expect((await put({ overrides: { unknown: { config: null } } })).status).toBe(400);
  expect((await put({ overrides: { reviewer: { variants: { frontend: null } } } })).status).toBe(400);
  expect((await put({ overrides: { reviewer: { config: { engine: "claude", model: "opus" } } } })).status).toBe(400);
  const invalid = await put({ overrides: { reviewer: { config: { engine: "claude", model: "opus", effort: "ultra" } } } });
  expect(invalid.status).toBe(400);
  expect((await invalid.json() as { error: string }).error).toContain("effort for claude/opus must be one of");
  expect(fs.existsSync(file)).toBe(false);
});
