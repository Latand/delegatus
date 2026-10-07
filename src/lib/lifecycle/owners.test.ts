/* The census of recorded processes (docs/design/update-drain-liveness.md,
   R1, R2, R4, R6), as a pure function of a literal registry and a probe. */
import { expect, test } from "bun:test";

import type { AgentRegistryEntry, RegistryFile, SpawnReceipt } from "@/lib/agent/registry";
import type { Flow } from "@/lib/flows/types";

import { censusIndex, entryOwners, ownerProcessAlive, registryOwners, type CensusViewer } from "./owners";

const NOW = Date.parse("2026-07-26T08:40:00.000Z");
const START = "start-token";
const probe = (alive: boolean | ((pid: number) => boolean), identity: (pid: number) => string | null = () => START) => ({
  now: () => NOW,
  pidAlive: (pid: number) => typeof alive === "function" ? alive(pid) : alive,
  processIdentity: identity,
});
const claimOwner = (pid: number, startIdentity: string | null = START) => `structured-host:${JSON.stringify({ pid, startIdentity })}`;

function structured(pid: number | null, overrides: Partial<AgentRegistryEntry> = {}, epoch = 1): AgentRegistryEntry {
  return {
    key: { engine: "codex", sessionId: "session" } as AgentRegistryEntry["key"],
    artifactPath: "/sessions/host.jsonl", cwd: "/repo", accountId: null, status: "live", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:host", process: pid === null ? null : { pid, startIdentity: START },
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: epoch, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: epoch, claimOwner: null, pendingAction: null, updatedAt: new Date(NOW).toISOString(), ...overrides,
  };
}

function tmux(agent: number, pane: number): NonNullable<AgentRegistryEntry["host"]> {
  return { kind: "tmux", endpoint: "/tmp/tmux.sock", server: { pid: 1000, startIdentity: "server" }, paneId: "%1",
    panePid: { pid: pane, startIdentity: START }, windowName: "agent", agent: { pid: agent, startIdentity: START }, argv: ["agent"] };
}

const roles = (entry: AgentRegistryEntry, alive: Parameters<typeof probe>[0], viewer: CensusViewer | null = null) => {
  const read = entryOwners(entry, probe(alive), { viewer });
  return { owners: read.owners.map((owner) => `${owner.role}:${owner.kind}:${owner.pid}:${ownerProcessAlive(owner, probe(alive)) ? "alive" : "gone"}`),
    ownerless: read.ownerless?.kind ?? null };
};

test("each process an entry records is an owner at the entry's artifact, alive only under its recorded identity (R2, R4)", () => {
  expect(roles(structured(4242), true)).toEqual({ owners: ["host:structured:4242:alive"], ownerless: null });
  expect(roles(structured(4242), false)).toEqual({ owners: ["host:structured:4242:gone"], ownerless: null });
  // A status word that says dead over a process that still answers: the process is the owner.
  expect(roles(structured(4242, { status: "dead" }), true)).toEqual({ owners: ["host:structured:4242:alive"], ownerless: null });
  // A pid answering under another start identity is gone.
  expect(roles(structured(4242), true).owners).toEqual(["host:structured:4242:alive"]);
  expect(entryOwners(structured(4242), probe(true, () => "another-process")).owners.map((owner) => ownerProcessAlive(owner, probe(true, () => "another-process")))).toEqual([false]);
  // A child that survived its termination is an owner of its own.
  const survivor = structured(null, { status: "dead", structuredHost: null, structuredTerminationSurvivors: [{ pid: 4243, startIdentity: START }] });
  expect(roles(survivor, true)).toEqual({ owners: ["host:structured:4243:alive"], ownerless: null });
  // A tmux host is one owner, alive while its agent or its pane answers, and has no writer.
  const pane = structured(null, { host: tmux(1112, 1111), structuredHost: null, claimEpoch: 0 });
  expect(roles(pane, (pid) => pid === 1111)).toEqual({ owners: ["host:tmux:1112:alive"], ownerless: null });
  expect(entryOwners(pane, probe(true)).owners[0]!.writerEpoch).toBeNull();
  // An entry keeping a predecessor's structured columns beside a tmux host has no writer either.
  const kept = structured(2222, { host: tmux(1112, 1111) });
  expect(entryOwners(kept, probe(true)).owners.map((owner) => owner.writerEpoch)).toEqual([null, null]);
});

