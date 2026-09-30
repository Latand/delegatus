import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { projectIdentityFromRemote } from "@/lib/projects/identity";

test("scheduler and API bundles share freshness, cursors and per-link serialization", async () => {
  const realNow = Date.now;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-link-bundles-"));
  const original = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
  process.env.LLV_STATE_DIR = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  const project = projectIdentityFromRemote("https://code.example.test/acme/widget", "/")!.project;
  const self = randomUUID(), peer = randomUUID(), store = randomUUID();
  const shared = [{ key: project, name: "widget" }];
  const sharedHash = createHash("sha256").update(JSON.stringify(shared)).digest("hex").slice(0, 8);
  let active = 0, maximum = 0, calls = 0, fail = false, malformed = false;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body);
    active++; maximum = Math.max(maximum, active);
    if (++calls === 1) { entered(); await held; }
    await new Promise((resolve) => setTimeout(resolve, 10));
    res.setHeader("content-type", "application/json");
    if (fail) { res.writeHead(429); res.end(JSON.stringify({ error: "quota" })); }
    else res.end(JSON.stringify({ v: 1, store, s: sharedHash, ...(wire.have !== sharedHash ? { shared, index: 0, total: 1 } : {}),
      tasks: { cursor: malformed ? "invalid" : [0], ...(wire.tasks?.scan ? { scan: null, at: [0] } : {}) },
      ...(wire.push ? { ack: { push: wire.push.through ?? wire.push.scan } } : {}),
      ...(wire.push?.agents ? { agentAck: wire.push.agents.cursor } : {}),
      agents: { cursor: "aaaaaaaaaaaaaaaa:1", rows: [{ k: "a:" + "b".repeat(16), p: project, t: "Remote work", e: "codex", m: "model", st: "working", at: Date.now() }] } }));
    active--;
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    fs.mkdirSync(path.join(root, "links"));
    fs.writeFileSync(path.join(root, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [project]: "code.example.test/acme/widget" } }));
    fs.writeFileSync(path.join(root, "links/self.json"), JSON.stringify({ v: 1, installId: self, label: "alpha", publicUrl: null, check: null }));
    fs.writeFileSync(path.join(root, "links/shared.json"), JSON.stringify({ v: 1, all: false, projects: [project] }));
    fs.writeFileSync(path.join(root, "links/peers.json"), JSON.stringify({ v: 1, peers: [{ id: peer, install: peer, url, token: "t".repeat(43), grantId: randomUUID(), label: "beta", store, state: "active", lastCall: 1, error: null }] }));
    const build = await Bun.build({
      entrypoints: ["src/lib/links/runtimeState.fixture.ts"], target: "bun",
      external: Object.keys((await Bun.file("package.json").json()).dependencies),
      plugins: [{ name: "source-alias", setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => ({
          path: Bun.resolveSync(path.join(process.cwd(), "src", args.path.slice(2)), process.cwd()),
        }));
      } }],
    });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]!.text();
    // Different URLs load two whole module graphs, as Next's bundles do.
    for (const name of ["scheduler", "api"]) fs.writeFileSync(path.join(root, `${name}.mjs`), code);
    // Resolve external dependencies from this checkout even though the bundles are isolated.
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir");
    const scheduler: typeof import("./runtimeState.fixture") = await import(path.join(root, "scheduler.mjs"));
    const api: typeof import("./runtimeState.fixture") = await import(path.join(root, "api.mjs"));
    const first = scheduler.syncPeer(peer);
    await started;
    const second = api.syncPeer(peer);
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    Date.now = () => realNow() + 960_000;
    const scheduledAt = Date.now();
    await scheduler.syncPeer(peer);
    const rows = await api.peersGET(new NextRequest("http://localhost/api/links/peers", { headers: { host: "localhost" } })).json();
    expect(rows.peers[0].lastCall).toBeGreaterThan(scheduledAt);
    expect(rows.peers[0].error).toBeNull();
    const agents = await api.agentsGET(new NextRequest(`http://localhost/api/links/agents?project=${project}`, { headers: { host: "localhost" } })).json();
    expect(agents.agents).toHaveLength(1);
    expect(agents.agents[0].stale).toBe(false);
    expect(agents.agents[0].asOf).toBeGreaterThan(scheduledAt);
    expect(api.agentCursors(`peer:${peer}`)).toBe(scheduler.agentCursors(`peer:${peer}`));
    expect(api.agentFeed(`peer:${peer}`)).toBe(scheduler.agentFeed(`peer:${peer}`));
    const exchangeLink = { id: peer, install: peer, store };
    const identity = { id: self, prefix: "11111111" };
    expect(api.taskExchange(exchangeLink, identity)).toBe(scheduler.taskExchange(exchangeLink, identity));
    malformed = true;
    await expect(api.syncPeer(peer)).rejects.toThrow("malformed");
    const invalid = await api.peersGET(new NextRequest("http://localhost/api/links/peers", { headers: { host: "localhost" } })).json();
    expect(invalid.peers[0].error).toBe("malformed");
    malformed = false;
    fail = true;
    await expect(scheduler.syncPeer(peer)).rejects.toThrow("quota");
    const failed = await api.peersGET(new NextRequest("http://localhost/api/links/peers", { headers: { host: "localhost" } })).json();
    expect(failed.peers[0].state).toBe("failing");
    expect(failed.peers[0].error).toBe("quota");
    fail = false;
    await scheduler.syncPeer(peer);
    const recovered = await api.peersGET(new NextRequest("http://localhost/api/links/peers", { headers: { host: "localhost" } })).json();
    expect(recovered.peers[0].state).toBe("active");
    expect(recovered.peers[0].error).toBeNull();
  } finally {
    Date.now = realNow;
    release?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (original.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original.state;
    if (original.config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = original.config;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
