import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { installPipelineControllerIndex } from "./pipelineControllerIndex";
import { isOperatorOwnedDirectory } from "@/lib/stateOwnership";

const original = { owner: process.env.LLV_STATE_OWNER, config: process.env.XDG_CONFIG_HOME };
afterEach(() => {
  for (const [key, value] of [["LLV_STATE_OWNER", original.owner], ["XDG_CONFIG_HOME", original.config]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("an MCP reader leaves a missing controller index to its owner without losing existing rows", () => {
  // Only the classifier receives this synthetic path. All data stays in memory.
  process.env.XDG_CONFIG_HOME = "/state-owner-fixture/config";
  process.env.LLV_STATE_OWNER = "mcp";
  const directory = "/state-owner-fixture/config/agent-log-viewer/state";
  expect(isOperatorOwnedDirectory(directory)).toBe(true);
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE state_rows(collection TEXT, row_key TEXT, value_json TEXT, row_order INTEGER)");
    db.run("INSERT INTO state_rows VALUES ('pipelines','pipeline-fixture',?,1)", [JSON.stringify({ state: "running", runs: [] })]);
    const before = db.query("SELECT * FROM state_rows").all();
    expect(() => installPipelineControllerIndex(db, directory)).not.toThrow();
    expect(db.query("SELECT * FROM state_rows").all()).toEqual(before);
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'pipeline_controller_work%'").all()).toEqual([]);

    process.env.LLV_STATE_OWNER = "runtime-host";
    installPipelineControllerIndex(db, directory);
    expect(db.query("SELECT row_key FROM pipeline_controller_work WHERE kind='running'").all()).toEqual([{ row_key: "pipeline-fixture" }]);
    // An older peer's ordinary write updates the new projection atomically.
    db.run("UPDATE state_rows SET value_json=? WHERE row_key='pipeline-fixture'", [JSON.stringify({ state: "closed", runs: [] })]);
    expect(db.query("SELECT row_key FROM pipeline_controller_work WHERE kind='running'").all()).toEqual([]);
    process.env.LLV_STATE_OWNER = "mcp";
    expect(() => installPipelineControllerIndex(db, directory)).not.toThrow();
  } finally { db.close(); }
});
