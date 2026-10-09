import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, expect, test } from "bun:test";

import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

beforeEach(() => resetBlockingWaitsForTests(() => {}));

test("a snapshot rebuild records collection and serialization apart, and a cached read rebuilds nothing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-snapshot-timing-"));
  const journal = new RuntimeJournal(path.join(directory, "events.sqlite"), { now: () => 100 });
  try {
    journal.append({
      scope: runtimeScope("session", "conversation-timed"),
      kind: "session-status",
      payload: {
        conversationId: "conversation-timed",
        sessionKey: { engine: "codex", sessionId: "session-timed" },
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    const first = journal.snapshotJson();
    const sites = () => blockingWaitDiagnostics().sites;
    expect(sites()["snapshot-collect"]?.count).toBe(1);
    expect(sites()["snapshot-serialize"]?.count).toBe(1);
    expect(journal.snapshotRebuilds).toBe(1);

    /* Nothing changed: the cached frame answers and nothing is rebuilt. */
    expect(journal.snapshotJson()).toBe(first);
    expect(journal.snapshotJson()).toBe(first);
    expect(journal.snapshotCacheHits).toBe(2);
    expect(journal.snapshotRebuilds).toBe(1);
    expect(sites()["snapshot-collect"]?.count).toBe(1);

    journal.append({
      scope: runtimeScope("session", "conversation-timed"),
      kind: "session-status",
      payload: {
        conversationId: "conversation-timed",
        sessionKey: { engine: "codex", sessionId: "session-timed" },
        hostKind: "codex-app-server",
        host: "hosted",
        turn: "running",
        provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      },
    });
    journal.snapshotJson();
    expect(journal.snapshotRebuilds).toBe(2);
    expect(sites()["snapshot-collect"]?.count).toBe(2);
    /* Ids, codes and sizes only: no sample carries a payload. */
    for (const sample of blockingWaitDiagnostics().longest) {
      expect(JSON.stringify(sample)).not.toContain("session-timed");
    }
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
