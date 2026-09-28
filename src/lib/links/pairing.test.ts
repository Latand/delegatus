import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectIdentityFromRemote } from "@/lib/projects/identity";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pairing-test-"));
const remote = "code.example.test/acme/widget";
const key = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
const localKey = projectIdentityFromRemote("file:///var/fixtures/widget", "/")!.project;
const processes: ChildProcessWithoutNullStreams[] = [];
afterAll(() => {
  for (const child of processes) if (child.pid && !child.killed) child.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
});

async function install(name: string, extraRemotes: Record<string, string> = {}, configureAddress = true): Promise<string> {
  const state = path.join(root, name);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [key]: remote, [localKey]: "file:/var/fixtures/widget", ...extraRemotes } }));
  const child = spawn(process.execPath, ["src/lib/links/testServer.ts", state, ...(configureAddress ? [] : ["--no-address"])], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: state, XDG_CONFIG_HOME: path.join(state, "config") } });
  processes.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n")[0];
      if (line && output.includes("\n")) {
        try { resolve((JSON.parse(line) as { port: number }).port); } catch (error) { reject(error); }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.on("exit", (code) => reject(new Error(`test server exited ${code}: ${errors}`)));
    setTimeout(() => reject(new Error(`test server did not start: ${errors}`)), 15_000).unref();
  });
  return `http://127.0.0.1:${port}`;
}

test("a fresh outbound install pairs without saving its own public address", async () => {
  const a = await install("fresh-A", {}, false);
  const b = await install("fresh-B");
  const selfFile = path.join(root, "fresh-A", "links/self.json");
  expect(fs.existsSync(selfFile)).toBe(false);
  expect((await request(a, "/api/links")).body.self).toBeNull();
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const self = JSON.parse(fs.readFileSync(selfFile, "utf8")) as { installId: string; publicUrl: string | null };
  expect(self.installId).toMatch(/^[0-9a-f-]{36}$/);
  expect(self.publicUrl).toBeNull();
  expect(((await request(a, "/api/links/peers")).body.peers as unknown[])).toHaveLength(1);
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[])).toHaveLength(1);
  expect((await request(a, "/api/links", "POST", { action: "save", publicUrl: a })).status).toBe(200);
  expect(JSON.parse(fs.readFileSync(selfFile, "utf8")).installId).toBe(self.installId);
});

async function request(base: string, route: string, method = "GET", body?: object) {
  const response = await fetch(base + route, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as Record<string, unknown>, raw: response };
}

