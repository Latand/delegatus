import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecPort } from "@/lib/workflows/provision";
import { containedDependencyExec, prepareLockedDependencies } from "./lockedDependencies";
import { preparePrivateDependencies } from "./provisionPrivateDependencies";
import { restrictInstallWrites } from "./provisionInstallBinding";
import { provisionFrame, provisionFrames, validPrivateIntent, validPrivateReceipt } from "./provisionToolchainProtocol";
import { recordProvisionFixtureEvent } from "./provisionFixtureSupervisor";

const args = process.argv.slice(2);
const send = (message: object) => new Promise<void>((resolve, reject) => {
  process.stdout.write(provisionFrame(message), error => error ? reject(error) : resolve());
});

/** The detached launcher owns the same fence as its Git child. It never
 * waits on, or writes unbounded output to, the Viewer. */
async function addCheckout(): Promise<void> {
  const [until, repoDir, ...add] = args.slice(1);
  const remaining = Math.min(60_000, Number(until) - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0 || !repoDir || !path.isAbsolute(repoDir)
    || add[0] !== "worktree" || add[1] !== "add") throw new Error("invalid checkout launcher request");
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const child = spawn("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...add], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe", 3],
  });
  const stop = () => process.kill(-process.pid, "SIGKILL");
  let bytes = 0;
  const forward = (destination: NodeJS.WriteStream, chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { stop(); return; }
    if (!destination.destroyed) destination.write(chunk);
  };
  child.stdout?.on("data", chunk => forward(process.stdout, chunk));
  child.stderr?.on("data", chunk => forward(process.stderr, chunk));
  const clock = setTimeout(stop, remaining);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) { stop(); return; }
        resolve(code ?? 1);
      });
    });
  } finally { clearTimeout(clock); }
}

async function prepare(): Promise<void> {
  const frames = provisionFrames(process.stdin);
  await send({ type: "ready", version: 1, pid: process.pid });
  const start = (await frames.next()).value;
  if (!start || start.type !== "start" || typeof start.token !== "string" || !/^[a-f0-9-]{36}$/.test(start.token)
    || typeof start.repository !== "string" || typeof start.checkout !== "string"
    || !path.isAbsolute(start.repository) || !path.isAbsolute(start.checkout)
    || typeof start.budgetMs !== "number" || !Number.isFinite(start.budgetMs) || start.budgetMs <= 0 || start.budgetMs > 180_000) {
    throw new Error("invalid provisioning worker start");
  }
  const { token, repository, checkout, budgetMs } = start;
  let sequence = 0;
  const request = async (type: string, body: object = {}) => {
    const seq = ++sequence;
    await send({ type, token, seq, ...body });
    const response = (await frames.next()).value;
    if (!response || response.type !== "go" || response.token !== token || response.seq !== seq) {
      throw new Error("provisioning worker permit revoked");
    }
    return response;
  };
  const exec: ExecPort = async (command, argv, cwd, env, options) => {
    if (command === "git" && argv.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
      const metadata = await request("readCommonDir", { owner: cwd === repository && cwd !== checkout });
      return { code: typeof metadata.code === "number" ? metadata.code : null, stdout: typeof metadata.value === "string" ? metadata.value : "", stderr: "" };
    }
    if (command === "git" && argv.join(" ") === "check-ignore --quiet node_modules") {
      const metadata = await request("checkIgnoredModules");
      return { code: typeof metadata.code === "number" ? metadata.code : null, stdout: "", stderr: "" };
    }
    return containedDependencyExec(command === "bun" ? process.execPath : command, argv, cwd, env, options);
  };
  const completed = await prepareLockedDependencies(checkout, {
    exec, repository, budgetMs,
    payloadExec: async (...context) => {
      const result = await containedDependencyExec(...context);
      if (result.code === 0) await request("payloadScanComplete");
      return result;
    },
    onStep: async step => { await request("step", { step }); },
    beforeEffect: async effect => {
      await recordProvisionFixtureEvent("dependency-effect", { effect });
      await request("dispatch", { effect });
    },
    onWriterWait: async identity => { await request("cacheBusy", { identity }); },
    onWriterAcquired: async fence => { await request("cacheAcquired", { fence }); },
  });
  if (!completed && path.resolve(repository) !== path.resolve(checkout)) {
    const present = async (file: string) => fs.lstat(file).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (await present(path.join(checkout, "package.json")) || await present(path.join(repository, "node_modules"))) {
      const ignored = await exec("git", ["check-ignore", "--quiet", "node_modules/"], checkout);
      if (ignored.code !== 1) {
        await request("step", { step: "installingPrivateDependencies" });
        const prepared = ignored.code === 0 && await preparePrivateDependencies(repository, checkout, token,
          validPrivateReceipt(start.privateReceipt) ? start.privateReceipt : undefined,
          validPrivateIntent(start.privateIntent) ? start.privateIntent : undefined, budgetMs, {
            beforeEffect: async effect => { await request("dispatch", { effect }); },
            uncertain: async observation => { await request("legacyWriter", { observation }); throw new Error("legacy installer observation accepted"); },
            receipt: async receipt => { await request("privateReceipt", { receipt }); },
            intent: async intent => { await request("privateIntent", { intent }); },
          });
        if (!prepared) {
          await send({ type: "result", token, seq: ++sequence, outcome: "private-install-unverified" });
          return;
        }
      }
    }
  }
  await send({ type: "result", token, seq: ++sequence, outcome: "verified" });
  await frames.return(undefined);
}

try {
  if (args[0] === "add") await addCheckout();
  else if (args[0] === "prepare") await prepare();
  else if (args[0] === "probe-install-binding") process.exitCode = restrictInstallWrites([3]) ? 0 : 1;
  else if (args[0] === "install-bound") {
    if (!restrictInstallWrites([3, 4])) process.exitCode = 77;
    else {
      const child = spawn(process.execPath, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"],
        { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] });
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => resolve(code ?? 1));
      });
    }
  }
} catch {
  process.exitCode = 1;
}
