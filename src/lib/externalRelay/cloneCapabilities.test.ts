import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CloneCapabilitiesDirectory } from "./cloneCapabilities";
import { clonePairing } from "./clone.fixture";
import { cloneMethodDescriptor, cloneMethodRights, cloneMethodsNow } from "./cloneMethods.fixture";
import { startTestRelay } from "./testRelay";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-capabilities-")); cleanups.push(() => fs.rmSync(root, { force: true, recursive: true }));
  let now = cloneMethodsNow, calls = 0, descriptors = 0, held: Promise<void> | undefined;
  let entered!: () => void;
  const rightsStarted = new Promise<void>(resolve => { entered = resolve; });
  let rights: unknown = cloneMethodRights(), features = ["clone_send_methods"], api: string | undefined;
  const server = await startTestRelay(async req => {
    if (req.url === "/.well-known/delegatus-relay.json") { descriptors++; return { body: { ...cloneMethodDescriptor(server.origin), features, ...(api ? { api_base: api } : {}) } }; }
    calls++; entered(); await held;
    expect(req.url).toMatch(/\/chats\?include=rights&limit=25/);
    return { body: { chats: [{ chat_id: -1000000000101, send_rights: rights }], next_cursor: null } };
  }); cleanups.push(server.close);
  const relay = clonePairing(server.origin); relay.features = ["clone_send_methods"];
  const file = path.join(root, "capabilities.json");
  const directory = new CloneCapabilitiesDirectory(file, () => [relay], () => now);
  return { root, directory, relay, file, rightsStarted, origin: server.origin, now: () => now, calls: () => calls, descriptors: () => descriptors,
    advance: (ms: number) => { now += ms; }, rights: (value: unknown) => { rights = value; }, features: (value: string[]) => { features = value; },
    api: (value: string) => { api = value; }, hold: (value: Promise<void>) => { held = value; } };
}
const chat = "-1000000000101";
test("rights expire independently of coverage; failed or absent rights never confer file permission", async () => {
  const f = await fixture();
  await f.directory.refresh(f.relay, "fixture-clone");
  expect(f.directory.peek(f.relay, "fixture-clone", chat)?.rights).toEqual(cloneMethodRights());
  await f.directory.refresh(f.relay, "fixture-clone"); expect(f.calls()).toBe(1);
  f.advance(60000);
  expect(f.directory.peek(f.relay, "fixture-clone", chat)).toBeNull();
  f.rights(null); await f.directory.refresh(f.relay, "fixture-clone");
  expect(f.directory.peek(f.relay, "fixture-clone", chat)).toMatchObject({ rights: null });
  expect(f.calls()).toBe(2); expect(f.descriptors()).toBe(2);
  f.advance(60000); f.rights({ ...cloneMethodRights(), can_send_documents: "true" });
  await f.directory.refresh(f.relay, "fixture-clone"); expect(f.directory.peek(f.relay, "fixture-clone", chat)?.rights).toBeNull();
});
test("current descriptor feature and same-origin api_base are required; pairing changes revoke cached rights", async () => {
  const f = await fixture(); f.features([]);
  await f.directory.refresh(f.relay, "fixture-clone"); expect(f.calls()).toBe(0); expect(f.directory.peek(f.relay, "fixture-clone", chat)).toBeNull();
  f.features(["clone_send_methods"]); f.api("https://example.invalid/api/relay/v1"); f.advance(60000);
  await f.directory.refresh(f.relay, "fixture-clone"); expect(f.calls()).toBe(0);
  f.api(`${f.origin}/api/relay/v1`); f.advance(60000); f.rights(cloneMethodRights({ read_at: new Date(f.now()).toISOString() }));
  await f.directory.refresh(f.relay, "fixture-clone");
  expect(f.directory.peek(f.relay, "fixture-clone", chat)?.rights).not.toBeNull();
  f.relay.credential += " rotated";
  expect(f.directory.peek(f.relay, "fixture-clone", chat)).toBeNull();
});
test("rights response loses authority if the pairing changes during the read", async () => {
  const f = await fixture(); let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  // A server-side barrier announces that the rights read has entered.
  const work = f.directory.refresh(f.relay, "fixture-clone");
  try { await f.rightsStarted; f.relay.paused = true; release(); await work; expect(f.directory.peek(f.relay, "fixture-clone", chat)).toBeNull(); }
  finally { release(); await work; }
});
test("real process restarts preserve the six-page admission and validated rights artifact", async () => {
  const f = await fixture();
  await f.directory.refresh(f.relay, "fixture-clone");
  const restart = async (target: string) => {
    const script = `import {CloneCapabilitiesDirectory} from './src/lib/externalRelay/cloneCapabilities';
      const relay=JSON.parse(process.env.CLONE_FIXTURE_RELAY);
      const cache=new CloneCapabilitiesDirectory(process.env.CLONE_FIXTURE_FILE,()=>[relay],()=>${f.now()});
      await cache.refresh(relay,process.env.CLONE_FIXTURE_TARGET);
      console.log(JSON.stringify(cache.peek(relay,'fixture-clone','${chat}')));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, CLONE_FIXTURE_FILE: f.file,
      CLONE_FIXTURE_RELAY: JSON.stringify(f.relay), CLONE_FIXTURE_TARGET: target }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, error }).toEqual({ exit: 0, error: "" }); return JSON.parse(output);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited; }
  };
  expect((await restart("fixture-clone")).rights).toEqual(cloneMethodRights()); expect(f.calls()).toBe(1);
  for (let n = 0; n < 5; n++) await restart(`target-${n}`);
  expect(f.calls()).toBe(6);
  await restart("target-capped"); expect(f.calls()).toBe(6);
  f.advance(60000); f.rights(cloneMethodRights({ read_at: new Date(f.now()).toISOString() }));
  await restart("fixture-clone"); expect(f.calls()).toBe(7);
});