function fileMarks(directory: string): Record<string, { size: number; mtimeMs: number }> {
  const state = path.join(root, directory);
  const marks: Record<string, { size: number; mtimeMs: number }> = {};
  for (const name of ["state.sqlite", "state.sqlite-wal", "links/grants.json", "links/peers.json", "links/shared.json"]) {
    const file = path.join(state, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    marks[name] = { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  return marks;
}

test("two installs pair, share only chosen network repos, then revoke; 100 idle exchanges stay within wire budget", async () => {
  const a = await install("A");
  const b = await install("B");
  expect(fs.existsSync(path.join(root, "A", "links/shared.json"))).toBe(false);
  expect((await request(a, "/api/links/shared")).body.shared).toEqual({ v: 1, all: false, projects: [] });
  const minted = await request(b, "/api/links/codes", "POST");
  expect(minted.status).toBe(200);
  const code = String(minted.body.code);
  const connected = await request(a, "/api/links/peers", "POST", { url: b, code, name: "B" });
  expect(connected.status).toBe(200);
  expect(JSON.stringify(connected.body)).not.toContain("token");
  const aPeers = await request(a, "/api/links/peers");
  const bGrants = await request(b, "/api/links/grants");
  expect((aPeers.body.peers as unknown[]).length).toBe(1);
  expect((bGrants.body.grants as unknown[]).length).toBe(1);
  expect(JSON.stringify((await request(b, "/test/wire")).body)).not.toContain(key);
  expect((await request(b, "/api/peer/v1/info")).status).toBe(401);
  expect((await request(b, "/api/peer/v1/unknown")).body).toEqual({ error: "unauthorized" });
  expect((await request(b, "/api/peer/v2/unknown")).body).toEqual({ error: "unauthorized" });
  expect((await request(b, "/api/peer")).status).toBe(401);
  expect((await request(b, "/api/peer/v1/self-check")).status).toBe(401);
  const storedPeer = JSON.parse(fs.readFileSync(path.join(root, "A", "links/peers.json"), "utf8")).peers[0] as { token: string; grantId: string };
  const info = await fetch(b + "/api/peer/v1/info", { headers: { "x-delegatus-peer": `${storedPeer.grantId}.${storedPeer.token}` } });
  expect(info.status).toBe(200);
  expect(JSON.stringify(await info.json())).not.toContain(key);
  expect((await fetch(b + "/api/peer/v2/unknown", { headers: { "x-delegatus-peer": `${storedPeer.grantId}.${storedPeer.token}` } })).status).toBe(404);
  expect((await request(b, "/api/peer/v1/pair", "POST", { code, install: "00000000-0000-0000-0000-000000000000", label: "A" })).status).toBe(410);
  const nextCode = String((await request(b, "/api/links/codes", "POST")).body.code);
  const wrong = `${nextCode.slice(0, -1)}${nextCode.endsWith("0") ? "1" : "0"}`;
  for (let attempt = 0; attempt < 5; attempt++) expect((await request(b, "/api/peer/v1/pair", "POST", { code: wrong, install: "00000000-0000-0000-0000-000000000000", label: "A" })).status).toBe(401);
  const limited = await request(b, "/api/peer/v1/pair", "POST", { code: wrong, install: "00000000-0000-0000-0000-000000000000", label: "A" });
  expect(limited.status).toBe(429);
  expect(limited.raw.headers.get("retry-after")).toBe("60");
  for (const value of [minted.body, connected.body, aPeers.body, bGrants.body, (await request(a, "/api/links/shared")).body, (await request(b, "/api/links/shared")).body]) {
    // Operator project catalogs may name local repos, but peer payloads must
    // contain no chosen project while both sharing lists are empty.
    if (value === minted.body || value === connected.body || value === aPeers.body || value === bGrants.body) expect(JSON.stringify(value)).not.toContain(key);
  }
  const peerId = (aPeers.body.peers as { id: string }[])[0]!.id;
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: false, projects: [key] })).status).toBe(200);
  expect(fs.statSync(path.join(root, "A", "links/shared.json")).mode & 0o777).toBe(0o600);
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  const oneSided = await request(b, "/api/links/shared");
  expect((oneSided.body.states as { label: string; projects: { key: string; state: string }[] }[])[0]).toMatchObject({ label: "A", projects: [{ key, state: "only-there" }] });
  expect((await request(b, "/api/links/shared", "POST", { v: 1, all: false, projects: [key] })).status).toBe(200);
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  expect(JSON.stringify((await request(a, "/api/links/shared")).body.states)).toContain('"state":"linked"');
  expect(JSON.stringify((await request(b, "/api/links/shared")).body.states)).toContain('"state":"linked"');
  for (const invalid of [`dir-${"a".repeat(32)}`, localKey, "file:/var/fixtures/widget", "local:/var/fixtures/widget"]) {
    expect((await request(a, "/api/links/shared", "POST", { v: 1, all: false, projects: [invalid] })).status).toBe(400);
  }
  const lan = [192, 168, 1, 9].join(".");
  expect((await request(a, "/api/links/peers", "POST", { url: `http://${lan}:8898`, code: "ABCDEF-ABCDE-ABCDE" })).body.error).toBe("http-public");

  const before = (await request(b, "/test/metrics")).body as { syncCalls: number; syncRead: number; syncWritten: number };
  const diskA = fileMarks("A");
  const diskB = fileMarks("B");
  for (let i = 0; i < 100; i++) {
    const response = await request(a, `/api/links/peers/${peerId}`, "POST");
    expect(response.status).toBe(200);
  }
  const after = (await request(b, "/test/metrics")).body as { syncCalls: number; syncRead: number; syncWritten: number; maxSyncBodyLast100: number; maxSyncAnswerLast100: number };
  expect(after.syncCalls - before.syncCalls).toBe(100);
  expect(after.maxSyncBodyLast100).toBeLessThanOrEqual(200);
  expect(after.maxSyncAnswerLast100).toBeLessThanOrEqual(200);
  expect((after.syncRead - before.syncRead + after.syncWritten - before.syncWritten) / 100).toBeLessThanOrEqual(1024);
  expect(fileMarks("A")).toEqual(diskA);
  expect(fileMarks("B")).toEqual(diskB);
  const counts = ((await request(b, "/api/links/grants")).body.grants as { today: number; sevenDays: number }[])[0]!;
  expect(counts.today).toBeGreaterThanOrEqual(100);
  expect(counts.sevenDays).toBeGreaterThanOrEqual(counts.today);

  // A receiver that lost its shared-list row asks for the list again on the
  // next call; the sender may have had no local sharing change since then.
  const grantId = (bGrants.body.grants as { id: string }[])[0]!.id;
  expect((await request(b, `/test/forget-remote?id=${grantId}`)).body.forgotten).toBe(true);
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  expect(JSON.stringify((await request(b, "/api/links/shared")).body.states)).toContain('"state":"linked"');

  expect((await request(b, `/api/links/grants?id=${grantId}`, "DELETE")).status).toBe(200);
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).body.error).toBe("revoked");
  expect(((await request(a, "/api/links/peers")).body.peers as { state: string }[])[0]!.state).toBe("revoked");
  expect(((await request(a, "/api/links/shared")).body.states as { projects: unknown[] }[])[0]!.projects).toEqual([]);
});

