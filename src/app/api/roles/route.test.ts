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
  expect(body.schemaVersion).toBe(2);
  expect(body.roles).toHaveLength(8);
  expect(body.roles[0]).toMatchObject({ id: "orchestrator" });
  expect(body.roles.find((role) => role.id === "deployer")?.promptPreview).toContain("blue/green");
  const builder = body.roles.find((role) => role.id === "builder")!;
  expect(builder.variants).toEqual({
    frontend: { engine: "claude", model: "opus", effort: "high" },
    "apply-fixes": { engine: "codex", model: "gpt-5.6-terra", effort: "low" },
  });
  expect(builder.shipped.variants).toEqual(builder.variants);
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

test("PUT refuses a malformed body and an invalid runtime, and changes nothing", async () => {
  expect((await put({ overrides: { unknown: { config: null } } })).status).toBe(400);
  expect((await put({ overrides: { reviewer: { variants: { frontend: null } } } })).status).toBe(400);
  expect((await put({ overrides: { reviewer: { config: { engine: "claude", model: "opus" } } } })).status).toBe(400);
  const invalid = await put({ overrides: { reviewer: { config: { engine: "claude", model: "opus", effort: "ultra" } } } });
  expect(invalid.status).toBe(400);
  expect((await invalid.json() as { error: string }).error).toContain("effort for claude/opus must be one of");
  expect(fs.existsSync(file)).toBe(false);
});
