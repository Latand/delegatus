/** Shared two-install HTTP fixtures. Each suite owns its roots and child PIDs. */
import { expect } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import type { BoardTask } from "@/lib/tasks/types";

export type Captured = { request: string; response: string };

export function createLinkTestInstalls() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-link-http-test-"));
  const remote = "code.example.test/acme/widget";
  const key = projectIdentityFromRemote(`https://${remote}`, "/")!.project;
  const installProcesses = new Map<string, ChildProcessWithoutNullStreams>();
  const installPorts = new Map<string, number>();
  const children = new Set<ChildProcessWithoutNullStreams>();
  async function install(name: string, extraRemotes: Record<string, string> = {}, source = process.cwd()): Promise<string> {
    const state = path.join(root, name);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [key]: remote, ...extraRemotes } }));
    // Each install scans only its own homes, never the operator's transcripts.
    const home = path.join(state, "home");
    fs.mkdirSync(path.join(state, "tmp"), { recursive: true });
    const preferredPort = installPorts.get(name);
    const child = spawn(process.execPath, ["src/lib/links/testServer.ts", state, ...(preferredPort ? [`--port=${preferredPort}`] : [])], { cwd: source, env: { ...process.env, LLV_STATE_DIR: state, XDG_CONFIG_HOME: path.join(state, "config"),
      HOME: home, TMPDIR: path.join(state, "tmp"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_CLAUDE_HOME: path.join(home, ".claude"), LLV_CODEX_HOME: path.join(home, ".codex") } });
    children.add(child);
    child.once("exit", () => children.delete(child));
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
    const url = `http://127.0.0.1:${port}`;
    installPorts.set(name, port);
    installProcesses.set(url, child);
    return url;
  }

  async function stopInstall(url: string): Promise<void> {
    const child = installProcesses.get(url);
    if (!child) return;
    installProcesses.delete(url);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  }

  async function request(base: string, route: string, method = "GET", body?: object) {
    const response = await fetch(base + route, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  /** Pairs A to B (through `via`, a proxy in front of B, when given) and links the given projects on both sides. */
  async function link(a: string, b: string, share: { all?: boolean; projects?: string[] } = { projects: [key] }, via = b, initialSync = true): Promise<string> {
    const code = String((await request(b, "/api/links/codes", "POST")).body.code);
    expect((await request(a, "/api/links/peers", "POST", { url: via, code })).status).toBe(200);
    const peerId = ((await request(a, "/api/links/peers")).body.peers as { id: string }[])[0]!.id;
    for (const side of [a, b]) expect((await request(side, "/api/links/shared", "POST", { v: 1, all: share.all ?? false, projects: share.projects ?? [] })).status).toBe(200);
    if (initialSync) await sync(a, peerId);
    return peerId;
  }

  async function sync(a: string, peerId: string): Promise<void> {
    const answer = await request(a, `/api/links/peers/${peerId}`, "POST");
    if (answer.status !== 200) throw new Error(`sync failed: ${JSON.stringify(answer.body)}`);
  }

  const tasksOf = async (base: string) => (await request(base, "/test/tasks")).body as unknown as BoardTask[];
  const taskOn = async (base: string, id: string) => (await tasksOf(base)).find((task) => task.id === id);
  async function createOn(base: string, text: string, extra: Record<string, unknown> = {}): Promise<BoardTask> {
    const created = await request(base, "/api/tasks", "POST", { project: key, text, placement: "unplaced", ...extra });
    expect(created.status).toBe(200);
    return created.body.task as BoardTask;
  }
  async function patchOn(base: string, id: string, patch: Record<string, unknown>) {
    const answer = await request(base, `/api/tasks/${id}`, "PATCH", patch);
    return answer;
  }
  const captured = async (base: string, reset = true) => (await request(base, `/test/captured${reset ? "?reset=1" : ""}`)).body as unknown as Captured[];

  /** Execute the actual stage decoder/routes, with no branch or live install. */
  function oldSource(): string {
    const source = path.join(root, "source-c18ab355");
    if (fs.existsSync(source)) return source;
    fs.mkdirSync(source);
    const archive = spawnSync("git", ["archive", "c18ab355", "src", "bin", "tsconfig.json", "package.json"], { maxBuffer: 64 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`old source archive failed: ${archive.stderr.toString()}`);
    const unpack = spawnSync("tar", ["-x", "-C", source], { input: archive.stdout });
    if (unpack.status !== 0) throw new Error(`old source extraction failed: ${unpack.stderr.toString()}`);
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(source, "node_modules"), "dir");
    return source;
  }

  /** A Claude transcript on A whose first prompt carries a canary, in a checkout of the linked repository. */
  function seedTranscript(name: string, prompt: string, origin = remote, sessionId = "session-canary"): void {
    const checkout = path.join(root, name, "checkout", origin.split("/").at(-1)!);
    fs.mkdirSync(checkout, { recursive: true });
    for (const args of fs.existsSync(path.join(checkout, ".git")) ? [] : [["init", "-q"], ["remote", "add", "origin", `https://${origin}`]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: checkout, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      if (git.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${git.stderr.toString()}`);
    }
    const projects = path.join(root, name, "home", ".claude", "projects", checkout.replace(/[/.]/g, "-"));
    fs.mkdirSync(projects, { recursive: true });
    const at = (offset: number) => new Date(Date.now() - 60_000 + offset).toISOString();
    const envelope = { isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd: checkout, sessionId, version: "2.1.0", gitBranch: "main" };
    const records = [
      { ...envelope, parentUuid: null, uuid: "rec-prompt", timestamp: at(0), type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } },
      { ...envelope, parentUuid: "rec-prompt", uuid: "rec-answer", timestamp: at(1_000), type: "assistant", requestId: "req-1",
        message: { id: "msg-1", model: "claude-opus-5", role: "assistant", type: "message", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "Done." }] } },
    ];
    fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }

  async function stopAll(): Promise<void> {
    for (const url of [...installProcesses.keys()]) await stopInstall(url);
    // A startup timeout still owns its recorded child, even without a URL.
    for (const child of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
    }
  }
  async function cleanup(): Promise<void> {
    await stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, remote, key, install, stopInstall, stopAll, cleanup, request, link, sync,
    tasksOf, taskOn, createOn, patchOn, captured, oldSource, seedTranscript };
}
