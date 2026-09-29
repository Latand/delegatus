import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { externalRelayTempRoot } from "./runner";
import { procBackend } from "@/lib/proc";
import {
  ensureExternalRelayPollers,
  refreshExternalRelayPollers,
  refreshRelayTargets,
  refreshTargetsForRead,
  relayPollerStatus,
  stopExternalRelayPollers,
  sweepExternalRelayOrphans,
} from "./poller";
import { externalRelayFile, reserveRun, readRelayStore, readRunLedger, updateRelayStore, type PairedRelay, type RelayTargetSettings } from "./store";
import { startTestRelay } from "./testRelay";
import { noteRelayOutcome, noteRelayProgress } from "./activity";
import { sampleRequest } from "./protocol.test";
const root = fs.mkdtempSync(path.join(externalRelayTempRoot(), "relay-poller-test-"));
process.env.LLV_STATE_DIR = root;
const runDirs: string[] = [];
afterAll(() => {
  stopExternalRelayPollers();
  for (const dir of runDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
test("boot sweep settles dead owners, keeps live owners, and removes run directories", async () => {
  let completed = 0;
  const server = await startTestRelay(
    () => (completed++, { body: { status: "accepted", duplicate: false } }),
  );
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [
        {
          id: "relay",
          origin: server.origin,
          api_base: `${server.origin}/v1`,
          name: "Test",
          description: "",
          credential: "x".repeat(43),
          owner: {
            namespace: "test",
            id: "owner",
            display_name: "Owner",
            handle: null,
          },
          pairedAt: new Date().toISOString(),
          paused: true,
          limits: {
            max_response_bytes: 1048576,
            max_wait_s: 25,
            max_answer_chars: 4000,
          },
          targets: [],
        },
      ],
    }));
    const staleDir = fs.mkdtempSync(
      path.join(externalRelayTempRoot(), "llv-external-relay-test-"),
    );
    const liveDir = fs.mkdtempSync(
      path.join(externalRelayTempRoot(), "llv-external-relay-test-"),
    );
    runDirs.push(staleDir, liveDir);
    const row = {
      requestId: "stale",
      leaseId: "lease",
      relayId: "relay",
      targetId: "target",
      childPid: null,
      childIdentity: null,
      ownerPid: 999999999,
      ownerIdentity: "dead",
      runDir: staleDir,
      startedAt: new Date().toISOString(),
    };
    reserveRun(row);
    reserveRun({
      ...row,
      requestId: "live",
      ownerPid: process.pid,
      ownerIdentity: procBackend.processIdentity(process.pid),
      runDir: liveDir,
    });
    await sweepExternalRelayOrphans();
    expect(completed).toBe(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(liveDir)).toBe(true);
    expect(readRunLedger().runs.map((run) => run.requestId)).toEqual(["live"]);
  } finally {
    await server.close();
  }
});
test("staging never starts a claim loop", () => {
  process.env.LLV_STAGING = "1";
  try {
    ensureExternalRelayPollers();
  } finally {
    delete process.env.LLV_STAGING;
  }
});
for (const [status, code, expected] of [
  [401, "unauthorized", "credential_rejected"],
  [426, "unsupported_version", "unsupported_version"],
] as const)
  test(`${status} parks the claim loop`, async () => {
    const server = await startTestRelay(() => ({
      status,
      body: { error: { code, message: "refused" } },
    }));
    try {
      updateRelayStore((store) => ({
        ...store,
        relays: store.relays.map((relay) => ({
          ...relay,
          api_base: `${server.origin}/v1`,
          paused: false,
        })),
      }));
      ensureExternalRelayPollers();
      for (
        let i = 0;
        i < 30 && relayPollerStatus("relay").state !== expected;
        i++
      )
        await Bun.sleep(20);
      expect(relayPollerStatus("relay").state).toBe(expected);
    } finally {
      stopExternalRelayPollers();
      await server.close();
    }
  });
