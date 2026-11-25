import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSecretRequest } from "./store";
import type { SecretDestination } from "./types";
import { readSecretRequest, recoverSecretRequests, writeSecretRequest, type WriteCheckpoint } from "./write";

const NOW = 1_795_000_000_000;
const fixedClock = { now: () => NOW };
const caller = {
  project: "fixture",
  requester: {
    conversationId: "seat", role: "orchestrator", engine: "codex", model: null, title: null,
    seat: { conversationId: "seat", title: null },
  },
};

let root: string;
let project: string;
let state: string;
let previousState: string | undefined;
let previousRoots: string | undefined;

beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  previousRoots = process.env.LLV_SECRET_ROOTS;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-write-")));
  project = path.join(root, "project");
  state = path.join(root, "state");
  fs.mkdirSync(project);
  process.env.LLV_STATE_DIR = state;
  process.env.LLV_SECRET_ROOTS = project;
});

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousRoots === undefined) delete process.env.LLV_SECRET_ROOTS;
  else process.env.LLV_SECRET_ROOTS = previousRoots;
  fs.rmSync(root, { recursive: true, force: true });
});

function create(destination: SecretDestination, clientRequestId = "request") {
  return createSecretRequest(caller, { clientRequestId, purpose: "Fixture entry", destination }, NOW);
}

test("create re-dispatch converges across concurrent calls and refuses a changed argument", async () => {
  const destination = { kind: "file", path: path.join(project, "entry") } as const;
  const messages = spyOn(console, "info").mockImplementation(() => {});
  try {
    const [left, right] = await Promise.all([create(destination), create(destination)]);
    expect(left).toEqual(right);
    expect(await create(destination)).toEqual(left);
    expect(messages.mock.calls).toHaveLength(1);
    await expect(create({ ...destination, trailingNewline: false })).rejects.toMatchObject({ code: "idempotency_conflict" });
  } finally { messages.mockRestore(); }
});

test("writes exact bytes at mode 600 and consumes entry once across a lost answer", async () => {
  for (const umask of [0, 0o077]) {
    const filename = path.join(project, `file-${umask}`);
    const request = await create({ kind: "file", path: filename, trailingNewline: umask === 0 }, `mode-${umask}`);
    const value = Buffer.from("two words ☃");
    const previous = process.umask(umask);
    try {
      await expect(writeSecretRequest(request.id, request.destinationRevision, value, { ...fixedClock, checkpoint(step) {
        if (step === "entered") throw new Error("simulated lost answer");
      } })).rejects.toMatchObject({ code: "secret_destination_unavailable" });
    } finally { process.umask(previous); }
    expect(value.every(byte => byte === 0)).toBe(true);
    expect(fs.readFileSync(filename, "utf8")).toBe(umask === 0 ? "two words ☃\n" : "two words ☃");
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(await readSecretRequest(request.id, NOW)).toMatchObject({ state: "entered", length: 11 });
    await expect(writeSecretRequest(request.id, request.destinationRevision, Buffer.from("again"), fixedClock))
      .rejects.toMatchObject({ code: "secret_not_pending" });
  }
});

test("writes an env entry with no canary in records, refusals, exceptions, logs or spare files", async () => {
  const filename = path.join(project, ".env");
  fs.writeFileSync(filename, "OTHER=untouched\nexport ENTRY=old\n", { mode: 0o644 });
  const canary = randomBytes(24).toString("hex");
  const logs: unknown[][] = [];
  const capture = (...args: unknown[]) => { logs.push(args); };
  const streams = [spyOn(console, "info").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture),
    spyOn(console, "error").mockImplementation(capture), spyOn(console, "log").mockImplementation(capture)];
  try {
    const request = await create({ kind: "env", path: filename, key: "ENTRY" });
    const failed = Buffer.from(canary);
    let thrown: unknown;
    try {
      await writeSecretRequest(request.id, request.destinationRevision, failed, { ...fixedClock, checkpoint(step) {
        if (step === "written") throw new Error(canary);
      } });
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "secret_destination_unavailable" });
    expect(String(thrown)).not.toContain(canary);
    expect((thrown as Error).stack).not.toContain(canary);
    expect(failed.every(byte => byte === 0)).toBe(true);
    expect(await readSecretRequest(request.id, NOW)).toMatchObject({
      state: "pending", refusals: [{ at: NOW, code: "secret_destination_unavailable" }],
    });
    expect(fs.readdirSync(project)).toEqual([".env"]);
    expect(fs.readFileSync(filename, "utf8")).toBe("OTHER=untouched\nexport ENTRY=old\n");
    const value = Buffer.from(canary);
    const receipt = await writeSecretRequest(request.id, request.destinationRevision, value, fixedClock);
    expect(receipt).toMatchObject({ state: "entered", length: canary.length, destination: { effect: "env-replace" } });
    expect(value.every(byte => byte === 0)).toBe(true);
    expect(fs.readFileSync(filename, "utf8")).toBe(`OTHER=untouched\nexport ENTRY=${canary}\n`);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(JSON.stringify([logs, receipt, await readSecretRequest(request.id, NOW)]).includes(canary)).toBe(false);
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      const candidate = path.join(entry.parentPath, entry.name);
      if (entry.isFile() && candidate !== filename) expect(fs.readFileSync(candidate).includes(canary)).toBe(false);
    }
  } finally { for (const stream of streams) stream.mockRestore(); }
});