test("share-all pages more than 100 projects and the next idle exchange is one call", async () => {
  const remotes: Record<string, string> = {};
  for (let index = 0; index < 205; index++) {
    const name = `code.example.test/acme/widget-${index}`;
    remotes[projectIdentityFromRemote(`https://${name}`, "/")!.project] = name;
  }
  const a = await install("pages-A", remotes);
  const b = await install("pages-B", remotes);
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const peerId = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: true, projects: [] })).status).toBe(200);
  expect((await request(b, "/api/links/shared", "POST", { v: 1, all: true, projects: [] })).status).toBe(200);
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  const states = ((await request(b, "/api/links/shared")).body.states as { projects: { state: string }[] }[])[0]!.projects;
  expect(states).toHaveLength(206);
  expect(states.every((row) => row.state === "linked")).toBe(true);
  const before = (await request(b, "/test/metrics")).body as { syncCalls: number; syncRead: number; syncWritten: number };
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  const after = (await request(b, "/test/metrics")).body as { syncCalls: number; syncRead: number; syncWritten: number };
  expect(after.syncCalls - before.syncCalls).toBe(1);
  expect(after.syncRead - before.syncRead + after.syncWritten - before.syncWritten).toBeLessThanOrEqual(1024);
});

test("unsharing between announcement pages resets the next HTTP request and receiver list", async () => {
  const remotes: Record<string, string> = {};
  for (let index = 0; index < 100; index++) {
    const remote = `code.example.test/acme/paged-${index}`;
    remotes[projectIdentityFromRemote(`https://${remote}`, "/")!.project] = remote;
  }
  const withheldKey = [...Object.keys(remotes), key].sort().at(-1)!;
  const a = await install("unshare-A", remotes);
  const b = await install("unshare-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const peerId = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: true, projects: [] })).status).toBe(200);
  const before = ((await request(b, "/test/wire")).body as unknown as { path: string }[]).length;
  await request(b, "/test/hold-sync");
  const inFlight = request(a, `/api/links/peers/${peerId}`, "POST");
  try {
    const deadline = Date.now() + 5_000;
    while ((await request(b, "/test/sync-held")).body.held !== true) {
      if (Date.now() > deadline) throw new Error("first announcement page was not held");
      await Bun.sleep(10);
    }
    expect((await request(a, "/api/links/shared", "POST", { v: 1, all: false, projects: [] })).status).toBe(200);
  } finally {
    await request(b, "/test/release-sync");
  }
  expect((await inFlight).status).toBe(200);
  const sent = (((await request(b, "/test/wire")).body as unknown as { path: string; request: string }[]).slice(before)
    .filter((entry) => entry.path === "/api/peer/v1/boards/sync")
    .map((entry) => JSON.parse(entry.request) as { index?: number; total?: number; shared?: { key: string }[] }));
  expect(sent[0]).toMatchObject({ index: 0, total: 101 });
  expect(sent[0]!.shared).toHaveLength(100);
  expect(sent[0]!.shared!.some((project) => project.key === withheldKey)).toBe(false);
  expect(sent[1]).toMatchObject({ index: 0, total: 0, shared: [] });
  expect(sent.slice(1).some((page) => page.shared?.some((project) => project.key === withheldKey))).toBe(false);
  const states = ((await request(b, "/api/links/shared")).body.states as { projects: { key: string }[] }[])[0]!.projects;
  expect(states).toEqual([]);
});

test("a changed peer digest restarts received pages within the same sync", async () => {
  const remotes: Record<string, string> = {};
  for (let index = 0; index < 100; index++) {
    const remote = `code.example.test/acme/peer-page-${index}`;
    remotes[projectIdentityFromRemote(`https://${remote}`, "/")!.project] = remote;
  }
  const a = await install("receive-A");
  const b = await install("receive-B", remotes);
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const peerId = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  expect((await request(b, "/api/links/shared", "POST", { v: 1, all: false, projects: [key] })).status).toBe(200);
  expect((await request(a, `/api/links/peers/${peerId}`, "POST")).status).toBe(200);
  expect((await request(b, "/api/links/shared", "POST", { v: 1, all: true, projects: [] })).status).toBe(200);
  const before = ((await request(b, "/test/wire")).body as unknown as { path: string }[]).length;
  await request(b, "/test/hold-sync?side=response");
  const inFlight = request(a, `/api/links/peers/${peerId}`, "POST");
  try {
    const deadline = Date.now() + 5_000;
    while ((await request(b, "/test/sync-held")).body.held !== true) {
      if (Date.now() > deadline) throw new Error("first received page was not held");
      await Bun.sleep(10);
    }
    expect((await request(b, "/api/links/shared", "POST", { v: 1, all: false, projects: [] })).status).toBe(200);
  } finally {
    await request(b, "/test/release-sync");
  }
  expect((await inFlight).status).toBe(200);
  const sent = (((await request(b, "/test/wire")).body as unknown as { path: string; request: string }[]).slice(before)
    .filter((entry) => entry.path === "/api/peer/v1/boards/sync")
    .map((entry) => JSON.parse(entry.request) as { want?: number }));
  expect(sent[1]!.want).toBe(100);
  expect(sent[2]!.want).toBeUndefined();
  expect(((await request(a, "/api/links/shared")).body.states as { projects: unknown[] }[])[0]!.projects).toEqual([]);
  expect(((await request(a, "/api/links/peers")).body.peers as { state: string }[])[0]!.state).toBe("active");
});

test("two simultaneous manual syncs serialize their shared-list pages", async () => {
  const remotes: Record<string, string> = {};
  for (let index = 0; index < 100; index++) {
    const remote = `code.example.test/acme/overlap-${index}`;
    remotes[projectIdentityFromRemote(`https://${remote}`, "/")!.project] = remote;
  }
  const a = await install("overlap-A", remotes);
  const b = await install("overlap-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const id = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: true, projects: [] })).status).toBe(200);
  await request(b, "/test/hold-sync");
  const first = request(a, `/api/links/peers/${id}`, "POST");
  try {
    const deadline = Date.now() + 5_000;
    while ((await request(b, "/test/sync-held")).body.held !== true) {
      if (Date.now() > deadline) throw new Error("first overlapping page was not held");
      await Bun.sleep(10);
    }
    const second = request(a, `/api/links/peers/${id}`, "POST");
    await Bun.sleep(100);
    await request(b, "/test/release-sync");
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  } finally {
    await request(b, "/test/release-sync");
  }
  const states = ((await request(b, "/api/links/shared")).body.states as { projects: unknown[] }[])[0]!.projects;
  expect(states).toHaveLength(101);
});

test("project patches preserve sharing changes made after a row loaded", async () => {
  const remote = "code.example.test/acme/second";
  const second = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
  const a = await install("patch-A", { [second]: remote });
  const stale = (await request(a, "/api/links/shared")).body.shared;
  expect(stale).toEqual({ v: 1, all: false, projects: [] });
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: false, projects: [second] })).status).toBe(200);
  expect((await request(a, "/api/links/shared", "PATCH", { project: key, enabled: true })).status).toBe(200);
  expect((await request(a, "/api/links/shared")).body.shared).toEqual({ v: 1, all: false, projects: [key, second].sort() });
  expect((await request(a, "/api/links/shared", "PATCH", { project: second, enabled: false })).status).toBe(200);
  expect((await request(a, "/api/links/shared")).body.shared).toEqual({ v: 1, all: false, projects: [key] });
  expect((await request(a, "/api/links/shared", "PATCH", { project: localKey, enabled: true })).status).toBe(400);
});

