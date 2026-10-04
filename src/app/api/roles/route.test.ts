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

type Catalog = { schemaVersion: number; roles: { id: string; promptScaffold: string; promptPreview: string; config: { engine: string; model: string; effort: string }; variants?: Record<string, { engine: string; model: string; effort: string }>; shipped: { config: unknown; promptScaffold?: string; variants?: unknown } }[] };
const file = path.join(sandbox, "role-presets.json");
const put = (body: unknown) => PUT(new NextRequest("http://127.0.0.1/api/roles", {
  method: "PUT",
  headers: { host: "127.0.0.1", "content-type": "application/json" },
  body: JSON.stringify(body),
}));

beforeEach(() => fs.rmSync(file, { force: true }));

test("maintainer picker catalogue choices write the shared row and resolve for launches", async () => {
  const { ENGINE_MODELS } = await import("@/lib/agent/models");
  const { effortScale } = await import("@/lib/agent/efforts");
  const { resolveSpawnRole } = await import("@/lib/roles/registry");
  const catalog = await (await GET()).json() as Catalog & { launchChoices: { engine: "claude" | "codex"; models: { id: string; efforts: string[] }[] }[] };
  expect(catalog.launchChoices.map(c => c.engine)).toEqual(["claude", "codex"]);
  for (const choice of catalog.launchChoices) {
    expect(choice.models.map(m => m.id)).toEqual(ENGINE_MODELS[choice.engine].map(m => m.id));
    for (const model of choice.models) {
      expect(model.efforts).toEqual([...effortScale(choice.engine, model.id)!]);
      for (const effort of model.efforts) {
        const config = { engine: choice.engine, model: model.id, effort };
        const response = await put({ overrides: { maintainer: { config } } });
        expect(response.status).toBe(200);
        expect((await response.json() as Catalog).roles.find(r => r.id === "maintainer")?.config).toEqual(config);
        expect(resolveSpawnRole({ role: "maintainer" })).toMatchObject({ ok: true, value: { config } });
      }
    }
  }
  const before = fs.readFileSync(file, "utf8");
  for (const config of [
    { engine: "codex", model: "gpt-unknown", effort: "high" },
    { engine: "claude", model: "claude-unlisted", effort: "high" },
    { engine: "claude", model: "opus", effort: "ultra" },
    { engine: "copilot", model: "auto", effort: "high" },
    { engine: "unknown", model: "auto", effort: "high" },
  ]) {
    expect((await put({ overrides: { maintainer: { config } } })).status).toBe(400);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }
});

test("roles route returns all merged role definitions with scaffold previews and shipped runtimes", async () => {
  const body = await (await GET()).json() as Catalog;
  expect(body.schemaVersion).toBe(5);
  expect(body.roles).toHaveLength(9);
  expect(body.roles.find((role) => role.id === "maintainer")?.config).toEqual({ engine: "codex", model: "gpt-6.1-sol", effort: "medium" });
  expect(body.roles[0]).toMatchObject({ id: "orchestrator" });
  /* The shipped deployer follows the project's own release procedure and assumes no topology. */
  expect(body.roles.find((role) => role.id === "deployer")?.promptPreview).toContain("Follow the project's own release procedure");
  expect(body.roles.find((role) => role.id === "deployer")?.shipped.promptScaffold).toBe(body.roles.find((role) => role.id === "deployer")?.promptScaffold);
  const builder = body.roles.find((role) => role.id === "builder")!;
  expect(builder.variants).toEqual({
    trivial: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" },
    frontend: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" },
    docs: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" },
    "apply-fixes": { engine: "codex", model: "gpt-6-luna", effort: "high" },
    "frontend-fixes": { engine: "claude", model: "claude-sonnet-5-5", effort: "high" },
    "docs-fixes": { engine: "claude", model: "claude-sonnet-5-5", effort: "high" },
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

test("PUT refuses Sonnet on the reviewer, the architect and the orchestrator, and Haiku on those and the verifier, in words", async () => {
  const refused = await put({ overrides: { reviewer: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } } });
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: string }).error).toBe("reviewer: Sonnet does not run orchestrator, architect or a reviewer above size=trivial, and Haiku runs none of orchestrator, architect, reviewer or verifier; name a large model (Claude Opus or Fable, or a large Codex model) or use the role's row.");
  expect((await put({ overrides: { architect: { config: { engine: "claude", model: "haiku", effort: "high" } } } })).status).toBe(400);
  expect((await put({ overrides: { verifier: { config: { engine: "claude", model: "haiku", effort: "high" } } } })).status).toBe(400);
  expect(fs.existsSync(file)).toBe(false);
});

test("PUT admits Sonnet 5.5 on the verifier and the size=trivial reviewer", async () => {
  const sonnet = { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" };
  expect((await put({ overrides: { verifier: { config: sonnet } } })).status).toBe(200);
  expect((await put({ overrides: { reviewer: { variants: { trivial: sonnet } } } })).status).toBe(200);
});

test("GET marks a malformed registry degraded while showing the shipped catalog", async () => {
  fs.writeFileSync(file, "{");
  const body = await (await GET()).json() as Catalog & { revision: string; health: { state: string; reason?: string } };
  expect(body.health).toEqual({ state: "degraded", reason: "preset unavailable" });
  expect(body.revision).toMatch(/^roles-1-/);
  expect(body.roles.find((role) => role.id === "builder")?.variants?.frontend).toEqual({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
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

/* docs/design/agent-prompt-contract.md §2.10 I: the product can put a role's
   shipped prompt back and nothing else; setting one stays outside it, and a
   row left with nothing is dropped. */
test("PUT restores a role's shipped prompt text and refuses to set one", async () => {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, overrides: {
    deployer: { promptScaffold: "An install's own deployer text." },
    architect: { promptScaffold: "mine {{mode}}", config: { engine: "claude", model: "fable", effort: "high" } },
  } }));
  const before = await (await GET()).json() as Catalog;
  const deployer = before.roles.find((role) => role.id === "deployer")!;
  expect(deployer.promptScaffold).toBe("An install's own deployer text.");
  expect(deployer.shipped.promptScaffold).not.toBe(deployer.promptScaffold);

  const refused = await put({ overrides: { deployer: { promptScaffold: "Another text." } } });
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: string }).error).toBe("promptScaffold can only be reset to the shipped text");

  const restored = await put({ overrides: { deployer: { promptScaffold: null }, architect: { promptScaffold: null } } });
  expect(restored.status).toBe(200);
  const after = await restored.json() as Catalog;
  expect(after.roles.find((role) => role.id === "deployer")!.promptScaffold).toBe(deployer.shipped.promptScaffold!);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ schemaVersion: 1, overrides: {
    architect: { config: { engine: "claude", model: "fable", effort: "high" } },
  } });
});

/* A stored fix row is schema 4, so a build that predates the fix rows refuses
   the file instead of dropping the row. */
test("a stored fix row writes the file at schema 4", async () => {
  const row = { engine: "claude", model: "opus", effort: "medium" };
  expect((await put({ overrides: { builder: { variants: { "frontend-fixes": row } } } })).status).toBe(200);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ schemaVersion: 4, overrides: { builder: { variants: { "frontend-fixes": row } } } });
});
