import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CloneDirectory } from "./cloneDirectory";
import { clonePairing, cloneTargets } from "./clone.fixture";
import { startTestRelay } from "./testRelay";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(handler: Parameters<typeof startTestRelay>[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-directory-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startTestRelay(handler); cleanups.push(server.close);
  const relay = clonePairing(server.origin), file = path.join(root, "directory.json");
  let now = Date.parse("2026-10-20T12:00:00Z"), relays = [relay];
  const ports = { file, relays: () => relays, now: () => now, origin: server.origin };
  const directory = new CloneDirectory(ports);
  cleanups.push(() => directory.idle());
  return { relay, file, ports, directory, advance: (ms: number) => { now += ms; }, unpair: () => { relays = []; } };
}
const chat = "-1000000000101";

test("active binding is covered once; pause, disable, unpair, foreign origin and ambiguous bindings remove coverage", async () => {
  let calls = 0;
  const f = await fixture(() => { calls++; return { body: cloneTargets() }; });
  const routes = await Promise.all(Array.from({ length: 10 }, () => f.directory.route(chat)));
  expect(calls).toBe(1); expect(routes[0]).toMatchObject({ targetId: "fixture-clone", name: "Report clone" });
  expect(f.directory.peek("700000101")).toBeNull(); expect(f.directory.peek("-9999")).toBeNull();
  f.relay.targets[0]!.enabled = false; expect(f.directory.peek(chat)).toBeNull();
  f.relay.targets[0]!.enabled = true; f.relay.paused = true; expect(f.directory.peek(chat)).toBeNull();
  f.relay.paused = false; f.relay.origin = "https://example.invalid"; expect(f.directory.peek(chat)).toBeNull();
  f.relay.origin = f.ports.origin; f.unpair(); expect(f.directory.peek(chat)).toBeNull();
  const ambiguous = await fixture(() => { const body = cloneTargets(); body.targets.push({ ...body.targets[0]!, target_id: "other" }); return { body }; });
  expect(await ambiguous.directory.route(chat)).toBeNull();
});
test("listing discovers only active groups covered by an enabled paired clone", async () => {
  let calls = 0;
  const f = await fixture(() => { calls++; return { body: cloneTargets() }; });
  expect(await f.directory.discoverChats()).toEqual([{ chatId: chat, title: "Fixture reports" }]);
  expect(calls).toBe(1);
  expect(await f.directory.discoverChats()).toEqual([{ chatId: chat, title: "Fixture reports" }]);
  expect(calls).toBe(1);
  f.relay.targets[0]!.enabled = false;
  expect(await f.directory.discoverChats()).toEqual([]);
});
test("pre-release discovery is unsupported and never refetches within the soft TTL", async () => {
  for (const answer of [{ status: 400, body: { error: { code: "malformed" } } }, { body: { targets: [{ target_id: "fixture-clone", name: "Old target" }] } }]) {
    let calls = 0;
    const f = await fixture(() => { calls++; return answer; });
    expect(await f.directory.route(chat)).toBeNull();
    f.advance(60001); expect(await f.directory.route(chat)).toBeNull(); expect(calls).toBe(1);
  }
});
test("stale reads keep the artifact and single-flight refresh; invalidation respects the persisted one-minute admission", async () => {
  let calls = 0, release: (() => void) | undefined;
  const f = await fixture(async () => {
    calls++; if (calls > 1) await new Promise<void>(resolve => { release = resolve; });
    return { body: cloneTargets() };
  });
  const route = await f.directory.route(chat); expect(route).not.toBeNull();
  f.directory.invalidate(route!, "stale");
  expect(f.directory.peek(chat)).not.toBeNull(); expect(calls).toBe(1);
  f.advance(60001);
  expect(f.directory.peek(chat)).not.toBeNull();
  const refreshing = f.directory.route(chat);
  // Wait for the real producer, not a fixed delay.
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  for (let i = 0; i < 10; i++) f.directory.peek(chat);
  expect(calls).toBe(2); release(); await refreshing;
});
test("a real restarted process answers from disk and retains failed-fetch admission", async () => {
  let calls = 0;
  const f = await fixture(() => { calls++; return { body: cloneTargets() }; });
  await f.directory.route(chat);
  async function restart(target = f) {
    const script = `import {CloneDirectory} from './src/lib/externalRelay/cloneDirectory';
      const directory = new CloneDirectory({file:process.env.CLONE_TEST_FILE, relays:()=>[JSON.parse(process.env.CLONE_TEST_RELAY)], now:()=>${target.ports.now()}, origin:process.env.CLONE_TEST_ORIGIN});
      console.log(JSON.stringify({covered:!!await directory.route('${chat}')}));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, CLONE_TEST_FILE: target.file,
      CLONE_TEST_RELAY: JSON.stringify(target.relay), CLONE_TEST_ORIGIN: target.ports.origin }, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(error).toBe(""); return JSON.parse(output.trim());
  }
  expect(await restart()).toEqual({ covered: true }); expect(calls).toBe(1);
  fs.writeFileSync(f.file, "invalid"); const corrupt = new CloneDirectory(f.ports);
  expect(corrupt.peek(chat)).toBeNull(); await corrupt.idle();
  // An unsuccessful refresh also writes its admission before attempting HTTP.
  const failed = await fixture(() => { calls++; return { status: 503 }; });
  await failed.directory.route(chat); const before = calls;
  expect(await restart(failed)).toEqual({ covered: false }); expect(calls).toBe(before);
  f.relay.pairedAt = "2026-10-21T12:00:00Z";
  const changed = new CloneDirectory(f.ports);
  expect(changed.peek(chat)).toBeNull(); await changed.idle();
});
test("continuations stop at one hundred chats per target and one thousand per relay", async () => {
  let pages = 0;
  const f = await fixture(req => {
    if (req.url!.includes("/chats?")) { pages++; return { body: { chats: Array.from({ length: 100 }, (_, n) => ({ chat_id: -10000 - n, title: "Extra" })), next_cursor: "again" } }; }
    const body = cloneTargets(); body.targets[0]!.chats_next_cursor = "page-one" as never; return { body };
  });
  await f.directory.route(chat); expect(pages).toBe(1);
  expect(f.directory.peek("-10098")).not.toBeNull(); expect(f.directory.peek("-10099")).toBeNull();
  f.advance(900001); f.directory.peek(chat);
  await f.directory.route(chat);
});
