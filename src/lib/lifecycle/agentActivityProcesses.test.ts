import { expect, spyOn, test } from "bun:test";
import { procBackend } from "@/lib/proc";
import { activityProcessReader } from "./agentActivityProcesses";
import { classifyAgentActivity } from "./agentActivity";
const now = 1_800_000_000_000;
test("process evidence uses one parent table and only live host descendants; pre-turn MCP is not work", () => {
  const parents = spyOn(procBackend, "ppidMap").mockReturnValue(new Map([[43, 42], [44, 43], [45, 42], [88, 99]]));
  const alive = spyOn(procBackend, "pidAlive").mockReturnValue(true);
  const exited = spyOn(procBackend, "processExited").mockImplementation(pid => pid === 45);
  const identity = spyOn(procBackend, "processIdentity").mockImplementation(pid => `${pid}:${Math.floor((now - (pid === 43 ? 1_000_000 : 60_000))/1000)}:0`);
  const argv = spyOn(procBackend, "readArgv").mockImplementation(pid => pid === 43 ? ["bun", "bin/mcp-server.mjs"] : ["bun", "scripts/privacy-publication-gate.ts"]);
  try {
    const read = activityProcessReader(now);
    const facts = { lastRecordAt: now - 660_000, turnStartedAt: now - 900_000, workProcesses: read(42) };
    expect(facts.workProcesses).toHaveLength(2);
    expect(classifyAgentActivity(facts, now)).toMatchObject({ state: "checking", check: "privacy-publication-gate" });
    read(99);
    expect(parents).toHaveBeenCalledTimes(1);
    expect(argv.mock.calls.some(args => args[0] === 45)).toBe(false);
  } finally { parents.mockRestore(); alive.mockRestore(); exited.mockRestore(); identity.mockRestore(); argv.mockRestore(); }
});


test("the persistent code executor is not work, but checks launched under it remain work", () => {
  let working = false;
  const parents = spyOn(procBackend, "ppidMap").mockReturnValue(new Map([[44, 42], [45, 44]]));
  const alive = spyOn(procBackend, "pidAlive").mockImplementation(pid => pid === 44 || working);
  const exited = spyOn(procBackend, "processExited").mockReturnValue(false);
  const identity = spyOn(procBackend, "processIdentity").mockImplementation(pid => `${pid}:${Math.floor((now - (pid === 44 ? 840_000 : 60_000))/1000)}:0`);
  const argv = spyOn(procBackend, "readArgv").mockImplementation(pid => pid === 44 ? ["/fixture/codex-code-mode-host"] : ["bun", "scripts/privacy-publication-gate.ts"]);
  try {
    const read = activityProcessReader(now);
    const facts = { lastRecordAt: now - 660_000, turnStartedAt: now - 900_000 };
    expect(classifyAgentActivity({ ...facts, workProcesses: read(42) }, now).state).toBe("idle");
    working = true;
    expect(classifyAgentActivity({ ...facts, workProcesses: read(42) }, now)).toMatchObject({ state: "checking", check: "privacy-publication-gate" });
  } finally { parents.mockRestore(); alive.mockRestore(); exited.mockRestore(); identity.mockRestore(); argv.mockRestore(); }
});


test("a live current-turn check with an unreadable command still prevents idle", () => {
  const parents = spyOn(procBackend, "ppidMap").mockReturnValue(new Map([[44, 42]]));
  const alive = spyOn(procBackend, "pidAlive").mockReturnValue(true);
  const exited = spyOn(procBackend, "processExited").mockReturnValue(false);
  const identity = spyOn(procBackend, "processIdentity").mockReturnValue(`44:${Math.floor((now - 60_000)/1000)}:0`);
  const argv = spyOn(procBackend, "readArgv").mockReturnValue([]);
  try {
    expect(classifyAgentActivity({ lastRecordAt: now - 660_000, turnStartedAt: now - 900_000, workProcesses: activityProcessReader(now)(42) }, now)).toMatchObject({ state: "checking", check: null });
  } finally { parents.mockRestore(); alive.mockRestore(); exited.mockRestore(); identity.mockRestore(); argv.mockRestore(); }
});
