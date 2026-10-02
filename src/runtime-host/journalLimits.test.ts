import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRuntimeBus, type EventSourceLike } from "@/hooks/runtimeBus";
import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

class Stream implements EventSourceLike {
  onopen = null;
  onerror = null;
  onmessage: EventSourceLike["onmessage"] = null;
  addEventListener() {}
  close() {}
  message(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("limits projected before join and during idle never cause a resnapshot; a missed revision still recovers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-limits-"));
  const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"));
  const scope = runtimeScope("session", "conversation-example");
  journal.append({ scope, kind: "session-status", payload: { host: "hosted", turn: "idle" } });
  const limits = () => journal.append({ scope, kind: "limits", payload: { snapshot: { remaining: 80 } } });
  limits(); // The production failure starts with limits already included in snapshotSeq.
  let fetches = 0;
  const streams: Stream[] = [];
  const bus = createRuntimeBus({
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      fetches++;
      const snapshot = journal.snapshot();
      return { ok: true, status: 200, json: async () => snapshot } as Response;
    },
    createEventSource: () => { const stream = new Stream(); streams.push(stream); return stream; },
  });
  try {
    bus.start();
    await flush();
    for (let i = 0; i < 20; i++) {
      streams.at(-1)!.message(limits());
      await flush();
    }
    expect(fetches).toBe(1);
    expect(bus.getState().store.scopeHeads["session:conversation-example"]).toBe(22);

    const revisions: number[] = [];
    bus.subscribeFilesRevision(revision => revisions.push(revision));
    limits(); // A genuinely lost event must keep the #2407 recovery path.
    journal.append({ scope: runtimeScope("system", "files"), kind: "files.revision", payload: { filesRevision: 7 } });
    streams.at(-1)!.message(limits());
    await flush();
    expect(fetches).toBe(2);
    expect(revisions).toEqual([7]);
    streams.at(-1)!.message(limits());
    await flush();
    expect(fetches).toBe(2);
    expect(bus.getState().store.scopeHeads["session:conversation-example"]).toBe(25);
  } finally {
    bus.stop();
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a limits-only session head survives reopening and producer redelivery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-limits-reopen-"));
  const filename = path.join(directory, "journal.sqlite");
  const input = { scope: runtimeScope("session", "conversation-example"), kind: "limits" as const, payload: {}, producerKey: "limits-one" };
  let journal = new RuntimeJournal(filename);
  try {
    const event = journal.append(input);
    journal.close();
    journal = new RuntimeJournal(filename);
    expect(journal.append(input).seq).toBe(event.seq);
    expect(journal.snapshot().sessions[0]).toMatchObject({ conversationId: "conversation-example", revision: event.revision });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("informational session events advance only their own session projection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-session-head-"));
  const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"));
  const scope = runtimeScope("session", "conversation-example");
  try {
    journal.append({ scope, kind: "session-status", payload: { host: "hosted", turn: "running", activeTurnId: "turn-example" } });
    journal.append({ scope, kind: "delta", payload: { turnId: "turn-example", text: "Preserved answer" } });
    const previous = journal.snapshot().sessions[0]!;
    const event = journal.append({ scope, kind: "future-session-signal", payload: {} });
    journal.append({ scope: runtimeScope("account", "example"), kind: "limits", payload: {} });
    expect(journal.snapshot().sessions).toEqual([{ ...previous, revision: event.revision }]);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
