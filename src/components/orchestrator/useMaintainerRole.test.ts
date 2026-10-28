import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { ENGINE_MODELS, listedModels } from "@/lib/agent/models";

import { offeredModels, runtimeForEngine, type LaunchChoice } from "./useMaintainerRole";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-maintainer-choices-"));
const previousStateDir = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); fs.mkdirSync(sandbox, { recursive: true }); });

const { GET, PUT } = await import("@/app/api/roles/route");

async function served(): Promise<{ choices: LaunchChoice[]; maintainer: { engine: "claude" | "codex"; model: string; effort: string } }> {
  const body = await (await GET()).json() as { launchChoices: LaunchChoice[]; roles: { id: string; config: { engine: "claude" | "codex"; model: string; effort: string } }[] };
  return { choices: body.launchChoices, maintainer: body.roles.find((role) => role.id === "maintainer")!.config };
}

test("the maintainer picker offers what the shared catalogue lists from the served launch choices", async () => {
  const { choices } = await served();
  for (const engine of ["claude", "codex"] as const) {
    expect(offeredModels(choices, engine, null).map((model) => model.id)).toEqual(listedModels(engine).map((model) => model.id));
  }
  expect(offeredModels(choices, "codex", null).map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);
  expect(offeredModels(choices, "claude", null).filter((model) => model.label === "Haiku 5.5").map((model) => model.id)).toEqual(["claude-haiku-5-5"]);
});

test("a saved retired maintainer model stays offered under its label and is never rewritten by a read", async () => {
  for (const config of [
    { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
    { engine: "codex", model: "gpt-6-sol", effort: "high" },
    { engine: "claude", model: "claude-haiku-4-5", effort: "high" },
    { engine: "claude", model: "haiku", effort: "high" },
  ] as const) {
    const response = await PUT(new NextRequest("http://127.0.0.1/api/roles", {
      method: "PUT",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ overrides: { maintainer: { config } } }),
    }));
    expect(response.status).toBe(200);
    const { choices, maintainer } = await served();
    expect(maintainer).toEqual(config);
    const offered = offeredModels(choices, config.engine, config.model);
    expect(offered.map((model) => model.id)).toEqual(listedModels(config.engine, config.model).map((model) => model.id));
    expect(offered.find((model) => model.id === config.model)?.label).toBe(ENGINE_MODELS[config.engine].find((option) => option.id === config.model)!.label);
    expect(offered.filter((model) => model.label === "Haiku 5.5")).toHaveLength(config.engine === "claude" ? 1 : 0);
  }
});

test("an engine switch lands on an offered model, never a retired one", async () => {
  const { choices } = await served();
  const landed = runtimeForEngine(choices, { engine: "claude", model: "claude-haiku-4-5", effort: "high" }, "codex");
  expect(offeredModels(choices, "codex", null).map((model) => model.id)).toContain(landed.model);
  const back = runtimeForEngine(choices, { engine: "codex", model: "gpt-5.6-terra", effort: "ultra" }, "claude");
  expect(ENGINE_MODELS.claude.find((option) => option.id === back.model)?.retired).toBeUndefined();
  // An equivalent named by its launch alias is kept, standing in for its pinned row.
  expect(runtimeForEngine(choices, { engine: "codex", model: "gpt-5.6-luna", effort: "high" }, "claude").model).toBe("haiku");
});
