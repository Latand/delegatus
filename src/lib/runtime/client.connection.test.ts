import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { testEndpoint } from "@/runtime-host/fixtures/testEndpoint";
import { isRuntimeHostTransportFailure, RuntimeHostUnavailableError, UnixRuntimeHostClient } from "./client";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-reuse-"));
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
let counter = 0;
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  fs.rmSync(directory, { recursive: true, force: true });
});
async function serve(handle: Parameters<typeof serveRuntimeHost>[1]["handle"]) {
  const endpoint = testEndpoint(directory, `host-${++counter}`);
  const server = serveRuntimeHost(endpoint, { handle });
  servers.push(server);
  let accepts = 0;
  const local = new Set<net.Socket>();
  server.on("connection", socket => { accepts++; sockets.add(socket); local.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.once("listening", resolve));
  return { endpoint, server, sockets: local, accepts: () => accepts };
}
test("fresh clients share one bounded connection and preserve decoded/encoded UTF-8 frames", async () => {
  const fixture = await serve(async request => ({ id: request.id, ok: true, result: request.method === "files-revision" ? 7 : { text: "повідомлення" } }));
  for (let index=0; index<12; index++) {
    const client = new UnixRuntimeHostClient(fixture.endpoint);
    expect(await client.filesRevision()).toBe(7);
    expect(JSON.parse(Buffer.from(await client.snapshotBytes()).toString())).toEqual({ text: "повідомлення" });
    expect(await client.snapshot()).toEqual({ text: "повідомлення" } as never);
  }
  expect(fixture.accepts()).toBe(1);
});
test("aborting a held long poll closes only that lease and commands remain available", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const fixture = await serve(async (request, options) => {
    if (request.method === "wait") {
      entered();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { id: request.id, ok: true, result: 8 };
  });
  const client = new UnixRuntimeHostClient(fixture.endpoint);
  const abort = new AbortController();
  const held = client.waitEvents(0, 30_000, abort.signal).catch(error => error);
  await waiting;
  expect(await client.filesRevision()).toBe(8);
  abort.abort();
  expect((await held).message).toBe("runtime host request cancelled");
  expect(await client.filesRevision()).toBe(8);
  expect(fixture.accepts()).toBe(2);
});
test("a refused request leaves the connection reusable and does not repeat a mutation", async () => {
  let mutations = 0;
  const fixture = await serve(async request => {
    if (request.method === "append") { mutations++; return { id: request.id, ok: false, error: "journal refused", code: "REFUSED" }; }
    return { id: request.id, ok: true, result: 1 };
  });
  const client = new UnixRuntimeHostClient(fixture.endpoint);
  await expect(client.append({ scope: "system:test", kind: "item", payload: {} })).rejects.toThrow("journal refused");
  expect(await client.filesRevision()).toBe(1);
  expect(mutations).toBe(1);
  expect(fixture.accepts()).toBe(1);
});
test("concurrent requests use at most four command connections and queued cancellation never reaches the host", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const saturated = new Promise<void>(resolve => { entered = resolve; });
  let handled = 0;
  const fixture = await serve(async request => {
    if (++handled === 4) entered();
    await gate;
    return { id: request.id, ok: true, result: 1 };
  });
  const client = new UnixRuntimeHostClient(fixture.endpoint);
  const active = Array.from({ length: 4 }, () => client.filesRevision());
  await saturated;
  const abort = new AbortController();
  const queued = client.readSession({ conversationId: "cancelled" }, { signal: abort.signal }).catch(error => error);
  abort.abort();
  expect((await queued).message).toBe("runtime host request cancelled");
  const peers = Array.from({ length: 12 }, () => client.filesRevision());
  release();
  await Promise.all([...active, ...peers]);
  expect(handled).toBe(16);
  expect(fixture.accepts()).toBe(4);
});

test("process restart discards leases and a successor starts with a fresh bounded pool", async () => {
  const fixture = await serve(async request => ({ id: request.id, ok: true, result: 7 }));
  for (let generation = 0; generation < 2; generation++) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/runtimeConnectionChild.ts"), fixture.endpoint], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    try {
      expect(await new Response(child.stdout).text()).toBe("completed\n");
      expect(await child.exited).toBe(0);
      expect(fixture.accepts()).toBe(generation + 1);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
  }
});
test("idle disconnect and malformed frames evict a connection; the next call reconnects without replay", async () => {
  let calls = 0;
  const fixture = await serve(async request => {
    calls++;
    return { id: calls === 1 ? "wrong-response" : request.id, ok: true, result: 7 };
  });
  const client = new UnixRuntimeHostClient(fixture.endpoint);
  await expect(client.filesRevision()).rejects.toThrow("response id mismatch");
  expect(await client.filesRevision()).toBe(7);
  for (const socket of fixture.sockets) socket.destroy();
  await new Promise(resolve => setImmediate(resolve));
  // An idle peer close may arrive just as a new lease is issued. It refuses
  // that original call; a separate caller can safely reconnect afterwards.
  const answer = await client.filesRevision().catch(() => client.filesRevision());
  expect(answer).toBe(7);
  expect(fixture.accepts()).toBeGreaterThanOrEqual(3);
});

test("transport failures from a second client module remain recognizable to the controller", async () => {
  // Bun normalizes source import queries. A real bundled copy exercises the
  // separate constructor identity that Next route bundles produce.
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "client.ts")], target: "bun", format: "esm", packages: "external" });
  expect(built.success).toBe(true);
  const bundled = path.join(directory, "compiled-client.mjs");
  fs.writeFileSync(bundled, await built.outputs[0]!.text());
  const foreign = await import(pathToFileURL(bundled).href) as typeof import("./client");
  expect(foreign.RuntimeHostUnavailableError).not.toBe(RuntimeHostUnavailableError);
  const fixture = await serve(async request => ({ id: request.id, ok: true, result: 7 }));
  await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  const failure = await new foreign.UnixRuntimeHostClient(fixture.endpoint).filesRevision().catch(error => error);
  expect(failure).not.toBeInstanceOf(RuntimeHostUnavailableError);
  expect(isRuntimeHostTransportFailure(failure)).toBe(true);
  expect(isRuntimeHostTransportFailure(new Error("runtime host is unavailable"))).toBe(false);
  expect(isRuntimeHostTransportFailure(new foreign.RuntimeHostUnavailableError("runtime host is unavailable", "REFUSED"))).toBe(false);
});