test("429 waits for Retry-After before another claim", async () => {
  let claims = 0;
  const server = await startTestRelay(
    (req) => (
      req.url?.endsWith("/requests/claim") && claims++,
      {
        status: 429,
        headers: { "retry-after": "1" },
        body: { error: { code: "rate_limited", message: "wait" } },
      }
    ),
  );
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({
        ...relay,
        api_base: `${server.origin}/v1`,
        paused: false,
      })),
    }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 30 && claims === 0; i++) await Bun.sleep(20);
    expect(claims).toBe(1);
    await Bun.sleep(250);
    expect(claims).toBe(1);
    await Bun.sleep(850);
    expect(claims).toBeGreaterThanOrEqual(2);
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
test("a refresh after receiving a claim completes its lease as declined", async () => {
  let claimAnswered = false;
  let refreshed = false;
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/requests/claim")) {
      if (claimAnswered) return { status: 204 };
      claimAnswered = true;
      return { body: { request: { ...sampleRequest, request_id: "rq_refresh" } } };
    }
    if (req.url?.endsWith("/complete")) {
      completions.push(body);
      return { body: { status: "accepted", duplicate: false } };
    }
    return { status: 404 };
  });
  const originalRead = fs.readFileSync;
  const originalRelays = readRelayStore().relays;
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{
        id: "refresh_relay", origin: server.origin, api_base: `${server.origin}/v1`,
        name: "Test", description: "", credential: "x".repeat(43),
        owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
        pairedAt: new Date().toISOString(), paused: false,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
        targets: [{
          id: "target_1", name: "Target", answered_by: "install", fallback: "service",
          enabled: true, engine: "codex", model: "gpt-6-sol", effort: "low",
          project: null, concurrency: 1, hardCapMinutes: 1,
        }],
      }],
    }));
    // Refresh at the store read between the received claim and dispatch.
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (claimAnswered && !refreshed && String(args[0]) === externalRelayFile("relays")) {
        refreshed = true;
        updateRelayStore((store) => ({
          ...store,
          relays: store.relays.map((relay) => ({ ...relay, paused: true })),
        }));
        refreshExternalRelayPollers("refresh_relay");
      }
      return originalRead(...args);
    }) as typeof fs.readFileSync;
    ensureExternalRelayPollers();
    for (let i = 0; i < 50 && completions.length === 0; i++) await Bun.sleep(20);
    expect(refreshed).toBe(true);
    expect(completions).toMatchObject([{ lease_id: sampleRequest.lease_id, outcome: "declined", reason: "disabled" }]);
  } finally {
    fs.readFileSync = originalRead;
    stopExternalRelayPollers();
    updateRelayStore((store) => ({ ...store, relays: originalRelays }));
    await server.close();
  }
});
test("route module copy controls the instrumentation poller", async () => {
  const routeCopy = await import("./poller.ts" + "?route-copy") as typeof import("./poller");
  const server = await startTestRelay(() => ({
    status: 401,
    body: { error: { code: "unauthorized", message: "refused" } },
  }));
  let changedClaims = 0;
  const changedServer = await startTestRelay(() => (
    changedClaims++,
    { status: 426, body: { error: { code: "unsupported_version", message: "upgrade" } } }
  ));
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({
        ...relay,
        api_base: `${server.origin}/v1`,
        paused: false,
      })),
    }));
    ensureExternalRelayPollers();
    for (
      let i = 0;
      i < 30 && relayPollerStatus("relay").state !== "credential_rejected";
      i++
    )
      await Bun.sleep(20);
    expect(routeCopy.relayPollerStatus("relay").state).toBe(
      "credential_rejected",
    );
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({ ...relay, paused: true })),
    }));
    routeCopy.refreshExternalRelayPollers("relay");
    expect(relayPollerStatus("relay").state).toBe("paused");
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({
        ...relay, api_base: `${changedServer.origin}/v1`, paused: false,
      })),
    }));
    routeCopy.refreshExternalRelayPollers("relay");
    for (
      let i = 0;
      i < 30 && relayPollerStatus("relay").state !== "unsupported_version";
      i++
    )
      await Bun.sleep(20);
    expect(relayPollerStatus("relay").state).toBe("unsupported_version");
    const priorClaims = changedClaims;
    updateRelayStore((store) => ({
      ...store,
      relays: [...store.relays, { ...store.relays[0], id: "new_relay" }],
    }));
    routeCopy.refreshExternalRelayPollers("new_relay");
    for (let i = 0; i < 30 && changedClaims === priorClaims; i++) await Bun.sleep(20);
    expect(changedClaims).toBeGreaterThan(priorClaims);
    expect(relayPollerStatus("new_relay").state).toBe("unsupported_version");
    updateRelayStore((store) => ({ ...store, relays: [] }));
    routeCopy.refreshExternalRelayPollers();
    expect(relayPollerStatus("relay").state).toBe("paused");
    expect(relayPollerStatus("new_relay").state).toBe("paused");
  } finally {
    routeCopy.stopExternalRelayPollers();
    await server.close();
    await changedServer.close();
  }
});
test("a corrupt run ledger logs the sweep failure and still starts polling", async () => {
  let claims = 0;
  // The targets read succeeds, so only the claim meets the 401.
  const server = await startTestRelay((req) => req.url?.endsWith("/targets")
    ? { body: { targets: [] } }
    : (
      claims++,
      { status: 401, body: { error: { code: "unauthorized", message: "refused" } } }
    ));
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{
        id: "corrupt_ledger", origin: server.origin, api_base: `${server.origin}/v1`,
        name: "Test", description: "", credential: "x".repeat(43),
        owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
        pairedAt: new Date().toISOString(), paused: false,
        limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
        targets: [],
      }],
    }));
    fs.writeFileSync(externalRelayFile("runs"), "{broken");
    ensureExternalRelayPollers();
    for (let i = 0; i < 30 && errors.length === 0; i++) await Bun.sleep(20);
    expect(errors.some((error) => error.startsWith("External relay orphan sweep failed SyntaxError"))).toBe(true);
    expect(relayPollerStatus("corrupt_ledger").state).toBe("unreachable");
    fs.writeFileSync(externalRelayFile("runs"), '{"v":1,"runs":[]}');
    for (let i = 0; i < 60 && claims === 0; i++) await Bun.sleep(100);
    expect(claims).toBeGreaterThan(0);
  } finally {
    console.error = originalError;
    fs.writeFileSync(externalRelayFile("runs"), '{"v":1,"runs":[]}');
    stopExternalRelayPollers();
    await server.close();
  }
}, 10_000);
test("the last outcome and progress outlive a poll loop restarted by a settings change", async () => {
  const server = await startTestRelay(() => ({ status: 204 }));
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => ({ ...relay, api_base: `${server.origin}/v1`, paused: false })),
    }));
    const id = readRelayStore().relays[0]!.id;
    ensureExternalRelayPollers();
    noteRelayOutcome(id, "declined:busy");
    noteRelayProgress(id, "target_1", { kind: "note", label: "Reading the thread", tool: null, status: null, at: "2026-09-28T10:00:00.000Z" });
    refreshExternalRelayPollers(id);
    expect(relayPollerStatus(id)).toMatchObject({
      lastOutcome: "declined:busy",
      lastProgress: { targetId: "target_1", label: "Reading the thread" },
    });
    expect(relayPollerStatus(id).lastOutcomeAt).not.toBeNull();
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
const configured = (id: string, name = id): RelayTargetSettings => ({
  id, name, answered_by: "install", fallback: "service", enabled: true,
  engine: "codex", model: "gpt-6-sol", effort: "low", project: "repo-x",
  concurrency: 2, hardCapMinutes: 7,
});
function pairedRelay(id: string, origin: string, targets: RelayTargetSettings[]): PairedRelay {
  return {
    id, origin, api_base: `${origin}/v1`, name: "Test", description: "",
    credential: "x".repeat(43),
    owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: new Date().toISOString(), paused: false,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets,
  };
}
const storedTargets = (id: string) =>
  readRelayStore().relays.find((relay) => relay.id === id)?.targets;
