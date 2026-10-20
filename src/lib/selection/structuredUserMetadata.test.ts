import { afterEach, expect, spyOn, test } from "bun:test";
import fsDefault from "node:fs";
import * as fsNamed from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { persistStructuredUserMetadata, readStructuredUserMetadata, type StructuredUserMetadata } from "./structuredUserMetadata";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { collectStructuredUserMetadata } from "./structuredUserMetadataRetention";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
const record = (): StructuredUserMetadata => ({ version: 1, contentDigest: "a".repeat(64), selectedContext: null, origin: { kind: "agent", role: "reviewer" }, deliveryDedup: "b".repeat(64) });

async function isolated(work: (root: string) => Promise<void>) {
  const root = await io.mkdtemp(join(tmpdir(), "metadata-writer-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try { await work(root); }
  finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    await io.rm(root, { recursive: true, force: true });
  }
}

test("a held file sync yields to the caller and snapshots metadata before waiting", async () => isolated(async () => {
  const original = io.open;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const open = spyOn(io, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { entered(); await held; await sync(); };
    }
    return handle;
  });
  restore = () => open.mockRestore();
  const input = record();
  let settled = false;
  const pending = persistStructuredUserMetadata(input).then(ref => { settled = true; return ref; });
  try {
    await ready;
    input.origin = { kind: "operator" };
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally { release(); }
  const ref = await pending;
  expect(readStructuredUserMetadata(ref).origin).toEqual({ kind: "agent", role: "reviewer" });
}));

test("publication lock admission uses no synchronous filesystem calls and yields while held", async () => isolated(async root => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = withFileTransaction(join(root, "structured-user-metadata-publication"), "fixture busy", async () => {
    entered(); await held;
  });
  await ready;
  const syncCalls = [
    spyOn(fsDefault, "fsyncSync"), spyOn(fsNamed, "fsyncSync"),
    spyOn(fsDefault, "writeFileSync"), spyOn(fsNamed, "writeFileSync"),
    spyOn(fsDefault, "readdirSync"), spyOn(fsNamed, "readdirSync"),
    spyOn(fsDefault, "readFileSync"), spyOn(fsNamed, "readFileSync"),
    spyOn(fsDefault, "statSync"), spyOn(fsNamed, "statSync"),
    spyOn(fsDefault, "existsSync"), spyOn(fsNamed, "existsSync"),
    spyOn(fsDefault, "openSync"), spyOn(fsNamed, "openSync"),
  ];
  let settled = false;
  const pending = persistStructuredUserMetadata(record()).then(value => { settled = true; return value; });
  let ref: string;
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBeFalse();
    expect(syncCalls.every(call => call.mock.calls.length === 0)).toBeTrue();
    release();
    ref = await pending;
    expect(await persistStructuredUserMetadata(record())).toBe(ref);
    await collectStructuredUserMetadata({ complete: true, listedAt: Date.now(), sources: [] });
    expect(syncCalls.every(call => call.mock.calls.length === 0)).toBeTrue();
  } finally {
    release();
    for (const call of syncCalls) call.mockRestore();
  }
  expect(readStructuredUserMetadata(ref)).toEqual(record());
  await owner;
}));

test("lost directory-sync acknowledgement refuses then retries with the same identity after restart", async () => isolated(async root => {
  const original = io.open;
  const open = spyOn(io, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith("structured-user-metadata")) handle.sync = async () => { throw new Error("induced directory sync failure"); };
    return handle;
  });
  restore = () => open.mockRestore();
  await expect(persistStructuredUserMetadata(record())).rejects.toThrow("induced directory sync failure");
  open.mockRestore(); restore = undefined;
  const moduleUrl = new URL("./structuredUserMetadata.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "-e", `const m=await import(${JSON.stringify(moduleUrl)}); console.log(await m.persistStructuredUserMetadata(${JSON.stringify(record())}));`],
    { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  const ref = output.trim();
  expect(await persistStructuredUserMetadata(record())).toBe(ref);
  expect(readStructuredUserMetadata(ref)).toEqual(record());
  expect((await io.readdir(join(root, "structured-user-metadata"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
}));

test("concurrent identical publication agrees and corruption cannot be replaced on retry", async () => isolated(async root => {
  const refs = await Promise.all([persistStructuredUserMetadata(record()), persistStructuredUserMetadata(record())]);
  expect(refs[0]).toBe(refs[1]);
  const directory = join(root, "structured-user-metadata");
  const filename = (await io.readdir(directory)).find(name => name.endsWith(".json"))!;
  await io.writeFile(join(directory, filename), "{}");
  await expect(persistStructuredUserMetadata(record())).rejects.toThrow("different metadata");
  expect(await io.readFile(join(directory, filename), "utf8")).toBe("{}");
  expect((await io.readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
}));
