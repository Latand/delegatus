import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { memorySource, engineMemoryOff, readMemorySourceFile, setMemorySource } from "./source";
import { roleMemoryEnabled } from "./settings";
import { SOURCE_STATES, CHANGED_AT, chooseSource, sourceTurnsEnginesOff } from "./fixtures/source";

let root: string;
const previous = { state: process.env.LLV_STATE_DIR, role: process.env.LLV_ROLE_MEMORY };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-source-")); process.env.LLV_STATE_DIR = root; delete process.env.LLV_ROLE_MEMORY; });
afterEach(() => {
  for (const [key, value] of Object.entries({ LLV_STATE_DIR: previous.state, LLV_ROLE_MEMORY: previous.role })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test.each([...SOURCE_STATES])("source %s keeps clean and role decisions separate", state => {
  chooseSource(state);
  expect(engineMemoryOff()).toBe(sourceTurnsEnginesOff(state));
  expect(engineMemoryOff({ cleanMemory: true })).toBe(true);
  expect(roleMemoryEnabled()).toBe(state !== "engines");
  process.env.LLV_ROLE_MEMORY = " OFF ";
  expect(roleMemoryEnabled()).toBe(false);
});

test("missing, malformed, unsupported and oversized files remain unchosen", () => {
  expect(memorySource()).toEqual({ choice: null, phase: null });
  for (const body of ["{", "null", "[]", '{}', JSON.stringify({ schemaVersion: 2, source: "engines", changedAt: CHANGED_AT }),
    JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "other", changedAt: CHANGED_AT }),
    JSON.stringify({ schemaVersion: 1, source: "delegatus", changedAt: CHANGED_AT }),
    JSON.stringify({ schemaVersion: 1, source: "engines", changedAt: "invalid" }), " ".repeat(8193)]) {
    fs.writeFileSync(statePath("memory-source.json"), body);
    expect(memorySource()).toEqual({ choice: null, phase: null });
    expect(engineMemoryOff()).toBe(false);
    expect(roleMemoryEnabled()).toBe(true);
  }
});

test("cached reads return copies, follow peer writes and root replacement, and retain import metadata", () => {
  chooseSource("active");
  const held = readMemorySourceFile()!; held.source = "engines";
  expect(memorySource()).toEqual({ choice: "delegatus", phase: "active" });
  expect(setMemorySource("engines", CHANGED_AT)).toBeNull();
  expect(readMemorySourceFile()).toMatchObject({ source: "engines", phase: "active", importId: "fixture-import" });
  const bytes = fs.readFileSync(statePath("memory-source.json"), "utf8");
  expect(setMemorySource("engines", "2026-10-18T00:00:00.000Z")).toBeNull();
  expect(fs.readFileSync(statePath("memory-source.json"), "utf8")).toBe(bytes);
  chooseSource("draining"); expect(engineMemoryOff()).toBe(true);
  process.env.LLV_STATE_DIR = path.join(root, "other"); expect(engineMemoryOff()).toBe(false);
  process.env.LLV_STATE_DIR = root; expect(engineMemoryOff()).toBe(true);
  chooseSource("unchosen"); expect(engineMemoryOff()).toBe(false);
});

test("the first choice waits for the import implementation", () => {
  expect(setMemorySource("delegatus")).toBe("import_unavailable");
  expect(setMemorySource("engines")).toBe("first_choice_delegatus");
  expect(fs.existsSync(statePath("memory-source.json"))).toBe(false);
  chooseSource("active");
  fs.rmSync(statePath("memory-source.json")); fs.mkdirSync(statePath("memory-source.json"));
  // A directory is malformed and cannot become an engine selection.
  expect(setMemorySource("engines")).toBe("first_choice_delegatus");
});

test("warm reads reuse one small parsed file; a fresh process follows durable choices", async () => {
  chooseSource("active");
  const read = spyOn(fs, "readSync");
  try {
    for (let n = 0; n < 100; n++) expect(engineMemoryOff()).toBe(true);
    expect(read.mock.calls).toHaveLength(1);
    expect((read.mock.calls[0][1] as Buffer).length).toBe(8193);
  } finally { read.mockRestore(); }
  async function fresh() {
    const code = `import { memorySource, engineMemoryOff } from ${JSON.stringify(path.join(import.meta.dir, "source.ts"))}; console.log(JSON.stringify({ ...memorySource(), off: engineMemoryOff() }));`;
    const child = Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0); expect(stderr).toBe(""); return JSON.parse(stdout);
  }
  expect(await fresh()).toEqual({ choice: "delegatus", phase: "active", off: true });
  expect(setMemorySource("engines")).toBeNull();
  expect(await fresh()).toEqual({ choice: "engines", phase: "active", off: false });
});
