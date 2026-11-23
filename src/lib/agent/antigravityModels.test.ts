import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  antigravityModelCatalog,
  antigravityModelsFromAcp,
  parseAntigravityModelsOutput,
  resolveAntigravityModelAndEffort,
  splitCombinedAntigravityModelId,
  writeAntigravityModelCatalog,
} from "./antigravityModels";
import { effortScale } from "./efforts";
import { defaultModelFor, listedModels, validateLaunchModel } from "./models";

const SAMPLE_AGY_MODELS_TSV = [
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
  "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
  "gemini-4-neon-low\tGemini 4 Neon (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "",
].join("\n");

describe("antigravityModels", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;
  let prevOwner: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-models-"));
    prevStateDir = process.env.LLV_STATE_DIR;
    prevOwner = process.env.LLV_STATE_OWNER;
    process.env.LLV_STATE_DIR = stateDir;
    process.env.LLV_STATE_OWNER = "test";
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prevStateDir;
    if (prevOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevOwner;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("splits combined agy model ids while preserving fixed model ids", () => {
    expect(splitCombinedAntigravityModelId("gemini-4-neon-xhigh")).toEqual({
      baseModel: "gemini-4-neon",
      suffixEffort: "xhigh",
    });
    expect(splitCombinedAntigravityModelId("gpt-oss-120b-medium")).toEqual({
      baseModel: "gpt-oss-120b-medium",
      suffixEffort: null,
    });
    expect(splitCombinedAntigravityModelId("gemini-pro-orchestrator-neon")).toEqual({
      baseModel: "gemini-pro-orchestrator-neon",
      suffixEffort: null,
    });
  });

  it("resolves combined ids, base+effort pairs, and explicit effort overrides", () => {
    expect(resolveAntigravityModelAndEffort("gemini-4-neon-xhigh", null)).toEqual({
      baseModel: "gemini-4-neon",
      thoughtLevel: "xhigh",
      combinedId: "gemini-4-neon-xhigh",
    });
    expect(resolveAntigravityModelAndEffort("gemini-4-neon", "low")).toEqual({
      baseModel: "gemini-4-neon",
      thoughtLevel: "low",
      combinedId: "gemini-4-neon-low",
    });
    expect(resolveAntigravityModelAndEffort("gemini-4-neon-xhigh", "medium")).toEqual({
      baseModel: "gemini-4-neon",
      thoughtLevel: "medium",
      combinedId: "gemini-4-neon-medium",
    });
    expect(resolveAntigravityModelAndEffort("gpt-oss-120b-medium", null)).toEqual({
      baseModel: "gpt-oss-120b-medium",
      thoughtLevel: null,
      combinedId: "gpt-oss-120b-medium",
    });
  });

  it("parses `agy models` TSV output into grouped base models with ordered efforts", () => {
    const parsed = parseAntigravityModelsOutput(SAMPLE_AGY_MODELS_TSV);
    const neon = parsed.find((item) => item.id === "gemini-4-neon");
    expect(neon).toEqual({
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      efforts: ["low", "medium", "high", "xhigh"],
      combinedIds: [
        "gemini-4-neon-high",
        "gemini-4-neon-xhigh",
        "gemini-4-neon-medium",
        "gemini-4-neon-low",
      ],
      pickerEnabled: true,
    });
    const oss = parsed.find((item) => item.id === "gpt-oss-120b-medium");
    expect(oss?.efforts).toEqual(["medium"]);
    const orch = parsed.find((item) => item.id === "gemini-pro-orchestrator-neon");
    expect(orch?.efforts).toBeNull();
  });

  it("parses ACP configOptions and availableModels into merged catalog entries", () => {
    const entries = antigravityModelsFromAcp(
      [
        {
          id: "model",
          category: "model",
          currentValue: "gemini-4-neon",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          ],
        },
        {
          id: "thought_level",
          category: "thought_level",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" },
          ],
        },
      ],
      [
        { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
        { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      ],
    );
    expect(entries.find((item) => item.id === "gemini-4-neon")?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(entries.find((item) => item.id === "gemini-3.8-flash")?.efforts).toEqual(["low", "medium"]);
  });

  it("isolates returned catalogs from caller mutations and survives concurrent writes", async () => {
    const initial = parseAntigravityModelsOutput(SAMPLE_AGY_MODELS_TSV);
    const written = writeAntigravityModelCatalog("default", initial, "cli-models");
    written.models[0]!.name = "MUTATED";
    written.models[0]!.efforts?.push("ultra");
    written.models.push({ id: "injected", name: "Injected", efforts: null, combinedIds: [], pickerEnabled: true });

    const fresh = antigravityModelCatalog("default");
    expect(fresh.models.find((m) => m.id === "gemini-4-neon")?.name).toBe("Gemini 4 Neon");
    expect(fresh.models.find((m) => m.id === "gemini-4-neon")?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(fresh.models.find((m) => m.id === "injected")).toBeUndefined();

    await Promise.all(Array.from({ length: 12 }, (_, idx) => Promise.resolve().then(() => {
      writeAntigravityModelCatalog(`acct-${idx % 3}`, initial, "acp-config");
    })));
    const afterConcurrent = antigravityModelCatalog("acct-0");
    expect(afterConcurrent.source).toBe("acp-config");
    expect(afterConcurrent.models.length).toBeGreaterThanOrEqual(4);
  });

  it("integrates with validateLaunchModel, defaultModelFor, listedModels, and effortScale", () => {
    expect(defaultModelFor("antigravity")).toBe("gemini-4-neon");
    expect(listedModels("antigravity").map((m) => m.id)).toContain("gemini-4-neon");
    expect(validateLaunchModel("antigravity", "gemini-4-neon-xhigh")).toEqual({ model: "gemini-4-neon-xhigh" });
    expect(validateLaunchModel("antigravity", "gemini-4-neon")).toEqual({ model: "gemini-4-neon" });
    expect("error" in validateLaunchModel("antigravity", "BAD MODEL!")).toBe(true);
    expect(effortScale("antigravity", "gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortScale("antigravity", "gemini-4-neon-xhigh")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortScale("antigravity", "gemini-3.8-flash")).toEqual(["low", "medium", "high"]);
    expect(effortScale("antigravity", "future-antigravity-model")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
