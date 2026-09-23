import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { effortScale } from "./efforts";
import {
  copilotModelCatalog,
  copilotModelsFromConfigOptions,
  mergeCopilotModelInfo,
  modelInfoFromCopilotTranscript,
  writeCopilotModelCatalog,
} from "./copilotModels";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-models-"));
const previous = process.env.LLV_STATE_DIR;
let run = 0;
beforeEach(() => {
  run += 1;
  process.env.LLV_STATE_DIR = path.join(sandbox, `run-${run}`, "state");
});
afterAll(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("reads model ids and names from the ACP model config option", () => {
  expect(copilotModelsFromConfigOptions([
    { id: "mode", options: [{ value: "interactive" }] },
    { id: "model", category: "model", options: [{ value: "auto", name: "Auto" }, { value: "model.fixture", name: "Fixture Model" }] },
  ])).toEqual([
    { id: "auto", name: "Auto", efforts: null, pickerEnabled: true },
    { id: "model.fixture", name: "Fixture Model", efforts: null, pickerEnabled: true },
  ]);
});

test("merges effort ladders from modelInfo without exposing picker-disabled records", () => {
  const parsed = copilotModelsFromConfigOptions([{ id: "model", options: [{ value: "model.fixture" }] }]);
  expect(mergeCopilotModelInfo(parsed, [
    { id: "model.fixture", efforts: ["low", "high"], pickerEnabled: true },
  ])).toEqual([{ id: "model.fixture", name: "model.fixture", efforts: ["low", "high"], pickerEnabled: true }]);
});

test("harvests only small model_call_started records from Copilot transcripts", () => {
  const sessions = path.join(sandbox, "sessions");
  const session = path.join(sessions, "fixture-session");
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "events.jsonl"), [
    JSON.stringify({ type: "model.model_call_started", data: { modelInfo: { id: "gpt-5.4-nano", name: "Nano", model_picker_enabled: false, capabilities: { supports: { reasoning_effort: ["none", "low", "medium", "high", "xhigh"] } } } } }),
    JSON.stringify({ type: "model.model_call_success", data: { requestMessages: "sensitive content".repeat(100_000) } }),
  ].join("\n") + "\n");

  expect(modelInfoFromCopilotTranscript(sessions)).toEqual([{
    id: "gpt-5.4-nano", name: "Nano", pickerEnabled: false,
    efforts: ["none", "low", "medium", "high", "xhigh"],
  }]);
});

test("reuses transcript metadata until a transcript's size or mtime changes", () => {
  const sessions = path.join(sandbox, "cached-sessions");
  const session = path.join(sessions, "fixture-session");
  fs.mkdirSync(session, { recursive: true });
  const transcript = path.join(session, "events.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "model.model_call_started", data: { modelInfo: {
    id: "cache-model", capabilities: { supports: { reasoning_effort: ["low"] } },
  } } }) + "\n");
  const read = spyOn(fs, "readSync");
  try {
    expect(modelInfoFromCopilotTranscript(sessions).map((model) => model.id)).toEqual(["cache-model"]);
    const reads = read.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(modelInfoFromCopilotTranscript(sessions).map((model) => model.id)).toEqual(["cache-model"]);
    expect(read.mock.calls.length).toBe(reads);
    fs.writeFileSync(transcript, JSON.stringify({ type: "model.model_call_started", data: { modelInfo: {
      id: "cache-model-updated", capabilities: { supports: { reasoning_effort: ["low", "high"] } },
    } } }) + "\n");
    expect(modelInfoFromCopilotTranscript(sessions).map((model) => model.id)).toEqual(["cache-model-updated"]);
    expect(read.mock.calls.length).toBeGreaterThan(reads);
  } finally { read.mockRestore(); }
});

test("persists account catalogues and always puts auto first", () => {
  writeCopilotModelCatalog("fixture-account", [
    { id: "model.fixture", name: "Fixture Model", efforts: ["low", "high"], pickerEnabled: true },
    { id: "auto", name: "Automatic", efforts: null, pickerEnabled: true },
    { id: "hidden", name: "Hidden", efforts: null, pickerEnabled: false },
  ]);
  expect(copilotModelCatalog("fixture-account").models.map((model) => model.id)).toEqual(["auto", "model.fixture"]);
  expect(copilotModelCatalog("unknown-account").models[0]?.id).toBe("auto");
});

test("uses the captured nano ladder and the full fallback for an unknown model", () => {
  expect(effortScale("copilot", "gpt-5.4-nano")).toEqual(["none", "low", "medium", "high", "xhigh"]);
  expect(effortScale("copilot", "new-model")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});