test("refuses stale, expired and concurrently edited destinations", async () => {
  const filename = path.join(project, ".env");
  fs.writeFileSync(filename, "ENTRY=old\n");
  const request = await create({ kind: "env", path: filename, key: "ENTRY" });
  const write = (revision: string, options = fixedClock) => writeSecretRequest(request.id, revision, Buffer.from("new"), options);
  await expect(write("stale")).rejects.toMatchObject({ code: "secret_destination_changed" });
  await expect(writeSecretRequest(request.id, request.destinationRevision, Buffer.from("new"), {
    ...fixedClock, checkpoint(step) {
      if (step === "before-rename") fs.writeFileSync(filename, "ENTRY=changed in parallel\n");
    },
  })).rejects.toMatchObject({ code: "secret_destination_changed" });
  expect(fs.readFileSync(filename, "utf8")).toBe("ENTRY=changed in parallel\n");
  expect(fs.readdirSync(project)).toEqual([".env"]);
  await expect(write(request.destinationRevision, { now: () => request.expiresAt })).rejects.toMatchObject({ code: "secret_expired" });
  expect(await readSecretRequest(request.id, NOW)).toMatchObject({ state: "expired" });
});

test("a parent swapped for a symlink cannot redirect the open or leave an outside temporary", async () => {
  const outside = path.join(root, "outside");
  const parent = path.join(project, "parent");
  fs.mkdirSync(outside);
  fs.mkdirSync(parent);
  const filename = path.join(parent, "entry");
  const request = await create({ kind: "file", path: filename });
  await expect(writeSecretRequest(request.id, request.destinationRevision, Buffer.from("fixture"), {
    ...fixedClock, checkpoint(step) {
      if (step !== "validated") return;
      fs.renameSync(parent, path.join(project, "moved"));
      fs.symlinkSync(outside, parent, "dir");
    },
  })).rejects.toMatchObject({ code: "secret_destination_link" });
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.readdirSync(path.join(project, "moved"))).toEqual([]);
  expect(await readSecretRequest(request.id, NOW)).toMatchObject({ state: "pending" });
});

test("cleans a written temporary through the held directory after its name is replaced by a link", async () => {
  const outside = path.join(root, "outside");
  const parent = path.join(project, "parent");
  const moved = path.join(project, "moved");
  fs.mkdirSync(outside);
  fs.mkdirSync(parent);
  const request = await create({ kind: "file", path: path.join(parent, "entry") });
  await expect(writeSecretRequest(request.id, request.destinationRevision, Buffer.from("fixture"), {
    ...fixedClock, checkpoint(step) {
      if (step !== "before-rename") return;
      fs.renameSync(parent, moved);
      fs.symlinkSync(outside, parent, "dir");
    },
  })).rejects.toMatchObject({ code: "secret_destination_link" });
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.readdirSync(moved)).toEqual([]);
  expect(await readSecretRequest(request.id, NOW)).toMatchObject({ state: "pending" });
});

