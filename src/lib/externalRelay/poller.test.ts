import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { externalRelayTempRoot } from "./runner";
import { procBackend } from "@/lib/proc";
import {
  ensureExternalRelayPollers,
  relayPollerStatus,
  stopExternalRelayPollers,
  sweepExternalRelayOrphans,
} from "./poller";
import { putRun, readRunLedger, updateRelayStore } from "./store";
import { startTestRelay } from "./testRelay";
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
    putRun(row);
    putRun({
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
    () => (
      claims++,
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
