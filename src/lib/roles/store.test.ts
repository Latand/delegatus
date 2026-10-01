import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRole, resolveSpawnRole } from "./registry";

import * as stateOwnership from "@/lib/stateOwnership";

import { applyRoleMappingRetirements, ROLE_MAPPING_RETIREMENTS } from "./retirements";
import { applyRoleMappingPatch, loadRoleDefinitions, loadRoleOverrides, loadRoleRegistrySnapshot, mergeRoleDefinitions, parseRoleMappingPatch, saveRoleMapping, saveRoleOverrides } from "./store";
import type { RoleConfig } from "./types";

test("fresh installs and config:null resets restore every shipped role and variant", () => {
  withStateDir("llv-shipped-roles-", () => {
    const codex = (model: string, effort: string): RoleConfig => ({ engine: "codex", model, effort });
    const claude = (model: string, effort: string): RoleConfig => ({ engine: "claude", model, effort });
    const expected = {
      builder: codex("gpt-6.1-sol", "high"),
      reviewer: codex("gpt-6.1-sol", "xhigh"),
      verifier: codex("gpt-6.1-sol", "high"),
      architect: claude("opus", "xhigh"),
      orchestrator: claude("opus", "high"),
      cleaner: codex("gpt-6-luna", "medium"),
      "prod-auditor": codex("gpt-6.1-sol", "xhigh"),
      deployer: codex("gpt-6.1-sol", "medium"),
      maintainer: codex("gpt-6.1-sol", "medium"),
    };
    const expectedVariants = {
      builder: {
        trivial: claude("claude-sonnet-5-5", "high"),
        frontend: claude("claude-sonnet-5-5", "high"),
        docs: claude("claude-sonnet-5-5", "high"),
        "apply-fixes": codex("gpt-6-luna", "high"),
        "frontend-fixes": claude("claude-sonnet-5-5", "high"),
        "docs-fixes": claude("claude-sonnet-5-5", "high"),
      },
      reviewer: { trivial: codex("gpt-6-luna", "high") },
    };
    const check = () => {
      const roles = loadRoleDefinitions();
      expect(Object.fromEntries(roles.map(({ id, config }) => [id, config]))).toEqual(expected);
      expect(Object.fromEntries(roles.filter((role) => role.variants).map(({ id, variants }) => [id, variants]))).toEqual(expectedVariants);
    };
    check();
    const edited = Object.fromEntries(Object.keys(expected).map((id) => [id, {
      config: codex("gpt-6-astra", "max"),
      ...(id in expectedVariants ? { variants: Object.fromEntries(Object.keys(expectedVariants[id as keyof typeof expectedVariants]).map((variant) => [variant, codex("gpt-5.6-terra", "high")])) } : {}),
    }]));
    const write = parseRoleMappingPatch(edited);
    if (typeof write === "string") throw new Error(write);
    saveRoleMapping(write);
    expect(loadRoleDefinitions().find((role) => role.id === "builder")!.config.model).toBe("gpt-6-astra");
    const reset = parseRoleMappingPatch(Object.fromEntries(Object.keys(expected).map((id) => [id, {
      config: null,
      ...(id in expectedVariants ? { variants: Object.fromEntries(Object.keys(expectedVariants[id as keyof typeof expectedVariants]).map((variant) => [variant, null])) } : {}),
    }])));
    if (typeof reset === "string") throw new Error(reset);
    saveRoleMapping(reset);
    check();
    expect(loadRoleOverrides().overrides).toEqual({});
  });
});