test("a hosted row that records no process is an ownerless record; a terminal one records nothing (R2, R8)", () => {
  const launching = structured(null, { status: "starting", claimEpoch: 0, structuredHost: null });
  expect(roles(launching, false)).toEqual({ owners: [], ownerless: "hosted-row" });
  expect(entryOwners(launching, probe(false)).ownerless?.updatedAt).toBe(NOW);
  expect(roles({ ...launching, status: "dead" }, false)).toEqual({ owners: [], ownerless: null });
});

test("a writer claim is a setup owner only when it is doing setup (R6)", () => {
  const setup = structured(null, { status: "dead", claimOwner: claimOwner(4243) });
  // No live host recorded: the claimant holds while it lives.
  expect(roles(setup, true).owners).toEqual(["setup:structured:4243:alive"]);
  expect(roles(setup, false).owners).toEqual(["setup:structured:4243:gone"]);
  // A claim at a stale epoch is no current claim.
  expect(roles(structured(null, { status: "dead", claimOwner: claimOwner(4243), claimEpoch: 2 }), true).owners).toEqual([]);
  // A terminal row adopted while it still records the previous host: the claimant is setup beside it.
  const adopted = structured(4242, { status: "dead", claimOwner: claimOwner(4243) });
  expect(roles(adopted, true).owners).toEqual(["host:structured:4242:alive", "setup:structured:4243:alive"]);
  // a. The claimant is the host process itself.
  expect(roles(structured(4242, { status: "dead", claimOwner: claimOwner(4242) }), true).owners).toEqual(["host:structured:4242:alive"]);
  // b. The claimant is this Viewer, which holds a handle under the row's key.
  const viewer = { identity: { pid: 4243, startIdentity: START }, heldKeys: new Set(["codex:session"]) };
  expect(roles(adopted, true, viewer).owners).toEqual(["host:structured:4242:alive"]);
  expect(roles(adopted, true, { ...viewer, heldKeys: new Set() }).owners).toEqual(["host:structured:4242:alive", "setup:structured:4243:alive"]);
  // c. A hosted row with a live host: the registry refuses a new claim over it, so the claim is that host's writer.
  expect(roles({ ...adopted, status: "idle" }, true).owners).toEqual(["host:structured:4242:alive"]);
  expect(roles({ ...adopted, status: "idle" }, (pid) => pid !== 4242).owners).toEqual(["host:structured:4242:gone", "setup:structured:4243:alive"]);
  // A tmux host recorded beside an adopting claim.
  const tmuxAdopted = structured(null, { status: "dead", host: tmux(1112, 1111), claimOwner: claimOwner(4243) });
  expect(roles(tmuxAdopted, true).owners).toEqual(["host:tmux:1112:alive", "setup:structured:4243:alive"]);
  // A claim string that names no process records nothing.
  expect(roles(structured(null, { status: "dead", claimOwner: "foreign-owner" }), true).owners).toEqual([]);
});

function registry(parts: Partial<RegistryFile>): RegistryFile {
  return { entries: {}, conversations: {}, conversationAliases: {}, receipts: {}, ...parts } as unknown as RegistryFile;
}

function receipt(overrides: Partial<SpawnReceipt>): SpawnReceipt {
  return { launchId: "launch", conversationId: "conversation_host", engine: "codex", cwd: "/repo", transport: "structured",
    state: "starting", artifactPath: "/sessions/launch.jsonl", key: null, admissionOwner: null, verifiedHost: null, pane: null,
    queuedPinnedSpawn: null, createdAt: new Date(NOW).toISOString(), ...overrides } as unknown as SpawnReceipt;
}