test("a null pairing request is rejected as malformed", async () => {
  const a = await install("null-pair-A");
  const response = await fetch(`${a}/api/links/peers`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "malformed" });
});

test("failed post-pair verification revokes the grant or reports that cleanup is unconfirmed", async () => {
  const a = await install("info-A");
  const b = await install("info-B");
  await request(b, "/test/bad-info?on=1");
  const first = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code: first })).body.error).toBe("not-delegatus");
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[])).toEqual([]);
  await request(b, "/test/fail-grant-delete?on=503");
  const second = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code: second })).body.error).toBe("grant-cleanup-needed");
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[])).toHaveLength(1);
  expect(((await request(a, "/api/links/peers")).body.peers as unknown[])).toEqual([]);
  await request(b, "/test/fail-grant-delete?on=401");
  const third = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code: third })).body.error).toBe("grant-cleanup-needed");
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[])).toHaveLength(2);
});

test("a denied grant deletion warns when removing the local link", async () => {
  const a = await install("remove-401-A");
  const b = await install("remove-401-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const id = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  await request(b, "/test/fail-grant-delete?on=401");
  expect((await request(a, `/api/links/peers/${id}`, "DELETE")).body.warned).toBe(true);
  expect(((await request(a, "/api/links/peers")).body.peers as unknown[])).toEqual([]);
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[])).toHaveLength(1);
});