test("role overrides persist with a schema version and merge only the selected role", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-store-"));
  process.env.LLV_STATE_DIR = state;
  try {
    saveRoleOverrides({ builder: { config: { model: "gpt-custom-builder" }, promptScaffold: "Custom {{mode}} scaffold" } });
    expect(JSON.parse(fs.readFileSync(path.join(state, "role-presets.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      overrides: { builder: { config: { model: "gpt-custom-builder" } } },
    });
    expect(loadRoleOverrides().schemaVersion).toBe(1);
    const builder = loadRoleDefinitions().find((role) => role.id === "builder")!;
    const reviewer = loadRoleDefinitions().find((role) => role.id === "reviewer")!;
    expect(builder.config.model).toBe("gpt-custom-builder");
    expect(builder.promptScaffold).toBe("Custom {{mode}} scaffold");
    expect(reviewer.config.model).toBe("gpt-6.1-sol");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("role overrides fail closed and preserve malformed or future-schema bytes", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-store-corrupt-"));
  process.env.LLV_STATE_DIR = state;
  const file = path.join(state, "role-presets.json");
  try {
    for (const content of [
      "{",
      JSON.stringify({ schemaVersion: 6, overrides: {} }),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { engine: "invalid" } } } }),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { model: "fable", effort: "banana" } } } }),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { unexpected: true } } }),
    ]) {
      fs.writeFileSync(file, content, "utf8");
      expect(() => loadRoleOverrides()).toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

for (const effort of ["max", "ultra"]) {
  test(`Astra orchestrator preset at ${effort} persists and resolves`, () => {
    const previous = process.env.LLV_STATE_DIR;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-astra-preset-"));
    process.env.LLV_STATE_DIR = state;
    try {
      const config = { engine: "codex" as const, model: "gpt-6-astra", effort };
      saveRoleOverrides({ orchestrator: { config }, builder: { config: { model: "gpt-5.6-sol" } } });
      expect(loadRoleOverrides().overrides.orchestrator?.config).toEqual(config);
      expect(resolveRole("orchestrator")).toMatchObject({ ok: true, value: { config } });
      expect(resolveRole("builder")).toMatchObject({ ok: true, value: { config: { model: "gpt-5.6-sol" } } });
      expect(JSON.parse(fs.readFileSync(path.join(state, "role-presets.json"), "utf8")).overrides.orchestrator.config).toEqual(config);
    } finally {
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
}

for (const [engine, model] of [["codex", "gpt-5.6-luna"], ["codex", "gpt-6-luna"], ["claude", "opus"]] as const) {
  test(`orchestrator preset refuses ${model}/ultra on save and load with model options`, () => {
    const previous = process.env.LLV_STATE_DIR;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-invalid-preset-"));
    process.env.LLV_STATE_DIR = state;
    try {
      const overrides = { orchestrator: { config: { engine, model, effort: "ultra" } } };
      const message = `effort for ${engine}/${model} must be one of: low, medium, high, xhigh, max`;
      expect(() => saveRoleOverrides(overrides)).toThrow(message);
      const file = path.join(state, "role-presets.json");
      const bytes = JSON.stringify({ schemaVersion: 1, overrides });
      fs.writeFileSync(file, bytes);
      expect(() => loadRoleOverrides()).toThrow(message);
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    } finally {
      if (previous === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
}

test("builder variants round-trip under schema 2, and a schema 1 file still reads", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-variants-"));
  process.env.LLV_STATE_DIR = state;
  const file = path.join(state, "role-presets.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { model: "gpt-5.6-sol" } } } }));
    expect(loadRoleOverrides()).toEqual({ schemaVersion: 1, overrides: { builder: { config: { model: "gpt-5.6-sol" } } } });

    const variant = { engine: "claude" as const, model: "sonnet", effort: "medium" };
    saveRoleOverrides({ builder: { variants: { "apply-fixes": variant } } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion).toBe(2);
    const builder = loadRoleDefinitions().find((role) => role.id === "builder")!;
    expect(builder.variants?.["apply-fixes"]).toEqual(variant);
    expect(builder.variants?.frontend).toEqual({ engine: "claude", model: "claude-sonnet-5-5", effort: "high" });
    expect(resolveRole("builder", { mode: "apply-fixes" })).toMatchObject({ ok: true, value: { config: variant } });

    /* Variants belong to the builder alone, and an invalid variant fails closed. */
    expect(() => saveRoleOverrides({ reviewer: { variants: { frontend: variant } } })).toThrow();
    const bytes = JSON.stringify({ schemaVersion: 2, overrides: { builder: { variants: { frontend: { effort: "banana" } } } } });
    fs.writeFileSync(file, bytes);
    expect(() => loadRoleOverrides()).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("GPT-6-Sol and GPT-6-Luna persist as role overrides and builder variants and resolve", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-gpt6-presets-"));
  process.env.LLV_STATE_DIR = state;
  try {
    const sol = { engine: "codex" as const, model: "gpt-6-sol", effort: "ultra" };
    const luna = { engine: "codex" as const, model: "gpt-6-luna", effort: "max" };
    saveRoleOverrides({ orchestrator: { config: sol }, builder: { config: luna, variants: { "apply-fixes": luna, frontend: sol } } });
    expect(loadRoleOverrides().overrides).toEqual({ orchestrator: { config: sol }, builder: { config: luna, variants: { "apply-fixes": luna, frontend: sol } } });
    expect(resolveRole("orchestrator")).toMatchObject({ ok: true, value: { config: sol } });
    expect(resolveRole("builder")).toMatchObject({ ok: true, value: { config: luna } });
    expect(resolveRole("builder", { mode: "apply-fixes" })).toMatchObject({ ok: true, value: { config: luna } });
    expect(resolveRole("builder", { domain: "frontend" })).toMatchObject({ ok: true, value: { config: sol } });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a mapping patch drops rows equal to the shipped value and keeps scaffold overrides", () => {
  const next = applyRoleMappingPatch(
    { reviewer: { promptScaffold: "mine", config: { model: "gpt-5.6-sol" } }, cleaner: { config: { effort: "high" } } },
    {
      reviewer: { config: { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh" } },
      cleaner: { config: null },
      builder: { variants: { frontend: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } },
    },
  );
  expect(next).toEqual({ reviewer: { promptScaffold: "mine" } });
});

/* The request the orchestrator sends to apply the model-landscape proposals
   (2026-09) to a live mapping shaped like this one: the frontend builder and
   the prod-auditor move to their new runtime and nothing else changes. */
test("the model-landscape mapping patch changes the frontend builder and the prod-auditor only", () => {
  const live: Parameters<typeof applyRoleMappingPatch>[0] = {
    builder: {
      config: { engine: "codex", model: "gpt-6-sol", effort: "high" },
      variants: { frontend: { engine: "claude", model: "opus", effort: "xhigh" }, "apply-fixes": { engine: "codex", model: "gpt-6-luna", effort: "high" } },
    },
    reviewer: { config: { engine: "codex", model: "gpt-6-astra", effort: "medium" } },
    orchestrator: { config: { engine: "claude", model: "opus", effort: "high" } },
    architect: { config: { engine: "claude", model: "opus", effort: "high" } },
    "prod-auditor": { config: { engine: "codex", model: "gpt-6-sol", effort: "xhigh" } },
    deployer: { config: { engine: "codex", model: "gpt-6-sol", effort: "medium" } },
    cleaner: { config: { engine: "codex", model: "gpt-6-luna", effort: "medium" } },
  };
  const next = applyRoleMappingPatch(live, {
    builder: { variants: { frontend: { engine: "claude", model: "opus", effort: "high" } } },
    "prod-auditor": { config: { engine: "codex", model: "gpt-6-astra", effort: "high" } },
  });
  const before = new Map(mergeRoleDefinitions(live).map((role) => [role.id, role]));
  const after = new Map(mergeRoleDefinitions(next).map((role) => [role.id, role]));

  expect(after.get("builder")!.variants!.frontend).toEqual({ engine: "claude", model: "opus", effort: "high" });
  expect(after.get("prod-auditor")!.config).toEqual({ engine: "codex", model: "gpt-6-astra", effort: "high" });
  expect(after.get("builder")!.config).toEqual(before.get("builder")!.config);
  expect(after.get("builder")!.variants!["apply-fixes"]).toEqual(before.get("builder")!.variants!["apply-fixes"]);
  for (const id of ["orchestrator", "reviewer", "verifier", "architect", "cleaner", "deployer"] as const) {
    expect({ id, config: after.get(id)!.config }).toEqual({ id, config: before.get(id)!.config });
  }
});

function withStateDir(prefix: string, run: (state: string, file: string) => void): void {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.LLV_STATE_DIR = state;
  try {
    run(state, path.join(state, "role-presets.json"));
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  }
}

const readFile = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/* docs/design/model-sizing-tiers.md §1 and §5. */
test("reviewer variants load and save, and schema 3 appears only when a newer variant is stored", () => {
  withStateDir("llv-role-schema3-", (_state, file) => {
    const luna = { engine: "codex" as const, model: "gpt-6-luna", effort: "medium" };
    saveRoleOverrides({ builder: { variants: { frontend: { effort: "medium" } } } });
    expect(readFile(file).schemaVersion).toBe(2);
    saveRoleOverrides({ builder: { variants: { docs: { effort: "high" } } } });
    expect(readFile(file).schemaVersion).toBe(3);
    saveRoleOverrides({ reviewer: { variants: { trivial: luna } } });
    expect(readFile(file).schemaVersion).toBe(3);
    expect(loadRoleOverrides()).toMatchObject({ schemaVersion: 3, overrides: { reviewer: { variants: { trivial: luna } } } });
    expect(resolveRole("reviewer", { diffSource: "#1", size: "trivial" })).toMatchObject({ ok: true, value: { config: luna } });
    const reviewer = loadRoleDefinitions().find((role) => role.id === "reviewer")!;
    expect(reviewer.variants).toEqual({ trivial: luna });
    /* A variant belongs to its own role: the reviewer has no frontend row, and no other role has variants. */
    expect(() => saveRoleOverrides({ reviewer: { variants: { frontend: luna } } })).toThrow();
    expect(() => saveRoleOverrides({ architect: { variants: { trivial: luna } } })).toThrow();
    /* The shipped values of the new rows are never written, so an untouched install keeps schema 1. */
    saveRoleMapping({ builder: { variants: { trivial: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" }, docs: null } }, reviewer: { variants: { trivial: null } } });
    expect(readFile(file)).toEqual({ schemaVersion: 1, overrides: {} });
  });
});

test("a mapping patch putting a role on a light model it may not run is refused before anything is written", () => {
  const row = (model: string): RoleConfig => ({ engine: "claude", model, effort: "high" });
  for (const id of ["reviewer", "architect", "orchestrator"]) {
    for (const model of ["sonnet", "claude-sonnet-5-5", "haiku"]) {
      const refusal = parseRoleMappingPatch({ [id]: { config: row(model) } });
      expect(typeof refusal === "string" && refusal).toContain("Sonnet does not run");
    }
  }
  /* Sonnet runs the verifier and the size=trivial reviewer; Haiku runs neither. */
  expect(parseRoleMappingPatch({ verifier: { config: row("claude-sonnet-5-5") } })).toEqual({ verifier: { config: row("claude-sonnet-5-5") } });
  expect(parseRoleMappingPatch({ verifier: { config: row("haiku") } })).toContain("verifier: ");
  expect(parseRoleMappingPatch({ reviewer: { variants: { trivial: row("claude-sonnet-5-5") } } })).toEqual({ reviewer: { variants: { trivial: row("claude-sonnet-5-5") } } });
  expect(parseRoleMappingPatch({ reviewer: { variants: { trivial: row("haiku") } } })).toContain("reviewer: ");
  expect(parseRoleMappingPatch({ builder: { variants: { trivial: row("haiku") } } })).toEqual({ builder: { variants: { trivial: row("haiku") } } });
  expect(parseRoleMappingPatch({ reviewer: { variants: { docs: null } } })).toBe("unknown reviewer variant: docs");
  /* A legacy file carrying such a row still loads; only new writes are refused. */
  withStateDir("llv-role-legacy-sonnet-", (_state, file) => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, overrides: { reviewer: { config: { engine: "claude", model: "sonnet", effort: "high" } } } }));
    expect(loadRoleOverrides().overrides.reviewer?.config?.model).toBe("sonnet");
  });
});

test("the boot pass drops rows equal to shipped, keeps the rest and every scaffold", () => {
  withStateDir("llv-role-normalize-", (_state, file) => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, overrides: {
      orchestrator: { config: { engine: "claude", model: "opus", effort: "high" } },
      architect: { config: { engine: "claude", model: "opus", effort: "xhigh" }, promptScaffold: "mine {{mode}}" },
      builder: { config: { engine: "codex", model: "gpt-6-sol", effort: "high" }, variants: { "apply-fixes": { engine: "codex", model: "gpt-6-luna", effort: "high" } } },
      reviewer: { config: { model: "gpt-6.1-sol" } },
    } }));
    expect(applyRoleMappingRetirements([], () => "2026-09-27T08:00:00.000Z")).toEqual({ state: "written", normalized: ["orchestrator", "architect", "builder:apply-fixes", "reviewer"], reset: [] });
    expect(readFile(file)).toEqual({ schemaVersion: 1, overrides: {
      architect: { promptScaffold: "mine {{mode}}" },
      builder: { config: { engine: "codex", model: "gpt-6-sol", effort: "high" } },
    } });
    expect(applyRoleMappingRetirements([])).toEqual({ state: "unchanged" });
  });
});

const RETIREMENT = { id: "test-builder-frontend-opus-xhigh", row: "builder:frontend", config: { engine: "claude" as const, model: "opus", effort: "xhigh" } };

test("a retirement resets only an exact match, records it once, and is not re-applied after a restore", () => {
  withStateDir("llv-role-retire-", (_state, file) => {
    const xhigh = { engine: "claude" as const, model: "opus", effort: "xhigh" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, overrides: { builder: { variants: { frontend: xhigh } } } }));
    expect(applyRoleMappingRetirements([RETIREMENT], () => "2026-09-27T08:00:00.000Z")).toEqual({ state: "written", normalized: [], reset: ["builder:frontend"] });
    expect(readFile(file)).toEqual({
      schemaVersion: 1,
      overrides: {},
      retirements: { [RETIREMENT.id]: { at: "2026-09-27T08:00:00.000Z", reset: { row: "builder:frontend", from: xhigh } } },
    });
    expect(resolveRole("builder", { domain: "frontend" })).toMatchObject({ ok: true, value: { config: { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } } });
    expect(loadRoleRegistrySnapshot().resets).toEqual([{ id: RETIREMENT.id, row: "builder:frontend", from: xhigh, at: "2026-09-27T08:00:00.000Z" }]);

    /* The operator restores the old value: the reset notice clears, the retirement stays applied. */
    saveRoleMapping({ builder: { variants: { frontend: xhigh } } });
    expect(readFile(file).retirements).toEqual({ [RETIREMENT.id]: { at: "2026-09-27T08:00:00.000Z" } });
    expect(loadRoleRegistrySnapshot().resets).toEqual([]);
    expect(applyRoleMappingRetirements([RETIREMENT])).toEqual({ state: "unchanged" });
    expect(readFile(file).overrides.builder.variants.frontend).toEqual(xhigh);
  });
  /* Any other value is the operator's choice: recorded as applied, row untouched. */
  withStateDir("llv-role-retire-other-", (_state, file) => {
    const sol = { engine: "codex" as const, model: "gpt-6-sol", effort: "xhigh" };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, overrides: { builder: { variants: { frontend: sol } }, reviewer: { promptScaffold: "keep" } } }));
    expect(applyRoleMappingRetirements([RETIREMENT], () => "2026-09-27T08:00:00.000Z")).toEqual({ state: "written", normalized: [], reset: [] });
    expect(readFile(file)).toEqual({
      schemaVersion: 2,
      overrides: { builder: { variants: { frontend: sol } }, reviewer: { promptScaffold: "keep" } },
      retirements: { [RETIREMENT.id]: { at: "2026-09-27T08:00:00.000Z" } },
    });
  });
});

test("the boot pass never creates the file, leaves an invalid one alone, and keeps an emptied one", () => {
  withStateDir("llv-role-retire-absent-", (_state, file) => {
    expect(applyRoleMappingRetirements([RETIREMENT])).toEqual({ state: "absent" });
    expect(fs.existsSync(file)).toBe(false);
    const bytes = JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { effort: "banana" } } } });
    fs.writeFileSync(file, bytes);
    expect(applyRoleMappingRetirements([RETIREMENT])).toEqual({ state: "unreadable" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, overrides: { builder: { variants: { frontend: RETIREMENT.config } } } }));
    applyRoleMappingRetirements([RETIREMENT]);
    expect(fs.existsSync(file)).toBe(true);
    expect(readFile(file).overrides).toEqual({});
  });
});

