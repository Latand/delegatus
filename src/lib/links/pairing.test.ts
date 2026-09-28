import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

async function install(name: string, extraRemotes: Record<string, string> = {}): Promise<string> {
  const state = path.join(root, name);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [key]: remote, [localKey]: "file:/var/fixtures/widget", ...extraRemotes } }));
  const child = spawn(process.execPath, ["src/lib/links/testServer.ts", state], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: state, XDG_CONFIG_HOME: path.join(state, "config") } });
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