test("a moved in-root link refreshes the pending destination before an owner can confirm it", async () => {
  const first = path.join(project, "first");
  const second = path.join(project, "second");
  const link = path.join(project, "alias");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.symlinkSync(first, link, "dir");
  const request = await create({ kind: "file", path: path.join(link, "entry") });
  fs.unlinkSync(link);
  fs.symlinkSync(second, link, "dir");
  await expect(writeSecretRequest(request.id, request.destinationRevision, Buffer.from("fixture"), fixedClock))
    .rejects.toMatchObject({ code: "secret_destination_changed" });
  expect(fs.readdirSync(first)).toEqual([]);
  expect(fs.readdirSync(second)).toEqual([]);
  const pending = await readSecretRequest(request.id, NOW);
  expect(pending).toMatchObject({ state: "pending", destination: { path: path.join(second, "entry") } });
  expect(pending!.destinationRevision).not.toBe(request.destinationRevision);
  await writeSecretRequest(request.id, pending!.destinationRevision, Buffer.from("fixture"), fixedClock);
  expect(fs.readFileSync(path.join(second, "entry"), "utf8")).toBe("fixture\n");
});

const crashSteps = ["writing", "created", "journaled", "written", "file-synced", "before-rename", "renamed", "directory-synced", "entered"] as const;

async function crashAt(request: Awaited<ReturnType<typeof create>>, step: WriteCheckpoint) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { writeSecretRequest } from "./src/lib/secretRequests/write";
    const { FIXTURE_ID, FIXTURE_REVISION, FIXTURE_STEP, FIXTURE_NOW } = process.env;
    await writeSecretRequest(FIXTURE_ID, FIXTURE_REVISION, Buffer.from("new fixture"), {
      now: () => Number(FIXTURE_NOW),
      checkpoint(step) { if (step === FIXTURE_STEP) process.kill(process.pid, "SIGKILL"); },
    });
  `], {
    env: { ...process.env, FIXTURE_ID: request.id, FIXTURE_REVISION: request.destinationRevision, FIXTURE_STEP: step, FIXTURE_NOW: String(NOW) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (child.signalCode !== "SIGKILL") throw new Error(`crash fixture did not reach ${step}: ${stderr}`);
  expect(child.signalCode).toBe("SIGKILL");
}

for (const step of crashSteps) test(`recovers after process loss at ${step}`, async () => {
  const filename = path.join(project, ".env");
  const before = "OTHER=old\nENTRY=old\n";
  const after = "OTHER=old\nENTRY='new fixture'\n";
  fs.writeFileSync(filename, before, { mode: 0o640 });
  const request = await create({ kind: "env", key: "ENTRY", path: filename });
  await crashAt(request, step);
  const installed = step === "renamed" || step === "directory-synced" || step === "entered";
  expect(fs.readFileSync(filename, "utf8")).toBe(installed ? after : before);
  if (step === "written") expect(await recoverSecretRequests(NOW)).toEqual([]);
  const recovered = await readSecretRequest(request.id, NOW);
  expect(recovered?.state).toBe(installed ? "entered" : "pending");
  if (!installed) expect(recovered?.refusals.at(-1)?.code).toBe("secret_entry_interrupted");
  if (installed) expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(project)).toEqual([".env"]);
  expect(await readSecretRequest(request.id, NOW)).toEqual(recovered);
}, 15_000);

test("a later writer recovers a committed inode before replacing the same path", async () => {
  const filename = path.join(project, "entry");
  fs.writeFileSync(filename, "before\n");
  const destination = { kind: "file", path: filename, replace: true } as const;
  const first = await create(destination, "first");
  const second = await create(destination, "second");
  await crashAt(first, "renamed");
  await writeSecretRequest(second.id, second.destinationRevision, Buffer.from("later"), fixedClock);
  expect(await readSecretRequest(first.id, NOW)).toMatchObject({ state: "entered" });
  expect(await readSecretRequest(second.id, NOW)).toMatchObject({ state: "entered" });
  expect(fs.readFileSync(filename, "utf8")).toBe("later\n");
});

test.skipIf(process.platform !== "linux")("settles an installed inode even if the rename reports failure", async () => {
  const filename = path.join(project, "entry");
  const request = await create({ kind: "file", path: filename });
  const rename = fsp.rename;
  const interrupted = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to).startsWith("/proc/self/fd/")) throw new Error("rename reply interrupted");
  });
  try {
    await expect(writeSecretRequest(request.id, request.destinationRevision, Buffer.from("fixture"), fixedClock))
      .rejects.toMatchObject({ code: "secret_destination_unavailable" });
    expect(await readSecretRequest(request.id, NOW)).toMatchObject({ state: "entered" });
    expect(fs.readFileSync(filename, "utf8")).toBe("fixture\n");
    expect(fs.readdirSync(project)).toEqual(["entry"]);
  } finally { interrupted.mockRestore(); }
});