test("the boot pass goes through the startup-mutation fence before it touches the file", () => {
  withStateDir("llv-role-retire-fence-", (state, file) => {
    const bytes = JSON.stringify({ schemaVersion: 2, overrides: { builder: { variants: { frontend: RETIREMENT.config } } } });
    fs.writeFileSync(file, bytes);
    const fence = spyOn(stateOwnership, "assertStateStartupMutation").mockImplementation(() => { throw new Error("refused: not the state owner"); });
    try {
      expect(() => applyRoleMappingRetirements([RETIREMENT])).toThrow("refused: not the state owner");
      expect(fence).toHaveBeenCalledWith(state, "role mapping retirement");
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    } finally {
      fence.mockRestore();
    }
  });
});

test("the shipped retirement list names the stale frontend builder value", () => {
  expect(ROLE_MAPPING_RETIREMENTS).toEqual([{ id: "2026-09-builder-frontend-opus-xhigh", row: "builder:frontend", config: { engine: "claude", model: "opus", effort: "xhigh" } }]);
});

test("Codex role tier round trips at schema 5 and a full config can clear it", () => {
  const previous = process.env.LLV_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-tier-"));
  process.env.LLV_STATE_DIR = state;
  try {
    const config: RoleConfig = { engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast" };
    saveRoleMapping({ reviewer: { config } });
    expect(loadRoleOverrides().schemaVersion).toBe(5);
    expect(loadRoleDefinitions().find(role => role.id === "reviewer")?.config.serviceTier).toBe("ultrafast");
    const resolved = resolveSpawnRole({ role: "reviewer", roleParams: { diffSource: "#1" } });
    expect(resolved.ok).toBeTrue();
    if (resolved.ok) expect(resolved.value?.config.serviceTier).toBe("ultrafast");
    saveRoleMapping({ reviewer: { config: { ...config, effort: "xhigh" } } });
    expect(loadRoleOverrides().overrides.reviewer?.config).toMatchObject({ effort: "xhigh", serviceTier: "ultrafast" });
    const cleared: RoleConfig = { engine: "codex", model: "gpt-6-astra", effort: "high" };
    saveRoleMapping({ reviewer: { config: cleared } });
    expect(loadRoleOverrides().overrides.reviewer?.config).toEqual(cleared);
    expect(loadRoleDefinitions().find(role => role.id === "reviewer")?.config).toEqual(cleared);
    expect(JSON.parse(fs.readFileSync(path.join(state, "role-presets.json"), "utf8")).schemaVersion).toBeLessThan(5);
    saveRoleMapping({ reviewer: { variants: { trivial: config } } });
    expect(loadRoleOverrides().schemaVersion).toBe(5);
    saveRoleMapping({ reviewer: { variants: { trivial: cleared } } });
    expect(loadRoleOverrides().overrides.reviewer?.variants?.trivial).toEqual(cleared);
    expect(loadRoleOverrides().schemaVersion).toBeLessThan(5);
  } finally { process.env.LLV_STATE_DIR = previous; fs.rmSync(state, { recursive: true, force: true }); }
});