test("remote-only project keeps its announced name and cannot be shared locally", async () => {
  const alphaRemote = "code.example.test/acme/alpha";
  const alpha = projectIdentityFromRemote(`https://${alphaRemote}`, "/")!.project;
  const a = await install("remote-A", { [alpha]: alphaRemote });
  const b = await install("remote-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const id = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  expect((await request(a, "/api/links/shared", "POST", { v: 1, all: false, projects: [alpha] })).status).toBe(200);
  expect((await request(a, `/api/links/peers/${id}`, "POST")).status).toBe(200);
  const view = (await request(b, "/api/links/shared")).body as { known: { key: string }[]; states: { projects: { key: string; name: string; state: string }[] }[] };
  expect(view.known.some((project) => project.key === alpha)).toBe(false);
  expect(view.states[0]!.projects).toContainEqual({ key: alpha, name: "alpha", state: "only-there" });
  expect((await request(b, "/api/links/shared", "POST", { v: 1, all: false, projects: [alpha] })).status).toBe(400);
});

test("another code pairs while the first code is rate limited", async () => {
  const b = await install("rate-B");
  const c = await install("rate-C");
  const first = String((await request(b, "/api/links/codes", "POST")).body.code);
  const wrong = `${first.slice(0, -1)}${first.endsWith("0") ? "1" : "0"}`;
  for (let i = 0; i < 5; i++) expect((await request(b, "/api/peer/v1/pair", "POST", { code: wrong, install: "00000000-0000-0000-0000-000000000000", label: "A" })).status).toBe(401);
  expect((await request(b, "/api/peer/v1/pair", "POST", { code: wrong, install: "00000000-0000-0000-0000-000000000000", label: "A" })).status).toBe(429);
  const second = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(c, "/api/links/peers", "POST", { url: b, code: second })).status).toBe(200);
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[]).length).toBe(1);
});

test("minting a replacement retires the previous visible pairing code", async () => {
  const a = await install("rotate-A");
  const b = await install("rotate-B");
  const first = String((await request(b, "/api/links/codes", "POST")).body.code);
  const second = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(b, "/api/peer/v1/pair", "POST", { code: first, install: "00000000-0000-0000-0000-000000000000", label: "A" })).status).toBe(410);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code: second })).status).toBe(200);
  expect(((await request(b, "/api/links/grants")).body.grants as unknown[])).toHaveLength(1);
});

