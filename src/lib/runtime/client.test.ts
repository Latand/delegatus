import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { viewerDeploymentListCursor } from "./contracts";

import {
  resetRuntimeHostRequestHealthForTests,
  RuntimeHostUnavailableError,
  runtimeHostRequestHealth,
  UnixRuntimeHostClient,
} from "./client";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-client-"));
const servers: net.Server[] = [];
const connections: net.Socket[] = [];

afterAll(async () => {
  for (const socket of connections) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function serve(onRequest: (frame: string, socket: net.Socket) => void, socketPath = path.join(SANDBOX, `${crypto.randomUUID().slice(0, 8)}.sock`)): string {
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      onRequest(buffer.slice(0, newline), socket);
    });
  });
  server.listen(socketPath);
  servers.push(server);
  return socketPath;
}

test("snapshot forwards its abort signal and settles exactly once on external abort", async () => {
  const socketPath = serve(() => {
    /* never respond — the abort must settle the request */
  });
  const client = new UnixRuntimeHostClient(socketPath, 60_000, 60_000, 60_000);
  const abort = new AbortController();
  const request = client.snapshot(abort.signal);
  const outcome = request.then(() => "resolved", (error) => error);
  abort.abort();
  const settled = await outcome;
  expect(settled).toBeInstanceOf(RuntimeHostUnavailableError);
  expect((settled as Error).message).toBe("runtime host request cancelled");
});

test("startup snapshot deadline is caller-local and never sent to the runtime host", async () => {
  const requests: unknown[] = [];
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    requests.push(request.params);
    setTimeout(() => {
      if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, ok: true, result: { revision: 9 } }) + "\n");
    }, 80);
  });
  const client = new UnixRuntimeHostClient(socketPath, 20, 20, 20);
  expect(await client.snapshot(undefined, { timeoutMs: 500 })).toEqual({ revision: 9 } as never);
  await expect(client.snapshot()).rejects.toThrow("runtime host request timed out");
  expect(requests).toEqual([undefined, undefined]);
});

test("startup keyed read deadline is bounded and leaves interactive reads and wire parameters unchanged", async () => {
  const requests: unknown[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    requests.push(request.params);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, ok: true, result: null }) + "\n");
    }, 80);
    timers.add(timer);
  });
  const client = new UnixRuntimeHostClient(socketPath, 20);
  const identity = { conversationId: "conversation_slow" };
  try {
    expect(await client.readSession(identity, { timeoutMs: 500 })).toBeNull();
    await expect(client.readSession(identity)).rejects.toThrow("runtime host request timed out");
    await expect(client.readSession(identity, { timeoutMs: 30 })).rejects.toThrow("runtime host request timed out");
    expect(requests).toEqual([identity, identity, identity]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test("a timeout, a late response, and a socket teardown settle the call exactly once", async () => {
  let respond: ((frame: string, socket: net.Socket) => void) | null = null;
  const socketPath = serve((frame, socket) => { respond?.(frame, socket); });
  const client = new UnixRuntimeHostClient(socketPath, 40, 40, 40);
  let requestSocket: net.Socket | null = null;
  let requestFrame = "";
  respond = (frame, socket) => {
    requestFrame = frame;
    requestSocket = socket;
  };
  const settlements: unknown[] = [];
  await client.snapshot().then(
    (value) => settlements.push({ value }),
    (error) => settlements.push({ error }),
  );
  expect(settlements).toHaveLength(1);
  expect((settlements[0] as { error: Error }).error.message).toBe("runtime host request timed out");

  // A response arriving after the timeout destroyed the client socket must not
  // produce a second settlement or an unhandled error.
  const request = JSON.parse(requestFrame) as { id: string };
  requestSocket!.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settlements).toHaveLength(1);
});

test("a timeout log identifies the runtime request method and elapsed time", async () => {
  resetRuntimeHostRequestHealthForTests();
  const socketPath = serve(() => {
    /* never respond — the request must reach its timeout */
  });
  const client = new UnixRuntimeHostClient(socketPath, 20, 20, 20);
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(client.events(0)).rejects.toThrow("runtime host request timed out");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(
      /^\[runtime host\] request timed out method=events elapsedMs=\d+$/,
    );
    expect(runtimeHostRequestHealth()).toEqual({
      samples: 1,
      p95Ms: expect.any(Number),
      maxMs: expect.any(Number),
      timeouts: 1,
      windowSize: 256,
    });
    expect(runtimeHostRequestHealth().p95Ms).toBe(runtimeHostRequestHealth().maxMs);
  } finally {
    logged.mockRestore();
  }
});

test("a socket error settles the call exactly once with a transport failure", async () => {
  const client = new UnixRuntimeHostClient(path.join(SANDBOX, "absent.sock"), 200, 200, 200);
  const settlements: unknown[] = [];
  await client.events(0).then(
    (value) => settlements.push({ value }),
    (error) => settlements.push({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settlements).toHaveLength(1);
  expect((settlements[0] as { error: Error }).error.message).toBe("runtime host is unavailable");
});

test("a healthy response resolves once and ignores the pending timeout", async () => {
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { revision: 7 } }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);
  expect(await client.snapshot() as unknown).toEqual({ revision: 7 });
});

