import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { isEffectiveRole } from "@/lib/pipelines/storedRecord";
import { resolvePipelineRole, type PipelineRoleLookup } from "@/lib/pipelines/roles";
import { equivalentConfig } from "./equivalents";
import { listRoles } from "./registry";
import { clearRoleOverrides, loadRoleOverrides, saveRoleOverrides } from "./store";

describe("antigravity role registry and pipeline stage roles", () => {
  let root: string;
  let stateDir: string;
  let prevStateDir: string | undefined;
  let prevOwner: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-roles-"));
    stateDir = path.join(root, "state");
    prevStateDir = process.env.LLV_STATE_DIR;
    prevOwner = process.env.LLV_STATE_OWNER;
    process.env.LLV_STATE_DIR = stateDir;
    process.env.LLV_STATE_OWNER = "test";
  });

  afterEach(() => {
    clearRoleOverrides();
    if (prevStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prevStateDir;
    if (prevOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevOwner;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("saves, reads, and validates Antigravity role overrides with caller mutation safety and second SQLite connection visibility", () => {
    saveRoleOverrides({
      builder: { config: { engine: "antigravity", model: "gemini-4-neon", effort: "xhigh" } },
      reviewer: { config: { engine: "antigravity", model: "gemini-4-neon-high", effort: "high" } },
    });

    const loaded = loadRoleOverrides();
    expect(loaded.overrides.builder?.config).toEqual({ engine: "antigravity", model: "gemini-4-neon", effort: "xhigh" });

    // Caller mutation safety: mutating returned object does not leak to next reader
    loaded.overrides.builder!.config!.model = "MUTATED";
    expect(loadRoleOverrides().overrides.builder?.config?.model).toBe("gemini-4-neon");

    // Second SQLite connection sees the committed override immediately
    const secondDb = new Database(path.join(stateDir, "state.sqlite"), { readonly: true });
    try {
      const row = secondDb.query<{ value_json: string }, [string, string]>(
        "SELECT value_json FROM state_rows WHERE collection = ? AND row_key = ?",
      ).get("role_presets", "role:builder");
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.value_json)).toEqual({
        key: "role:builder",
        value: {
          config: { engine: "antigravity", model: "gemini-4-neon", effort: "xhigh" },
        },
      });
    } finally {
      secondDb.close();
    }

    // Rejects unsupported effort on a known Antigravity model
    expect(() => saveRoleOverrides({
      builder: { config: { engine: "antigravity", model: "gemini-4-neon", effort: "max" } },
    })).toThrow(/effort for antigravity\/gemini-4-neon/);

    // Role registry exposes the updated Antigravity runtime
    const builder = listRoles().find((r) => r.id === "builder");
    expect(builder?.config).toEqual({ engine: "antigravity", model: "gemini-4-neon", effort: "xhigh" });
  });

  it("maps equivalent role runtimes to and from Antigravity cleanly", () => {
    const moved = equivalentConfig({ engine: "claude", model: "opus", effort: "high" }, "antigravity", { roleId: "architect" });
    expect(moved).toEqual({ engine: "antigravity", model: "gemini-4-neon", effort: "xhigh" });
    const back = equivalentConfig(moved, "claude", { roleId: "architect" });
    expect(back.engine).toBe("claude");
  });

  it("resolves and validates Antigravity pipeline stages", () => {
    const lookup: PipelineRoleLookup = (roleId) => ({
      engine: "antigravity",
      model: "gemini-4-neon",
      effort: "high",
      access: roleId === "reviewer" ? "read-only" : "read-write",
      promptScaffold: `Role scaffold for ${roleId}`,
    });
    const resolved = resolvePipelineRole(
      {
        role: { roleId: "builder" },
        engine: "antigravity",
        model: "gemini-4-neon-xhigh",
        effort: "xhigh",
      },
      "run",
      lookup,
    );
    expect(resolved.error).toBeUndefined();
    expect(resolved.role).toMatchObject({
      roleId: "builder",
      engine: "antigravity",
      model: "gemini-4-neon-xhigh",
      effort: "xhigh",
      access: "read-write",
    });
    expect(isEffectiveRole(resolved.role)).toBe(true);

    // Invalid effort is rejected
    const bad = resolvePipelineRole(
      { engine: "antigravity", model: "gemini-3.8-flash", effort: "xhigh" },
      "run",
      lookup,
    );
    expect(bad.error).toContain("stage effort for antigravity/gemini-3.8-flash");
  });
});