test("a failed link recovers durably after a successful sync", async () => {
  const a = await install("recover-A");
  const b = await install("recover-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const id = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  await request(b, "/test/fail-sync?on=1");
  expect((await request(a, `/api/links/peers/${id}`, "POST")).status).toBe(409);
  expect(((await request(a, "/api/links/peers")).body.peers as { state: string }[])[0]!.state).toBe("failing");
  await request(b, "/test/fail-sync?on=0");
  expect((await request(a, `/api/links/peers/${id}`, "POST")).status).toBe(200);
  expect(((await request(a, "/api/links/peers")).body.peers as { state: string; error: string | null }[])[0]).toMatchObject({ state: "active", error: null });
  expect(JSON.parse(fs.readFileSync(path.join(root, "recover-A", "links/peers.json"), "utf8")).peers[0]).toMatchObject({ state: "active", error: null });
});

test("a temporarily denied peer can recover on an explicit later sync", async () => {
  const a = await install("denied-A");
  const b = await install("denied-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const id = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
  await request(b, "/test/fail-sync?on=401");
  expect((await request(a, `/api/links/peers/${id}`, "POST")).body.error).toBe("revoked");
  expect(((await request(a, "/api/links/peers")).body.peers as { state: string }[])[0]!.state).toBe("revoked");
  await request(b, "/test/fail-sync?on=0");
  expect((await request(a, `/api/links/peers/${id}`, "POST")).status).toBe(200);
  expect(((await request(a, "/api/links/peers")).body.peers as { state: string }[])[0]!.state).toBe("active");
});

test("all unauthenticated peer paths return the same status, headers and body", async () => {
  const a = await install("guard-A");
  const b = await install("guard-B");
  const code = String((await request(b, "/api/links/codes", "POST")).body.code);
  expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
  const peer = JSON.parse(fs.readFileSync(path.join(root, "guard-A", "links/peers.json"), "utf8")).peers[0] as { token: string; grantId: string };
  const badToken = `${peer.grantId}.${"A".repeat(43)}`;
  const unknownGrant = `${"0".repeat(8)}-0000-0000-0000-000000000000.${peer.token}`;
  const grantsFile = path.join(root, "guard-B", "links/grants.json");
  const grants = JSON.parse(fs.readFileSync(grantsFile, "utf8"));
  const attempts = [
    ["/api/peer/v1/info", "GET", {}],
    ["/api/peer/v1/info", "GET", { "x-delegatus-peer": badToken }],
    ["/api/peer/v1/info", "GET", { "x-delegatus-peer": unknownGrant }],
    ["/api/peer/v1/boards/sync", "POST", {}],
    ["/api/peer/v1/self-check", "GET", {}],
    ["/api/peer/v1/self-check", "POST", {}],
    ["/api/peer/v1/unknown", "GET", {}],
    ["/api/peer/v2/unknown", "GET", {}],
    ["/api/peer", "GET", {}],
    ["/api/peer", "GET", { authorization: "Bearer key" }],
    ["/api/peer", "GET", { cookie: "llv_auth=key" }],
    ["/api/peer/v1/info", "GET", { authorization: "Bearer key" }],
    ["/api/peer/v1/pair/probe", "POST", { "content-type": "application/json" }],
  ] as const;
  const signatures: string[] = [];
  for (const [route, method, headers] of attempts) {
    const response = await fetch(b + route, { method, headers });
    signatures.push(JSON.stringify({ status: response.status, cache: response.headers.get("cache-control"), type: response.headers.get("content-type"), body: await response.text() }));
  }
  expect(new Set(signatures).size).toBe(1);
  expect(JSON.parse(signatures[0]!)).toMatchObject({ status: 401, cache: "no-store", body: '{"error":"unauthorized"}' });
  grants.grants[0].scopes = [];
  fs.writeFileSync(grantsFile, JSON.stringify(grants));
  const missingScope = await fetch(b + "/api/peer/v1/boards/sync", { method: "POST", headers: { "x-delegatus-peer": `${peer.grantId}.${peer.token}` } });
  expect(JSON.stringify({ status: missingScope.status, cache: missingScope.headers.get("cache-control"), type: missingScope.headers.get("content-type"), body: await missingScope.text() })).toBe(signatures[0]);
});

test("pairing never follows a redirect to another install, and remove revokes its grant", async () => {
  const a = await install("remove-A");
  const b = await install("remove-B");
  const redirect = http.createServer((_request, response) => { response.writeHead(302, { location: b + "/api/peer/v1/pair", "content-type": "application/json" }); response.end('{"error":"redirect"}'); });
  redirect.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => redirect.once("listening", resolve));
  try {
    const port = (redirect.address() as { port: number }).port;
    const code = String((await request(b, "/api/links/codes", "POST")).body.code);
    expect((await request(a, "/api/links/peers", "POST", { url: `http://127.0.0.1:${port}`, code })).status).toBe(409);
    expect(((await request(b, "/api/links/grants")).body.grants as unknown[]).length).toBe(0);
    expect((await request(a, "/api/links/peers", "POST", { url: b, code })).status).toBe(200);
    const id = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
    expect((await request(a, `/api/links/peers/${id}`, "DELETE")).status).toBe(200);
    expect(((await request(a, "/api/links/peers")).body.peers as unknown[]).length).toBe(0);
    expect(((await request(b, "/api/links/grants")).body.grants as unknown[]).length).toBe(0);
  } finally { await new Promise<void>((resolve) => redirect.close(() => resolve())); }
});
