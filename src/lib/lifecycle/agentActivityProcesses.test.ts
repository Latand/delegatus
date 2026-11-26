import { expect, spyOn, test } from "bun:test";
import { procBackend } from "@/lib/proc";
import { activityProcessReader, resourceActivityProcessReader } from "./agentActivityProcesses";
import { classifyAgentActivity } from "./agentActivity";
const now = 1_800_000_000_000;
test("resource background enrichment uses async process readers", async () => {
  const syncParents = spyOn(procBackend, "ppidMap");
  const syncList = spyOn(procBackend, "listProcesses");
  const syncArgv = spyOn(procBackend, "readArgv");
  const syncExited = spyOn(procBackend, "processExited");
  const parents = spyOn(procBackend, "resourcePpidMap").mockResolvedValue(new Map([[43, 42], [44, 43], [45, 42]]));
  const list = spyOn(procBackend, "resourceListProcesses").mockResolvedValue([
    { pid: 43, argv: ["bun", "bin/mcp-server.mjs"], cwd: "/fixture", tty: 0 },
    { pid: 44, argv: ["bun", "scripts/privacy-publication-gate.ts"], cwd: "/fixture", tty: 0 },
    { pid: 45, argv: ["bun", "retired.ts"], cwd: "/fixture", tty: 0 },
  ]);
  const alive = spyOn(procBackend, "pidAlive").mockReturnValue(true);
  const exited = spyOn(procBackend, "resourceProcessExited").mockImplementation(async pid => pid === 45);
  const identity = spyOn(procBackend, "processIdentity").mockImplementation(pid => `${pid}:${Math.floor((now - (pid === 43 ? 1_000_000 : 60_000))/1000)}:0`);
  try {
    const read = resourceActivityProcessReader(now);
    const facts = await read(42);
    expect(facts).toHaveLength(2);
    expect(facts.map(row => row.command)).toEqual(["bun bin/mcp-server.mjs", "bun scripts/privacy-publication-gate.ts"]);
    expect(classifyAgentActivity({ lastRecordAt: now - 660_000, turnStartedAt: now - 900_000, workProcesses: facts }, now))
      .toMatchObject({ state: "checking", check: "privacy-publication-gate" });
    await read(42);
    expect(parents).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(syncParents).not.toHaveBeenCalled();
    expect(syncList).not.toHaveBeenCalled();
    expect(syncArgv).not.toHaveBeenCalled();
    expect(syncExited).not.toHaveBeenCalled();
  } finally {
    syncParents.mockRestore(); syncList.mockRestore(); syncArgv.mockRestore(); syncExited.mockRestore();
    parents.mockRestore(); list.mockRestore(); alive.mockRestore(); exited.mockRestore(); identity.mockRestore();
  }
});

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
