import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneFileCallBudgetMs } from "./cloneToolBudget";
import { clonePairing } from "./clone.fixture";
import { externalRelayFile, writeRelayFile } from "./store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-tool-budget-")), prior = process.env.LLV_STATE_DIR;
afterAll(() => { if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); });
test("file waiting extends only for an active advertised pairing and never creates settings", () => {
  process.env.LLV_STATE_DIR = root;
  const file = externalRelayFile("relays"), relay = clonePairing("https://example.invalid");
  expect(cloneFileCallBudgetMs()).toBeNull(); expect(fs.existsSync(file)).toBe(false);
  const save = () => writeRelayFile(file, { v: 1, installId: "fixture-install", label: "Fixture", relays: [relay], pending: [] });
  save(); expect(cloneFileCallBudgetMs()).toBeNull();
  relay.features = ["clone_send_methods"]; save(); expect(cloneFileCallBudgetMs()).toBe(480000);
  relay.paused = true; save(); expect(cloneFileCallBudgetMs()).toBeNull();
  fs.writeFileSync(file, "invalid"); expect(cloneFileCallBudgetMs()).toBeNull();
});