test("request latency health excludes the intentional wait long poll", async () => {
  resetRuntimeHostRequestHealthForTests();
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({
      id: request.id,
      ok: true,
      result: { reset: false, floorSeq: 0, events: [] },
    }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);

  await client.waitEvents(0, 10);

  expect(runtimeHostRequestHealth().samples).toBe(0);
});

test("request latency health reports the nearest-rank p95 of the recent window", async () => {
  resetRuntimeHostRequestHealthForTests();
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { reset: false, floorSeq: 0, events: [] } }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);
  const durations = Array.from({ length: 20 }, (_, index) => index + 1);
  let reading = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => {
    const requestIndex = Math.floor(reading / 2);
    const elapsed = reading % 2 === 0 ? 0 : durations[requestIndex] ?? durations.at(-1)!;
    reading += 1;
    return requestIndex * 100 + elapsed;
  });
  try {
    for (let index = 0; index < durations.length; index += 1) await client.events(0);
  } finally {
    clock.mockRestore();
  }

  expect(reading).toBe(40);
  expect(runtimeHostRequestHealth()).toEqual({
    samples: 20,
    p95Ms: 19,
    maxMs: 20,
    timeouts: 0,
    windowSize: 256,
  });
});

test("snapshot accepts an upgrade-sized frame from the previous runtime host", async () => {
  const padding = "x".repeat(9 * 1024 * 1024);
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame) as { id: string };
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { padding } }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath, 5_000, 5_000, 5_000);

  const snapshot = await client.snapshot() as unknown as { padding: string };

  expect(snapshot.padding.length).toBe(padding.length);
});


test("deployment list remembers one unsupported probe across clients and concurrent polls until the socket generation changes", async () => {
  const methods: string[] = [];
  const deployments = ["a", "c", "b"].map(deploymentId => ({ deploymentId, createdAt: "2026-09-20T12:00:00Z", updatedAt: "2026-09-20T12:00:00Z",
    phase: "succeeded", terminal: true, revision: "a".repeat(40), error: null }));
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    methods.push(request.method);
    socket.end(JSON.stringify(request.method === "viewer-deployment-list"
      ? { id: request.id, ok: false, error: "runtime request method is unsupported" }
      : { id: request.id, ok: true, result: { deployments } }) + "\n");
  });
  const pages = await Promise.all(Array.from({ length: 5 }, () => new UnixRuntimeHostClient(socketPath).listViewerDeployments({ limit: 1 })));
  expect(methods.filter(method => method === "viewer-deployment-list")).toHaveLength(1);
  expect(methods.filter(method => method === "snapshot")).toHaveLength(5);
  for (const page of pages) expect(page.deployments.map(row => row.deploymentId)).toEqual(["c"]);
  expect(pages[0]!.legacySnapshot).toBe(true);
  await expect(new UnixRuntimeHostClient(socketPath).listViewerDeployments({ cursor: viewerDeploymentListCursor(Date.parse(deployments[0]!.createdAt), "c") }))
    .rejects.toThrow("restart the list after hand-over");
  expect(methods.filter(method => method === "snapshot")).toHaveLength(5);
  const second = await new UnixRuntimeHostClient(socketPath).listViewerDeployments({ limit: 1, cursor: pages[0]!.nextCursor!, compact: true });
  expect(second.deployments).toEqual([{ deploymentId: "b", phase: "succeeded", terminal: true, sha: "a".repeat(40),
    startedAt: "2026-09-20T12:00:00Z", finishedAt: "2026-09-20T12:00:00Z", error: null }]);
  fs.unlinkSync(socketPath); // This test owns both listeners; a successor binds a new inode.
  const nextMethods: string[] = [];
  serve((frame, socket) => {
    const request = JSON.parse(frame);
    nextMethods.push(request.method);
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { deployments: [], nextCursor: null, hasMore: false } }) + "\n");
  }, socketPath);
  expect(await new UnixRuntimeHostClient(socketPath).listViewerDeployments()).toEqual({ deployments: [], nextCursor: null, hasMore: false });
  expect(nextMethods).toEqual(["viewer-deployment-list"]);
});

for (const failure of ["deployment list cursor is invalid", "viewer deployments are disabled", "runtime host is unavailable"]) {
  test(`deployment list does not fall back on ${failure}`, async () => {
    const methods: string[] = [];
    const socketPath = serve((frame, socket) => {
      const request = JSON.parse(frame);
      methods.push(request.method);
      socket.end(JSON.stringify({ id: request.id, ok: false, error: failure }) + "\n");
    });
    await expect(new UnixRuntimeHostClient(socketPath).listViewerDeployments()).rejects.toThrow(failure);
    expect(methods).toEqual(["viewer-deployment-list"]);
  });
}