test("the claim loop refreshes targets first, merges them, and advertises slots from the new list", async () => {
  const slots: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/targets"))
      return { body: { targets: [
        { target_id: "kept", name: "Renamed", answered_by: "install", fallback: "none" },
        { target_id: "added", name: "New", answered_by: "service", fallback: "service" },
      ] } };
    if (req.url?.endsWith("/requests/claim")) {
      slots.push((body as { slots: unknown }).slots);
      return { status: 204 };
    }
    return { status: 404 };
  });
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [pairedRelay("loop_refresh", server.origin, [configured("kept"), configured("gone")])],
    }));
    ensureExternalRelayPollers();
    for (let i = 0; i < 50 && slots.length === 0; i++) await Bun.sleep(20);
    expect(storedTargets("loop_refresh")).toEqual([
      { ...configured("kept"), name: "Renamed", fallback: "none" },
      {
        id: "added", name: "New", answered_by: "service", fallback: "service",
        enabled: true, engine: null, model: null, effort: null, project: null,
        concurrency: 1, hardCapMinutes: 30,
      },
    ]);
    // "gone" is no longer offered and "added" waits for its settings.
    expect(slots[0]).toEqual([{ target_id: "kept", free: 2 }]);
    expect(relayPollerStatus("loop_refresh").state).toBe("polling");
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
test("a settings read refreshes at most once per interval and joins a refresh on the wire", async () => {
  let reads = 0;
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const server = await startTestRelay(async (req) => {
    if (!req.url?.endsWith("/targets")) return { status: 404 };
    reads++;
    if (gate) await gate;
    return { body: { targets: [
      { target_id: "kept", name: "Kept", answered_by: "install", fallback: "service" },
    ] } };
  });
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{ ...pairedRelay("rate_limited_read", server.origin, [configured("kept", "Kept")]), paused: true }],
    }));
    await refreshTargetsForRead();
    expect(reads).toBe(1);
    await refreshTargetsForRead();
    expect(await refreshRelayTargets("rate_limited_read", 30_000)).toBe("skipped");
    expect(reads).toBe(1);
    gate = new Promise((resolve) => { release = resolve; });
    const first = refreshRelayTargets("rate_limited_read");
    const joined = refreshRelayTargets("rate_limited_read");
    expect(joined).toBe(first);
    release();
    expect(await first).toBe("unchanged");
    expect(reads).toBe(2);
    expect(storedTargets("rate_limited_read")).toEqual([configured("kept", "Kept")]);
  } finally {
    await server.close();
  }
});
test("a 401 on the targets read parks the claim loop as credential_rejected", async () => {
  let claims = 0;
  const server = await startTestRelay((req) => {
    if (req.url?.endsWith("/requests/claim")) claims++;
    return { status: 401, body: { error: { code: "unauthorized", message: "revoked" } } };
  });
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [pairedRelay("rejected_targets", server.origin, [configured("kept")])],
    }));
    ensureExternalRelayPollers();
    for (
      let i = 0;
      i < 50 && relayPollerStatus("rejected_targets").state !== "credential_rejected";
      i++
    )
      await Bun.sleep(20);
    expect(relayPollerStatus("rejected_targets").state).toBe("credential_rejected");
    await Bun.sleep(100);
    expect(claims).toBe(0);
    expect(storedTargets("rejected_targets")).toEqual([configured("kept")]);
    expect(await refreshRelayTargets("rejected_targets")).toBe("credential_rejected");
  } finally {
    stopExternalRelayPollers();
    await server.close();
  }
});
test("a 5xx, an invalid body or a network error keeps the stored targets and says so on the activity line", async () => {
  let reply: { status?: number; body?: unknown } = { status: 503 };
  const server = await startTestRelay(() => reply);
  const kept = [configured("kept"), configured("other")];
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: [{ ...pairedRelay("failing_targets", server.origin, kept), paused: true }],
    }));
    expect(await refreshRelayTargets("failing_targets")).toBe("failed");
    expect(storedTargets("failing_targets")).toEqual(kept);
    expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:unreachable");
    for (const body of [{ targets: [{ target_id: "kept" }] }, { targets: "none" }]) {
      reply = { body };
      expect(await refreshRelayTargets("failing_targets")).toBe("failed");
      expect(storedTargets("failing_targets")).toEqual(kept);
      expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:malformed");
    }
    reply = { status: 429, body: { error: { code: "rate_limited", message: "wait" } } };
    expect(await refreshRelayTargets("failing_targets")).toBe("failed");
    expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:rate_limited");
  } finally {
    await server.close();
  }
  noteRelayOutcome("failing_targets", "answered");
  expect(await refreshRelayTargets("failing_targets")).toBe("failed");
  expect(storedTargets("failing_targets")).toEqual(kept);
  expect(relayPollerStatus("failing_targets").lastOutcome).toBe("targets:unreachable");
  // An empty list from the service is a real answer: every target goes.
  const empty = await startTestRelay(() => ({ body: { targets: [] } }));
  try {
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) =>
        relay.id === "failing_targets" ? { ...relay, api_base: `${empty.origin}/v1` } : relay),
    }));
    expect(await refreshRelayTargets("failing_targets")).toBe("changed");
    expect(storedTargets("failing_targets")).toEqual([]);
  } finally {
    await empty.close();
  }
});
