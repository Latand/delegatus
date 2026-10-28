import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AgentRegistry } from "@/lib/agent/registry";
import { stopFixtureProcess } from "@/lib/testing/fixtureProcess";

const WORKER_PATH = path.resolve(import.meta.dir, "../filesResponse.worker.ts");
const request = { type: "project", url: "http://127.0.0.1/api/files", headers: [],
  snapshot: { files: [], projectCatalog: [], complete: true } };

test("a cold projection worker yields to a registry writer before building its response", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "projection-lock-"));
  const env = { ...process.env, NODE_ENV: "production" as const, HOME: path.join(state, "home"),
    XDG_CONFIG_HOME: path.join(state, "config"), TMPDIR: state, LLV_STATE_DIR: state,
    LLV_AGENT_REGISTRY_SQLITE: "sqlite", LLV_FILES_RESPONSE_WORKER: "1" };
  let peer: Database | undefined;
  let child: ChildProcess | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    new AgentRegistry(path.join(state, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" }).close();
    peer = new Database(path.join(state, "agent-registry.sqlite"));
    peer.exec("PRAGMA busy_timeout=0");
    // Each request starts a fresh process and therefore a cold singleton.
    for (let attempt = 0; attempt < 2; attempt++) {
      peer.exec("BEGIN IMMEDIATE");
      const waiting = Promise.withResolvers<void>();
      let stderr = "";
      let stdout = "";
      child = spawn(process.execPath, [WORKER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('"callSite":"registry.prepare.open"') && stderr.includes('"outcome":"waiting"')) waiting.resolve();
      });
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
      const finished = new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", resolve);
      });
      deadline = setTimeout(() => child?.kill(), 10_000);
      child.stdin!.end(`${JSON.stringify({ id: "projection", request })}\n`);
      const first = await Promise.race([waiting.promise.then(() => "waiting"), finished.then(() => ({ stdout, stderr }))]);
      expect(first).toBe("waiting");
      peer.exec("ROLLBACK");
      expect(await finished, stderr).toBe(0);
      clearTimeout(deadline);
      const reply = JSON.parse(stdout);
      expect(reply.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(reply.result.bodyFile, "utf8")).files).toEqual([]);
      child = undefined;
    }
  } finally {
    clearTimeout(deadline);
    if (child) await stopFixtureProcess(child);
    if (peer?.inTransaction) peer.exec("ROLLBACK");
    peer?.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