test("a keyed session frame preserves UTF-8 characters split across socket chunks", async () => {
  const text = "before\u{1f642}after";
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    expect(request.method).toBe("session-read");
    expect(request.params).toEqual({ conversationId: "conversation_utf8" });
    const reply = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { conversationId: "conversation_utf8", liveTurn: { text } } }) + "\n");
    const split = reply.indexOf(Buffer.from("\u{1f642}")) + 2;
    socket.write(reply.subarray(0, split));
    setTimeout(() => socket.end(reply.subarray(split)), 10);
  });
  const client = new UnixRuntimeHostClient(socketPath);
  expect(await client.readSession({ conversationId: "conversation_utf8" })).toMatchObject({ liveTurn: { text } });
});

test("issue 1987: a snapshot-sized frame is measured once per byte, not once per chunk", async () => {
  /* The runtime snapshot is several megabytes. Re-measuring and re-scanning the
     whole accumulated frame on every socket chunk made receiving one quadratic
     and held the Viewer's event loop for hundreds of milliseconds. */
  const payload = "x".repeat(8 * 1024 * 1024);
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    const reply = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { conversationId: "conversation_large", liveTurn: { text: payload } } }) + "\n");
    let offset = 0;
    const writeNext = () => {
      if (offset >= reply.length) return socket.end();
      const next = Math.min(reply.length, offset + 64 * 1024);
      socket.write(reply.subarray(offset, next), writeNext);
      offset = next;
    };
    writeNext();
  });
  let measured = 0;
  const byteLength = Buffer.byteLength;
  const spy = spyOn(Buffer, "byteLength").mockImplementation(((value: Parameters<typeof Buffer.byteLength>[0], encoding?: BufferEncoding) => {
    if (typeof value === "string") measured += value.length;
    return byteLength(value, encoding);
  }) as typeof Buffer.byteLength);
  try {
    const session = await new UnixRuntimeHostClient(socketPath).readSession({ conversationId: "conversation_large" });
    expect((session as { liveTurn: { text: string } }).liveTurn.text.length).toBe(payload.length);
  } finally {
    spy.mockRestore();
  }
  expect(measured).toBeLessThan(payload.length * 2);
});

test("the encoded snapshot is the host's own text, never a re-encoding of it", async () => {
  // Text a parse and a stringify would not give back: key order kept, `1.0` and an escape as written.
  const written = '{"b":1.0,"a":"\\u00e9","sessions":[{"text":"} {"}]}';
  const params: unknown[] = [];
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    params.push(request.params);
    const answer = `{"id":${JSON.stringify(request.id)},"ok":true,"result":${written}}\n`;
    // Split inside the envelope and inside the result.
    socket.write(answer.slice(0, 9));
    setTimeout(() => { socket.write(answer.slice(9, 40)); setTimeout(() => socket.write(answer.slice(40)), 5); }, 5);
  });
  const client = new UnixRuntimeHostClient(socketPath);
  expect(await client.snapshotJson()).toBe(written);
  expect(await client.snapshotJson(undefined, { voiceBodiesFor: [] })).toBe(written);
  expect(params).toEqual([undefined, { voiceBodiesFor: [] }]);
  expect(await client.snapshot()).toEqual(JSON.parse(written));
});

test("an encoded read of any other frame layout parses it, and a refusal still throws", async () => {
  const socketPath = serve((frame, socket) => {
    const request = JSON.parse(frame);
    if (request.params?.voiceBodiesFor) socket.write(JSON.stringify({ id: request.id, ok: false, error: "snapshot refused", code: "refused" }) + "\n");
    else socket.write(JSON.stringify({ ok: true, id: request.id, result: { sessions: [] }, note: "later member" }) + "\n");
  });
  const client = new UnixRuntimeHostClient(socketPath);
  expect(await client.snapshotJson()).toBe('{"sessions":[]}');
  const refusal = await client.snapshotJson(undefined, { voiceBodiesFor: [] }).catch((error) => error);
  expect(refusal).toBeInstanceOf(RuntimeHostUnavailableError);
  expect(refusal.message).toBe("snapshot refused");
  expect(refusal.code).toBe("refused");
});

test("the runtime host's frame is the envelope the encoded read cuts the result out of", async () => {
  const { serveRuntimeHost } = await import("@/runtime-host/socket");
  const { PreserializedJson } = await import("@/runtime-host/preserializedJson");
  const cached = '{"sessions":[{"conversationId":"one","note":"kept as written: 1.0"}],"filesRevision":7}';
  const socketPath = path.join(SANDBOX, "real-host.sock");
  const server = serveRuntimeHost(socketPath, {
    handle: async (request: { id: string; params?: { voiceBodiesFor?: unknown } }) => request.params?.voiceBodiesFor
      ? { id: request.id, ok: true, result: JSON.parse(cached) }
      : { id: request.id, ok: true, result: new PreserializedJson(cached) },
  } as never);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  const parse = spyOn(JSON, "parse");
  try {
    expect(await client.snapshotJson()).toBe(cached);
    // The server parses the request; nothing parses the answer.
    expect(parse.mock.calls.filter((call) => String(call[0]).includes("kept as written"))).toHaveLength(0);
  } finally {
    parse.mockRestore();
  }
  // A result the host did not preserialize crosses in the same envelope.
  expect(await client.snapshotJson(undefined, { voiceBodiesFor: [] })).toBe(JSON.stringify(JSON.parse(cached)));
});
