import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { UnixRuntimeHostClient } from "./client";
import { projectSnapshotRead, type RuntimeActivitySession } from "./snapshotReads";

const metadata = { schemaVersion: 1, snapshotSeq: 12, retentionFloorSeq: 2, filesRevision: 7, runtime: { hostEpoch: 3, health: "healthy" } };
const session: RuntimeActivitySession = { conversationId: "conversation-😀", host: "hosted", turn: "running", attentionIds: ["attention"] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test("malformed projections remain unreadable, including wrong versions, missing fields and changed scope", () => {
  for (const invalid of [null, { ...metadata, schemaVersion: 2 }, { ...metadata, retentionFloorSeq: 13 },
    { ...metadata, snapshotRead: { version: 2, kind: "metadata" } }, { ...metadata, snapshotRead: { version: 1, kind: "owners" } }]) {
    expect(() => projectSnapshotRead(invalid, "metadata")).toThrow();
  }
  for (const sessions of [[{ ...session, attentionIds: null }], [{ ...session, host: "invalid" }]]) {
    expect(() => projectSnapshotRead({ ...metadata, sessions }, "activity", [session.conversationId])).toThrow();
  }
  expect(() => projectSnapshotRead({ ...metadata, sessions: [session], snapshotRead: { version: 1, kind: "activity" } }, "activity", ["absent"]))
    .toThrow("scope mismatch");
  expect(() => projectSnapshotRead({ ...metadata, sessions: [session] }, "owners")).toThrow();
});

test.each([2, 65])("activity preserves %s rows publishing one requested identity in response order", count => {
  const sessions = Array.from({ length: count }, (_, index) => ({
    ...session, turn: index === 0 ? "running" : "idle", attentionIds: [`attention-${index}`],
  }));
  for (const snapshotRead of [undefined, { version: 1, kind: "activity" }]) {
    const result = projectSnapshotRead({ ...metadata, sessions, snapshotRead }, "activity", [session.conversationId]);
    expect(result.sessions).toEqual(sessions);
    expect(result.sessions).toHaveLength(count);
  }
});

test.each(["refusal", "invalid-json", "wrong-id", "truncated", "timeout", "abort"] as const)(
  "narrow reads preserve %s failures without requesting a fallback snapshot", async failure => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-failure-"));
    const sockets = new Set<net.Socket>();
    let requests = 0;
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      let frame = "";
      socket.on("data", chunk => {
        frame += chunk.toString();
        if (!frame.includes("\n")) return;
        requests++;
        const request = JSON.parse(frame);
        if (failure === "refusal") socket.end(JSON.stringify({ id: request.id, ok: false, error: "runtime request method is unsupported" }) + "\n");
        if (failure === "invalid-json") socket.end("{broken\n");
        if (failure === "wrong-id") socket.end(JSON.stringify({ id: "wrong", ok: true, result: metadata }) + "\n");
        if (failure === "truncated") socket.end('{"id":');
        if (failure === "abort") abort.abort();
      });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const socketPath = path.join(root, "host.sock");
    server.listen(socketPath);
    await once(server, "listening");
    const abort = new AbortController();
    const client = new UnixRuntimeHostClient(socketPath, 100, 100, 100);
    await expect(client.readSnapshot("metadata", undefined, abort.signal)).rejects.toThrow();
    expect(requests).toBe(1);
  },
);

test("narrow reads retain split UTF-8 and frame boundaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-utf8-"));
  const server = net.createServer(socket => {
    socket.on("error", () => socket.destroy());
    socket.once("data", chunk => {
      const request = JSON.parse(chunk.toString());
      const frame = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { ...metadata, sessions: [session] } }) + "\n");
      const split = frame.indexOf(Buffer.from("😀")) + 1;
      socket.write(frame.subarray(0, split));
      setImmediate(() => socket.end(frame.subarray(split)));
    });
  });
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const socketPath = path.join(root, "host.sock");
  server.listen(socketPath);
  await once(server, "listening");
  expect((await new UnixRuntimeHostClient(socketPath).readSnapshot("activity", [session.conversationId])).sessions).toEqual([session]);
});
