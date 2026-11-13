import { afterAll, expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { destinationRelay } from "./ownerDestination.fixture";
import { readOwnerHistory } from "./ownerHistory";
import { OperationLease } from "@/lib/operationLease";
import type { OwnerMediaOptions } from "./ownerMedia";
const OWNER_MEDIA_LIMIT = 2 * 1024 ** 3;

const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "owner-media-"));
const evidence = path.join(root, "evidence");
await fs.mkdir(evidence, { mode: 0o700 });
afterAll(() => fs.rm(root, { recursive: true, force: true }));
let serial = 0;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(options: Partial<OwnerMediaOptions> = {}) {
  const { OwnerMediaRegistry } = await import("./ownerMedia");
  const directory = path.join(evidence, `case-${++serial}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const state = { enabled: true, requests: 0, size: 300_000, kind: "photo", mime: "image/jpeg", source: "bot_api",
    status: 200, body: {} as unknown, preparing: 0, short: false, digest: null as string | null,
    now: Date.parse("2026-11-13T10:00:00Z"), contentRange: null as string | null, byte: 7,
    pause: null as (() => Promise<void>) | null, onChunk: null as (() => void) | null };
  const server = http.createServer(async (req, res) => {
    state.requests++;
    req.socket.on("error", () => {}); res.on("error", () => {});
    try {
      expect(req.headers.authorization).toBe(`Bearer ${"q".repeat(43)}`);
      expect(req.url).toMatch(/^\/v1\/targets\/first\/owner\/groups\/-101\/messages\/[1-9][0-9]*\/media$/);
      if (state.preparing-- > 0) { res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "preparing", retry_after_s: 1 })); return; }
      if (state.status !== 200) { res.writeHead(state.status, { "content-type": "application/json" }); res.end(JSON.stringify(state.body)); return; }
      res.writeHead(200, { "content-length": String(state.size), "content-type": state.mime,
        "delegatus-media-kind": state.kind, "delegatus-media-source": state.source,
        "content-disposition": "attachment; filename*=UTF-8''..%2Fsender.pdf", ...(state.digest ? { "repr-digest": state.digest } : {}),
        ...(state.contentRange ? { "content-range": state.contentRange } : {}) });
      res.flushHeaders();
      const total = state.short ? Math.floor(state.size / 3) : state.size;
      for (let n = 0; n < total; n += 65536) {
        if (res.destroyed) break;
        if (!res.write(Buffer.alloc(Math.min(65536, total - n), state.byte))) await once(res, "drain");
        state.onChunk?.();
        if (state.pause && n === 0) await state.pause();
      }
      if (state.short) { await new Promise<void>(resolve => setImmediate(resolve)); res.destroy(); } else res.end();
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const relay = { ...destinationRelay(), id: `media-${serial}`, features: ["relay_owner_media"],
    api_base: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
  const ports = { switches: () => ({ owner_tools: state.enabled }), relays: () => [relay],
    timeZone: () => "UTC", now: () => state.now };
  const logs: unknown[] = [];
  const registry = new OwnerMediaRegistry({ evidenceRoot: evidence, history: ports, joinMs: 15,
    retryMs: 1, log: (line: unknown) => logs.push(line), ...options });
  const input = { action: "media", chat: "-101", messageId: 1, directory };
  const call = (args = input, caller = "fixture-caller") => registry.fetch(args, caller);
  const done = async (args = input, caller = "fixture-caller") => {
    let answer = await call(args, caller);
    for (let i = 0; answer.status === "in_progress" && i < 1000; i++) answer = await call(args, caller);
    return answer;
  };
  const close = async () => { await registry.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { state, relay, ports, logs, registry, input, directory, call, done, close };
}

test("A1: photo is whole, private, safely named and hashed; document and video use the paired service", async () => {
  const f = await fixture();
  try {
    for (const [messageId, kind, size, mime, source] of [[1, "photo", 300_000, "image/jpeg", "bot_api"],
      [2, "document", 21 * 1048576, "application/pdf", "tdlib"], [3, "video", 51 * 1048576, "video/mp4", "tdlib"]] as const) {
      Object.assign(f.state, { kind, size, mime, source, preparing: kind === "document" ? 1 : 0 });
      const answer = await f.done({ ...f.input, messageId });
      expect(answer).toMatchObject({ available: true, status: "done", kind, size, mimeType: mime, source });
      if (answer.status !== "done") throw new Error("missing completed file");
      const stat = await fs.stat(answer.path);
      expect(stat.size).toBe(size); expect(stat.mode & 0o777).toBe(0o600);
      expect(path.dirname(answer.path)).toBe(f.directory); expect(path.basename(answer.path)).not.toContain("sender");
      const hash = createHash("sha256");
      for await (const chunk of (await fs.open(answer.path)).createReadStream()) hash.update(chunk);
      expect(answer.sha256).toBe(hash.digest("hex"));
    }
    expect(f.state.requests).toBe(4);
  } finally { await f.close(); }
});

test("A2: explicit remote and local size limits, truncation and digest mismatch never return a partial", async () => {
  const f = await fixture();
  try {
    f.state.status = 413; f.state.body = { error: { code: "too_large", limit_bytes: 1024, size_bytes: 2048 } };
    expect(await f.done()).toMatchObject({ reason: "too_large", limitBytes: 1024, sizeBytes: 2048 });
    f.state.status = 200; f.state.size = OWNER_MEDIA_LIMIT + 1;
    expect(await f.done({ ...f.input, messageId: 2 })).toMatchObject({ reason: "too_large", limitBytes: OWNER_MEDIA_LIMIT });
    f.state.size = 30 * 1048576; f.state.short = true;
    expect(await f.done({ ...f.input, messageId: 3 })).toMatchObject({ reason: "incomplete" });
    f.state.short = false; f.state.size = 100; f.state.digest = `sha-256=:${Buffer.alloc(32).toString("base64")}:`;
    expect(await f.done({ ...f.input, messageId: 4 })).toMatchObject({ reason: "incomplete" });
    expect(await fs.readdir(f.directory)).toEqual([]);
    for (const log of f.logs) expect(Object.keys(log as object).sort()).toEqual(["cause", "elapsedMs", "errno", "receivedBytes", "status"]);
    expect(JSON.stringify(f.logs)).not.toContain(f.directory);
  } finally { await f.close(); }
});

test("A3: only evidence directories, feature and owner switch admit a read; service authority is preserved", async () => {
  const f = await fixture();
  try {
    expect(await f.call({ ...f.input, directory: root })).toMatchObject({ reason: "directory_refused" });
    await fs.symlink(root, path.join(f.directory, "escape"));
    expect(await f.call({ ...f.input, directory: path.join(f.directory, "escape") })).toMatchObject({ reason: "directory_refused" });
    expect(await f.call({ ...f.input, chat: "101" })).toMatchObject({ reason: "invalid_arguments" });
    f.relay.features = [];
    expect(await f.call()).toMatchObject({ reason: "not_offered" });
    f.relay.features = ["relay_owner_media"]; f.state.enabled = false;
    expect(await f.call()).toMatchObject({ reason: "switch_off" });
    expect(f.state.requests).toBe(0);
    f.state.enabled = true;
    for (const [status, code] of [[404, "not_found"], [403, "protected"], [422, "no_media"], [415, "unsupported_kind"]] as const) {
      f.state.status = status; f.state.body = { error: { code, message: "private sentinel" } };
      expect(await f.done({ ...f.input, messageId: status })).toMatchObject({ available: false, reason: code });
    }
    expect(await fs.readdir(f.directory)).toEqual(["escape"]);
  } finally { await f.close(); }
});

test("A3: a growing part stays unpublished, identical calls join, and switching off cleans it", async () => {
  const paused = barrier(), probed = barrier(), allowProbe = barrier(), written = barrier();
  const f = await fixture({ freeBytes: async directory => {
    probed.release(); await allowProbe.promise;
    const stat = await fs.statfs(directory); return stat.bavail * stat.bsize;
  } });
  const open = fs.open.bind(fs);
  const writes: Array<{ mockRestore(): void }> = [];
  const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".part")) {
      const write = handle.write.bind(handle);
      writes.push(spyOn(handle, "write").mockImplementation(async (...args: Parameters<typeof handle.write>) => {
        const result = await write(...args); written.release(); return result;
      }));
    }
    return handle;
  });
  f.state.pause = () => paused.promise; f.state.size = 51 * 1048576;
  try {
    const [first, second] = await Promise.all([f.call(), f.call()]);
    expect(first.status).toBe("in_progress"); expect(second.status).toBe("in_progress");
    await probed.promise;
    expect(f.state.requests).toBe(1);
    expect(await fs.readdir(f.directory)).toEqual([]);
    allowProbe.release(); await written.promise;
    const files = await fs.readdir(f.directory);
    expect(files).toHaveLength(1); expect(files[0]).toEndWith(".part");
    expect((await fs.stat(path.join(f.directory, files[0]!))).size).toBeGreaterThan(0);
    f.state.enabled = false; paused.release();
    await f.registry.close();
    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(await f.call()).toMatchObject({ reason: "switch_off" });
  } finally {
    allowProbe.release(); paused.release(); await f.close();
    opening.mockRestore(); for (const write of writes) write.mockRestore();
  }
});

test("A3: two active and eight queued jobs bound admission; callers cannot join each other's job", async () => {
  const f = await fixture();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  f.state.pause = () => paused;
  try {
    await f.call();
    f.state.pause = () => paused;
    await f.call(f.input, "another-caller");
    const replies = [];
    for (let messageId = 2; messageId <= 10; messageId++) replies.push(await f.call({ ...f.input, messageId }));
    expect(replies.filter(a => a.status === "in_progress")).toHaveLength(8);
    expect(replies.at(-1)).toMatchObject({ reason: "busy" });
    expect(f.state.requests).toBe(2);
  } finally { release(); await f.close(); }
});

test("A2/A3: free-space admission and shared history 429 cooldown", async () => {
  const f = await fixture();
  const { OwnerMediaRegistry } = await import("./ownerMedia");
  const low = new OwnerMediaRegistry({ evidenceRoot: evidence, history: f.ports, joinMs: 100,
    freeBytes: async () => 0, log: () => {} });
  try {
    expect(await low.fetch(f.input, "low-space")).toMatchObject({ reason: "insufficient_space" });
    f.state.status = 429; f.state.body = { error: { code: "rate_limited", retry_after_s: 3 } };
    expect(await f.done()).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 3 });
    const count = f.state.requests;
    expect(await readOwnerHistory({ action: "groups" }, f.ports)).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 3 });
    expect(f.state.requests).toBe(count);
  } finally { await low.close(); await f.close(); }
});

test("completed reads recheck revoked message access through H4", async () => {
  const f = await fixture();
  try {
    expect(await f.done()).toMatchObject({ status: "done" });
    f.state.status = 404; f.state.body = { error: { code: "not_found" } };
    const fresh = await f.done(f.input, "fresh-authorization-reference");
    expect(fresh).toMatchObject({ reason: "not_found" });
    const before = f.state.requests;
    expect(await f.done()).toMatchObject({ status: "refused", reason: "not_found" });
    expect(f.state.requests).toBe(before + 1);
  } finally { await f.close(); }
});

test("edited stored media returns the current bytes, including edits of the same length", async () => {
  const f = await fixture();
  try {
    f.state.size = 64;
    expect(await f.done()).toMatchObject({ status: "done", size: 64 });
    f.state.size = 128;
    const fresh = await f.done(f.input, "fresh-media-reference");
    expect(fresh).toMatchObject({ status: "done", size: 128 });
    expect(await f.done()).toMatchObject({ status: "done", size: 128 });
    f.state.byte = 8;
    const edited = await f.done();
    expect(edited).toMatchObject({ status: "done", size: 128,
      sha256: createHash("sha256").update(Buffer.alloc(128, 8)).digest("hex") });
    if (edited.status === "done") expect(await fs.readFile(edited.path)).toEqual(Buffer.alloc(128, 8));
  } finally { await f.close(); }
});

test("HTTP 200 carrying Content-Range never publishes a prefix as a whole file", async () => {
  const f = await fixture();
  try {
    f.state.size = 64; f.state.contentRange = "bytes 0-63/128";
    expect(await f.done()).toMatchObject({ status: "refused", reason: "malformed_response" });
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("the identical media call retries after the provider cooldown expires", async () => {
  const f = await fixture();
  try {
    f.state.status = 429; f.state.body = { error: { code: "rate_limited", retry_after_s: 1 } };
    expect(await f.done()).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 1 });
    f.state.status = 200;
    const before = f.state.requests;
    expect(await f.done()).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 1 });
    expect(f.state.requests).toBe(before);
    f.state.now += 2000;
    expect(await f.done(f.input, "fresh-retry-reference")).toMatchObject({ status: "done" });
    expect(await f.done()).toMatchObject({ status: "done" });
    expect(f.state.requests).toBe(before + 2);
  } finally { await f.close(); }
});

test("concurrent jobs on the same filesystem preserve the disk reserve together", async () => {
  const bothProbed = barrier();
  let probes = 0;
  const f = await fixture({ freeBytes: async () => {
    if (++probes === 2) bothProbed.release();
    await bothProbed.promise; return OWNER_MEDIA_LIMIT + 64;
  } });
  try {
    f.state.size = 64;
    const second = { ...f.input, messageId: 2 };
    const replies = await Promise.all([f.done(), f.done(second)]);
    expect(replies.filter(r => r.status === "done")).toHaveLength(1);
    expect(replies.filter(r => r.status === "refused" && r.reason === "insufficient_space")).toHaveLength(1);
    expect(await fs.readdir(f.directory)).toHaveLength(1);
  } finally { bothProbed.release(); await f.close(); }
});

test("a stale free-space probe accounts for another registry's completed write", async () => {
  const firstProbed = barrier(), allowFirst = barrier();
  const f = await fixture({ freeBytes: async () => {
    firstProbed.release(); await allowFirst.promise; return OWNER_MEDIA_LIMIT + 64;
  } });
  const { OwnerMediaRegistry } = await import("./ownerMedia");
  const second = new OwnerMediaRegistry({ evidenceRoot: evidence, history: f.ports,
    freeBytes: async () => OWNER_MEDIA_LIMIT + 64, joinMs: 1000, log: () => {} });
  try {
    f.state.size = 64;
    const pending = f.done();
    await firstProbed.promise;
    expect(await second.fetch(f.input, "second-registry")).toMatchObject({ status: "done" });
    allowFirst.release();
    expect(await pending).toMatchObject({ reason: "insufficient_space" });
    // A fresh snapshot has no outstanding reservation from either job.
    expect(await second.fetch({ ...f.input, messageId: 2 }, "second-registry")).toMatchObject({ status: "done" });
  } finally { allowFirst.release(); await second.close(); await f.close(); }
});

test("failed writes release reserved space after their parts are cleaned", async () => {
  const f = await fixture({ freeBytes: async () => OWNER_MEDIA_LIMIT + 64 });
  try {
    f.state.size = 64; f.state.short = true;
    expect(await f.done()).toMatchObject({ reason: "incomplete" });
    expect(await fs.readdir(f.directory)).toEqual([]);
    f.state.short = false;
    expect(await f.done()).toMatchObject({ status: "done", size: 64 });
  } finally { await f.close(); }
});

test("a stale disk probe accounts for a part whose cleanup failed", async () => {
  const probed = barrier(), allowProbe = barrier();
  const f = await fixture({ freeBytes: async () => {
    probed.release(); await allowProbe.promise; return OWNER_MEDIA_LIMIT + 64;
  } });
  const { OwnerMediaRegistry } = await import("./ownerMedia");
  const second = new OwnerMediaRegistry({ evidenceRoot: evidence, history: f.ports,
    freeBytes: async () => OWNER_MEDIA_LIMIT + 64, joinMs: 1000, log: () => {} });
  const unlink = fs.unlink.bind(fs);
  const cleanup = spyOn(fs, "unlink").mockImplementation(async file => {
    if (String(file).endsWith(".part")) throw Object.assign(new Error("private cleanup sentinel"), { code: "EACCES" });
    return unlink(file);
  });
  try {
    f.state.size = 64;
    const pending = f.done(); await probed.promise;
    f.state.digest = `sha-256=:${Buffer.alloc(32).toString("base64")}:`;
    expect(await second.fetch(f.input, "cleanup-failure")).toMatchObject({ status: "refused" });
    expect(await fs.readdir(f.directory)).toHaveLength(1);
    cleanup.mockRestore(); f.state.digest = null; allowProbe.release();
    expect(await pending).toMatchObject({ reason: "insufficient_space" });
  } finally { cleanup.mockRestore(); allowProbe.release(); await second.close(); await f.close(); }
});

test("directory identity is rechecked after a suspended free-space probe", async () => {
  const f = await fixture();
  const moved = f.directory + "-moved";
  const { OwnerMediaRegistry } = await import("./ownerMedia");
  const registry = new OwnerMediaRegistry({ evidenceRoot: evidence, history: f.ports, joinMs: 100,
    freeBytes: async () => {
      await fs.rename(f.directory, moved); await fs.mkdir(f.directory, { mode: 0o700 });
      return 10 * OWNER_MEDIA_LIMIT;
    }, log: () => {} });
  try {
    expect(await registry.fetch(f.input, "directory-swap")).toMatchObject({ reason: "directory_refused" });
    expect(await fs.readdir(f.directory)).toEqual([]); expect(await fs.readdir(moved)).toEqual([]);
  } finally { await registry.close(); await f.close(); }
});

test("switch off immediately after final link revokes that link and cleans the part", async () => {
  const f = await fixture();
  const link = fs.link.bind(fs);
  const spy = spyOn(fs, "link").mockImplementation(async (...args: Parameters<typeof fs.link>) => {
    await link(...args); f.state.enabled = false;
  });
  try {
    expect(await f.done()).toMatchObject({ reason: "switch_off" });
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { spy.mockRestore(); await f.close(); }
});

test("completed jobs require a fresh H4 read; each caller gets collision-safe files", async () => {
  const f = await fixture();
  try {
    const first = await f.done();
    const second = await f.done();
    expect(first.status).toBe("done"); expect(second.status).toBe("done");
    if (first.status === "done" && second.status === "done") expect(second.path).not.toBe(first.path);
    let other = await f.call(f.input, "other-caller");
    while (other.status === "in_progress") other = await f.call(f.input, "other-caller");
    expect(other.status).toBe("done");
    if (other.status === "done" && first.status === "done") expect(other.path).not.toBe(first.path);
    expect(f.state.requests).toBe(3);
  } finally { await f.close(); }
});

test("an unfinished join survives completion during the joining caller's directory check", async () => {
  const f = await fixture({ joinMs: 60_000 });
  const serving = barrier(), allowBody = barrier(), checking = barrier(), allowDirectory = barrier();
  f.state.pause = () => { serving.release(); return allowBody.promise; };
  const realpath = fs.realpath.bind(fs);
  let held = false;
  let directoryCheck: { mockRestore(): void } | undefined;
  try {
    const first = f.call(); await serving.promise;
    directoryCheck = spyOn(fs, "realpath").mockImplementation(async file => {
      if (!held && String(file) === evidence) {
        held = true; checking.release(); await allowDirectory.promise;
      }
      return realpath(file);
    });
    const joining = f.call(); await checking.promise;
    allowBody.release();
    const finished = await first;
    expect(finished.status).toBe("done");
    allowDirectory.release();
    expect(await joining).toEqual(finished);
    expect(f.state.requests).toBe(1);
  } finally {
    allowBody.release(); allowDirectory.release(); directoryCheck?.mockRestore(); await f.close();
  }
});

test("a transfer completed between polls is delivered once before a fresh H4 read", async () => {
  const f = await fixture();
  const allowBody = barrier(), closed = barrier();
  f.state.pause = () => allowBody.promise;
  const open = fs.open.bind(fs);
  const closes: Array<{ mockRestore(): void }> = [];
  const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.directory) {
      const close = handle.close.bind(handle);
      closes.push(spyOn(handle, "close").mockImplementation(async () => { await close(); closed.release(); }));
    }
    return handle;
  });
  try {
    expect(await f.call()).toMatchObject({ status: "in_progress" });
    allowBody.release(); await closed.promise;
    // The registry settles in the microtasks following the last directory close.
    await new Promise<void>(resolve => setImmediate(resolve));
    const first = await f.done();
    expect(first.status).toBe("done"); expect(f.state.requests).toBe(1);
    const second = await f.done();
    expect(second.status).toBe("done"); expect(f.state.requests).toBe(2);
    if (first.status === "done" && second.status === "done") expect(second.path).not.toBe(first.path);
  } finally {
    allowBody.release(); await f.close(); opening.mockRestore(); for (const close of closes) close.mockRestore();
  }
});

test("a removed completed file starts a fresh authorized download", async () => {
  const f = await fixture();
  try {
    const first = await f.done();
    if (first.status !== "done") throw new Error("expected completed evidence");
    await fs.unlink(first.path);
    expect(await f.done()).toMatchObject({ status: "done" });
    expect(f.state.requests).toBe(2);
  } finally { await f.close(); }
});

test("a replaced or modified completed file never returns a stale content hash", async () => {
  const f = await fixture();
  try {
    const first = await f.done();
    if (first.status !== "done") throw new Error("expected completed evidence");
    await fs.rename(first.path, first.path + ".saved");
    await fs.writeFile(first.path, Buffer.alloc(first.size, 8), { mode: 0o600 });
    const second = await f.done();
    if (second.status !== "done") throw new Error("expected refreshed evidence");
    await fs.writeFile(second.path, Buffer.alloc(second.size, 9));
    const third = await f.done();
    expect(third.status).toBe("done");
    if (third.status === "done") expect(third.sha256).toBe(createHash("sha256").update(Buffer.alloc(third.size, 7)).digest("hex"));
    expect((await fs.stat(first.path + ".saved")).size).toBe(first.size);
  } finally { await f.close(); }
});

test("idle timeout cancels the stream and cleans its part before the job settles", async () => {
  const f = await fixture();
  let release!: () => void;
  f.state.pause = () => new Promise<void>(r => { release = r; });
  const { OwnerMediaRegistry } = await import("./ownerMedia");
  const registry = new OwnerMediaRegistry({ evidenceRoot: evidence, history: f.ports, idleMs: 40, joinMs: 200, log: () => {} });
  try {
    expect(await registry.fetch(f.input, "idle-case")).toMatchObject({ reason: "deadline_exceeded" });
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { release?.(); await registry.close(); await f.close(); }
});

test("a real process restart reprobes disk space and safely selects another final name", async () => {
  const f = await fixture();
  try {
    f.state.size = 64;
    const script = `import {OwnerMediaRegistry} from ${JSON.stringify(new URL("./ownerMedia.ts", import.meta.url).pathname)};
      const config = JSON.parse(process.env.MEDIA_TEST_INPUT);
      const registry = new OwnerMediaRegistry({ evidenceRoot: config.evidence, history: {
        switches: () => ({owner_tools:true}), relays: () => [config.relay], now: () => 1, timeZone: () => "UTC"
      }, freeBytes: async () => config.available, log: () => {}});
      let answer = await registry.fetch(config.input, "restart-caller");
      while (answer.status === "in_progress") answer = await registry.fetch(config.input, "restart-caller");
      await registry.close(); console.log(JSON.stringify(answer));`;
    const results = [];
    for (const available of [OWNER_MEDIA_LIMIT + 64, OWNER_MEDIA_LIMIT, OWNER_MEDIA_LIMIT + 64]) {
      const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env,
        MEDIA_TEST_INPUT: JSON.stringify({ evidence, relay: f.relay, input: f.input, available }) } });
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(errors).toBe(""); expect(code).toBe(0);
      const answer = JSON.parse(output);
      expect(answer.status).toBe(available === OWNER_MEDIA_LIMIT ? "refused" : "done"); results.push(answer);
    }
    expect(results[1].reason).toBe("insufficient_space");
    expect(results[0].path).not.toBe(results[2].path); expect(f.state.requests).toBe(3);
  } finally { await f.close(); }
});

test("stale parts are removed, while linked and unrelated evidence survives", async () => {
  const f = await fixture();
  const stem = `relay-${createHash("sha256").update("-101").digest("hex").slice(0, 12)}-99-`;
  const stale = path.join(f.directory, `${stem}${"0".repeat(36)}.bin.part`);
  const linked = path.join(f.directory, `${stem}${"1".repeat(36)}.bin.part`);
  const kept = path.join(f.directory, "kept.bin");
  try {
    await fs.writeFile(stale, "stale"); await fs.writeFile(kept, "keep"); await fs.link(kept, linked);
    const old = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(stale, old, old); await fs.utimes(linked, old, old);
    expect(await f.done()).toMatchObject({ status: "done" });
    expect(await fs.readFile(kept, "utf8")).toBe("keep"); expect(await fs.readFile(linked, "utf8")).toBe("keep");
    expect(await fs.readdir(f.directory)).not.toContain(path.basename(stale));
  } finally { await f.close(); }
});

test("write errors retain an allowlisted errno, clean the part and omit caught text", async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  const writes: Array<{ mockRestore(): void }> = [];
  let code = "EIO";
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".part")) writes.push(spyOn(handle, "write").mockRejectedValue(Object.assign(new Error("private write sentinel"), { code })));
    return handle;
  });
  try {
    expect(await f.done()).toMatchObject({ reason: "incomplete" });
    code = "ENOSPC";
    expect(await f.done({ ...f.input, messageId: 2 })).toMatchObject({ reason: "insufficient_space" });
    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(f.logs).toMatchObject([{ errno: "EIO" }, { errno: "ENOSPC" }]);
    expect(JSON.stringify(f.logs)).not.toContain("sentinel");
  } finally { spy.mockRestore(); for (const write of writes) write.mockRestore(); await f.close(); }
});

test("the registry retains custody after a joining request's operation lease expires", async () => {
  const f = await fixture();
  const lease = new OperationLease();
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  f.state.pause = () => held;
  try {
    expect(await lease.run(() => f.call())).toMatchObject({ status: "in_progress" });
    lease.expire(); release();
    expect(await f.done()).toMatchObject({ status: "done" });
    expect(f.state.requests).toBe(1);
  } finally { release?.(); await f.close(); }
});
