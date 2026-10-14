import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProcessIdentity } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";

const LIFETIME = path.resolve(import.meta.dir, "../../testing/fixtureLifetime.ts");

/**
 * An engine process a registry row can record, with one detached tool it
 * started that keeps appending to a file in the worktree (#2790). The tool
 * leaves the engine's session and process group, as a detached shell does, so
 * only a tree captured while the engine runs can still name it once the engine
 * is gone. Both bind to this runner's identity and exit with it.
 *
 * `stream` makes the engine something a Claude stream host can drive: it leads
 * its own process group as a spawned engine does, keeps its standard streams
 * piped, and answers the first line it reads with output that is not stream
 * JSON, which is the stream fault that ends a host on its own.
 */
export async function orphanWriterTree(options: { engineIgnoresTerm?: boolean; toolIgnoresTerm?: boolean; stream?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orphan-writer-"));
  const written = path.join(directory, "worktree-file.txt");
  fs.writeFileSync(written, "");
  const runner = captureProcessIdentity(process.pid);
  const env = { ...process.env, LLV_FIXTURE_PARENT_IDENTITY: JSON.stringify(runner) };
  const tool = [
    `await import(${JSON.stringify(LIFETIME)});`,
    options.toolIgnoresTerm ? "process.on('SIGTERM', () => {});" : "",
    `const fs = await import("node:fs");`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(written)}, "x"), 20);`,
  ].join(" ");
  const engine = [
    `await import(${JSON.stringify(LIFETIME)});`,
    options.engineIgnoresTerm ? "process.on('SIGTERM', () => {});" : "",
    `const { spawn } = await import("node:child_process");`,
    `const tool = spawn(process.execPath, ["-e", ${JSON.stringify(tool)}], { detached: true, stdio: "ignore" });`,
    "tool.unref();",
    options.stream
      ? "process.stderr.write(`${tool.pid}\\n`); process.stdin.once('data', () => process.stdout.write('not json\\n'));"
      : "process.stdout.write(`${tool.pid}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const child = spawn(process.execPath, ["-e", engine], options.stream
    ? { env, stdio: ["pipe", "pipe", "pipe"], detached: true }
    : { env, stdio: ["ignore", "pipe", "ignore"] }) as ChildProcessWithoutNullStreams;
  const report = options.stream ? child.stderr : child.stdout;
  let engineIdentity: ProcessIdentity | null = null;
  let toolIdentity: ProcessIdentity | null = null;
  const stop = async () => {
    for (const identity of [engineIdentity, toolIdentity]) {
      if (identity?.startIdentity) await stopFixtureIdentity(identity).catch(() => undefined);
    }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const toolPid = await new Promise<number>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => reject(new Error("orphan writer fixture did not report its tool within 5000ms")), 5_000);
      report.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const line = buffered.split("\n")[0];
        if (buffered.includes("\n") && Number(line) > 0) { clearTimeout(timer); resolve(Number(line)); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("orphan writer fixture exited before reporting its tool")); });
    });
    engineIdentity = captureProcessIdentity(child.pid!);
    toolIdentity = captureProcessIdentity(toolPid);
    if (!engineIdentity.startIdentity || !engineIdentity.bootEpoch || !toolIdentity.startIdentity) {
      throw new Error("orphan writer fixture has no complete process identity");
    }
    const recordedEngine = engineIdentity;
    const recordedTool = toolIdentity;
    const alive = (identity: ProcessIdentity) => processIdentityStatus(identity) === "alive" && !procBackend.processExited(identity.pid);
    /* The tool is writing before any caller looks. */
    for (let attempt = 0; attempt < 250 && fs.statSync(written).size === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    if (fs.statSync(written).size === 0) throw new Error("orphan writer fixture tool never wrote");
    return {
      child,
      engine: recordedEngine,
      tool: recordedTool,
      engineAlive: () => alive(recordedEngine),
      toolAlive: () => alive(recordedTool),
      /** Whether the file still grows over a window several writes long. */
      stillWriting: async () => {
        const before = fs.statSync(written).size;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return fs.statSync(written).size > before;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
