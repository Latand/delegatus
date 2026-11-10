import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";

import { retireDeadPaneHostRows } from "./reaperRuntime";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pane-host-rows-"));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

function paneHost(agentPid: number): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: "/tmp",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: `%${agentPid}`,
    panePid: { pid: agentPid - 1000, startIdentity: `${agentPid - 1000}:one` },
    windowName: "worker",
    agent: { pid: agentPid, startIdentity: `${agentPid}:one` },
    argv: ["codex"],
  };
}

function sessionId(index: number): string {
  return `019f5${String(index).padStart(7, "0")}-1111-7111-8111-111111111111`;
}

/* A registry written while agents ran in terminal panes still reads, and a
   row whose recorded agent process is gone stops claiming a host without any
   terminal multiplexer being asked. */
test("a pane-hosted row whose agent process is gone becomes unhosted; a live one is kept", async () => {
  const registry = new AgentRegistry(path.join(DIR, "agent-registry.json"));
  for (const [index, agentPid] of [[1, 2001], [2, 2002]] as const) {
    registry.upsert({
      key: { engine: "codex", sessionId: sessionId(index) },
      artifactPath: `/transcripts/rollout-${sessionId(index)}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: paneHost(agentPid),
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
  }
  const identity = (pid: number) => pid === 2002 ? "2002:one" : pid === 2001 ? "2001:recycled" : null;

  expect(await retireDeadPaneHostRows(registry, identity, () => false)).toBe(1);

  const entries = registry.snapshot().entries;
  expect(entries[`codex:${sessionId(1)}`]).toMatchObject({ host: null, status: "unhosted" });
  expect(entries[`codex:${sessionId(2)}`]).toMatchObject({ status: "live", host: { kind: "tmux", paneId: "%2002" } });
  expect(await retireDeadPaneHostRows(registry, identity, () => false)).toBe(0);
});