test("receipts and flow rounds record processes; one an entry already records is not a second owner (R1, R2)", () => {
  const conversation = { id: "conversation_host", engine: "codex", generations: [{ id: "session", path: "/sessions/host.jsonl" }], continuityPaths: [] };
  const file = registry({
    entries: { "codex:session": structured(4242) },
    conversations: { conversation_host: conversation } as never,
    receipts: {
      admitted: receipt({ launchId: "admitted", admissionOwner: { pid: 5000, startIdentity: START } }),
      launched: receipt({ launchId: "launched", state: "completed", verifiedHost: { agent: { pid: 4242, startIdentity: START } } as never }),
      unowned: receipt({ launchId: "unowned" }),
      queued: receipt({ launchId: "queued", queuedPinnedSpawn: { retryAt: new Date(NOW).toISOString() } as never }),
    } as never,
  });
  const flows = [{ id: "flow", reviewerMode: "headless", rounds: [
    { n: 1, reviewerPid: 6000, reviewerIdentity: START, reviewerConversationId: "conversation_host", reviewerPath: null },
    { n: 2, reviewerPid: 4242, reviewerIdentity: START, reviewerPath: "/sessions/host.jsonl" },
  ] }] as unknown as Flow[];
  const census = registryOwners(file, flows, probe(true));
  expect(census.owners.map((owner) => `${owner.role}:${owner.pid}:${owner.binding}`).sort()).toEqual([
    "host:4242:conversation_host", "reviewer:6000:conversation_host", "setup:5000:conversation_host",
  ]);
  // An open receipt with no admission owner is ownerless; one queued for account capacity has started nothing.
  expect(census.ownerless.map((record) => record.id)).toEqual(["open-receipt:unowned"]);
});

test("a hosted row a headless round records the process for is that round's owner, never a second, ownerless one (R1)", () => {
  const file = registry({
    entries: { "codex:reviewer": { ...structured(null, { status: "starting", structuredHost: null, claimEpoch: 0 }),
      key: { engine: "codex", sessionId: "reviewer" }, artifactPath: "/sessions/reviewer.jsonl" } as AgentRegistryEntry },
  });
  const round = { n: 1, reviewerPid: 6000, reviewerIdentity: START, reviewerPath: "/sessions/reviewer.jsonl" };
  expect(registryOwners(file, [], probe(true)).ownerless).toHaveLength(1);
  const census = registryOwners(file, [{ id: "flow", reviewerMode: "headless", rounds: [round] }] as unknown as Flow[], probe(true));
  expect(census.ownerless).toEqual([]);
  expect(census.owners.map((owner) => owner.role)).toEqual(["reviewer"]);
});

test("a reference reaches every owner bound to its conversation, path or key, and the registry says what it names (R9, R10)", () => {
  const conversation = { id: "conversation_host", engine: "codex", continuityPaths: ["/sessions/continuity.jsonl"],
    generations: [{ id: "earlier", path: "/sessions/earlier.jsonl" }, { id: "session", path: "/sessions/host.jsonl" }] };
  const sibling = { ...structured(4244), key: { engine: "codex", sessionId: "sibling" }, artifactPath: "/sessions/host.jsonl" } as AgentRegistryEntry;
  const earlier = { ...structured(4241), key: { engine: "codex", sessionId: "earlier" }, artifactPath: "/sessions/earlier.jsonl" } as AgentRegistryEntry;
  const file = registry({
    entries: { "codex:session": structured(4242), "codex:sibling": sibling, "codex:earlier": earlier },
    conversations: { conversation_host: conversation } as never,
    conversationAliases: { conversation_before: "conversation_host" } as never,
  });
  const census = registryOwners(file, [], probe(true));
  const index = censusIndex(file);
  const pids = (reference: Parameters<typeof index.boundTo>[1]) => index.boundTo(census.owners, reference).map((owner) => owner.pid).sort();
  expect(pids({ conversationId: "conversation_host" })).toEqual([4241, 4242, 4244]);
  expect(pids({ conversationId: "conversation_before" })).toEqual([4241, 4242, 4244]);
  // A deleted earlier path or a continuity path still reaches the conversation's processes.
  expect(pids({ conversationId: "flow:legacy", artifactPath: "/sessions/continuity.jsonl" })).toEqual([4241, 4242, 4244]);
  expect(pids({ conversationId: "stage:path-only", artifactPath: "/sessions/elsewhere.jsonl" })).toEqual([]);
  expect(pids({ conversationId: "conversation_elsewhere", sessionKey: { engine: "codex", sessionId: "sibling" } })).toEqual([4244]);
  expect(index.names({ conversationId: "conversation_before" })).toBe(true);
  expect(index.names({ conversationId: "conversation_elsewhere" })).toBe(false);
  expect(index.names({ conversationId: "conversation_elsewhere", artifactPath: "/sessions/continuity.jsonl" })).toBe(true);
  expect(index.names({ conversationId: "conversation_elsewhere", sessionKey: { engine: "codex", sessionId: "earlier" } })).toBe(true);
});
