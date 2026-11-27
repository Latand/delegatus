import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as serveHttp } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { processIdentityStatus } from "../src/lib/processIdentity.ts";

const run = promisify(execFile);
const workerPath = ".next/server/provision-toolchain-worker.js";

/** The fixture itself owns this tree, including immutable cache directories. */
export async function removeProvisioningFixture(root) {
  const unseal = async directory => {
    const info = await lstat(directory).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isDirectory()) return;
    await chmod(directory, info.mode | 0o700).catch(error => {
      if (error.code === "ENOENT") return;
      throw error;
    });
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      if (child.isDirectory()) await unseal(path.join(directory, child.name));
    }
  };
  await unseal(root);
  await rm(root, { recursive: true, force: true });
}

export async function provisioningFixtureEnvironment(sandbox, env) {
  const home = path.join(sandbox, "fixture-codex");
  const binary = path.join(sandbox, "fixture-bin", "codex");
  const supervisor = path.join(sandbox, "provision-supervisor");
  await mkdir(home, { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(supervisor, { recursive: true, mode: 0o700 });
  await chmod(supervisor, 0o700);
  // The admission read checks file presence. The fixture has no provider credentials.
  await writeFile(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  return { ...env, LLV_CODEX_HOME: home, LLV_CODEX_BINARY: binary, LLV_PROVISION_FIXTURE_SUPERVISOR: supervisor,
    PATH: [path.dirname(binary), env.PATH].filter(Boolean).join(path.delimiter) };
}

/** @param {() => void | Promise<void>} [beforePackageResponse] */
export async function seedProvisioningPackage(checkout, sandbox, env, bun, beforePackageResponse, packageName = "delegatus-cli") {
  const directory = await mkdtemp(path.join(sandbox, "provision-package-"));
  await mkdir(path.join(directory, "package"));
  await writeFile(path.join(directory, "package", "package.json"), '{"name":"provision-fixture-dependency","version":"1.0.0"}\n');
  const archive = path.join(directory, "package.tgz");
  await run("tar", ["-czf", archive, "-C", directory, "package"], { env, timeout: 5_000 });
  const bytes = await readFile(archive);
  const server = serveHttp((request, response) => {
    if (request.url !== "/package.tgz") { response.writeHead(404); response.end(); return; }
    void Promise.resolve(beforePackageResponse?.()).then(() => {
      response.writeHead(200, { "content-type": "application/gzip", "content-length": bytes.length });
      response.end(bytes);
    }, error => response.destroy(error));
  });
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const manifest = { name: packageName, dependencies: { "provision-fixture-dependency": `http://127.0.0.1:${server.address().port}/package.tgz` } };
    await writeFile(path.join(checkout, "package.json"), JSON.stringify(manifest) + "\n");
    await writeFile(path.join(checkout, ".gitignore"), "node_modules\n", { flag: "a" });
    await run(bun, ["--no-env-file", "install", "--lockfile-only", "--ignore-scripts"], { cwd: checkout, env, timeout: 8_000 });
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}

export async function verifyProvisioningTrace(root) {
  const trace = path.join(root, ".next/server/app/api/pipelines/route.js.nft.json");
  const { files } = JSON.parse(await readFile(trace, "utf8"));
  const bundle = path.join(root, workerPath);
  if (!files.some(file => path.resolve(path.dirname(trace), file) === bundle)) throw new Error("pipeline route trace omits its provisioning worker");
  await realpath(bundle);
}

async function withProvisioningRepository(sandbox, env, runLane) {
  const repository = await mkdtemp(path.join(sandbox, "provision-fixture-"));
  const remote = path.join(repository, "remote.git");
  const checkout = path.join(repository, "source");
  await mkdir(checkout);
  const options = { env, timeout: 5_000 };
  const git = async (cwd, ...args) => (await run("git", args, { ...options, cwd })).stdout.trim();
  await git(repository, "init", "--bare", "--initial-branch=main", remote);
  await git(checkout, "init", "--initial-branch=main");
  const close = await seedProvisioningPackage(checkout, sandbox, env, env.LLV_BUN_EXECUTABLE || process.execPath);
  try { return await runLane(checkout, remote, git); }
  finally { await close(); await removeProvisioningFixture(repository); }
}

export async function verifyProvisioningRelease(origin, sandbox, env) {
  const baseline = await withProvisioningRepository(sandbox, env,
    (checkout, remote, git) => verifyFixtureLane(origin, checkout, remote, git, env));
  const heldReplies = [];
  for (const reply of ["check-ignore", "cache-permit"]) {
    const root = env.LLV_PROVISION_FIXTURE_SUPERVISOR;
    if (!root) throw new Error("release fixture has no private supervisor directory");
    for (const name of ["entered", "hold", "interrupt", "release"]) {
      await rm(path.join(root, `${name}-${reply}`), { force: true });
    }
    await rm(path.join(root, "events.ndjson"), { force: true });
    await writeFile(path.join(root, `hold-${reply}`), "", { mode: 0o600 });
    const result = await withProvisioningRepository(sandbox, env,
      (checkout, remote, git) => verifyFixtureLane(origin, checkout, remote, git, env, reply));
    heldReplies.push(result);
  }
  return { ...baseline, heldReplies };
}

export async function verifyFixtureLane(origin, checkout, remote, git, env, holdReply) {
  await git(checkout, "add", ".");
  await git(checkout, "-c", "user.name=Provisioning Fixture", "-c", "user.email=noreply", "commit", "-m", "provisioning fixture");
  await git(checkout, "remote", "add", "origin", remote);
  await git(checkout, "push", "origin", "main");
  const planned = await git(checkout, "rev-parse", "HEAD");
  const page = await fetch(origin, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" },
    signal: AbortSignal.timeout(8_000),
  });
  const cookie = page.headers.getSetCookie().map(value => value.split(";")[0]).find(value => value.startsWith("llv_operator="));
  await page.arrayBuffer();
  if (!cookie) throw new Error("provisioning fixture could not open an operator session");
  const headers = { cookie, origin, "content-type": "application/json", "sec-fetch-site": "same-origin" };
  const created = await fetch(`${origin}/api/pipelines`, {
    method: "POST", headers, signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ task: "Release fixture provisioning", repoDir: checkout, baseRef: planned, publication: "internal", autoStart: false,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", prompt: "Return the fixture verdict.", next: null }] }),
  });
  const accepted = await created.json();
  const laneId = accepted.pipeline?.id;
  if (!created.ok || typeof laneId !== "string") throw new Error(`provisioning fixture creation refused (${created.status})`);
  const started = await fetch(`${origin}/api/pipelines/${encodeURIComponent(laneId)}`, {
    method: "PATCH", headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify({ action: "start" }),
  });
  const startedBody = await started.json();
  if (!started.ok || startedBody.pipeline?.state !== "provisioning") {
    throw new Error(`provisioning fixture draft start refused (${started.status})`);
  }
  const supervisor = holdReply ? env.LLV_PROVISION_FIXTURE_SUPERVISOR : undefined;
  const gateEntry = supervisor && path.join(supervisor, `entered-${holdReply}.json`);
  const interrupt = supervisor && path.join(supervisor, `interrupt-${holdReply}`);
  const release = supervisor && path.join(supervisor, `release-${holdReply}`);
  const eventsFile = supervisor && path.join(supervisor, "events.ndjson");
  const common = holdReply ? await git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir") : "";
  const cacheFence = holdReply ? path.join(common, "delegatus-dependencies", "v4", "owner.lock") : "";
  let faultEntry;
  let interrupted = false;
  let faultVerified = false;
  let waitingForFirstAttempt = false;
  const fixture = holdReply ?? "release";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/pipelines/${encodeURIComponent(laneId)}`, { headers, signal: AbortSignal.timeout(5_000) });
    const lane = (await response.json()).pipeline;
    if (holdReply && !interrupted && await lstat(gateEntry).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) {
      faultEntry = JSON.parse(await readFile(gateEntry, "utf8"));
      const expectedStep = holdReply === "check-ignore" ? "checkingDependencies" : "preparingToolchain";
      if (lane?.provisioningStep?.step !== expectedStep || lane.provisioningStep.status !== "running") {
        throw new Error(`${holdReply} held the worker outside ${expectedStep}`);
      }
      if (holdReply === "check-ignore" && faultEntry.resultCode !== 0) throw new Error("held check-ignore reply was not a successful result");
      if (holdReply === "cache-permit") {
        const info = await lstat(cacheFence, { bigint: true });
        if (`${info.dev}:${info.ino}` !== faultEntry.fenceIdentity) throw new Error("held cache permit changed fence identity");
        if (process.platform === "linux" && await fixtureLockAvailable(cacheFence, env)) {
          throw new Error("cache permit was not held at the post-acquisition barrier");
        }
      }
      await writeFile(interrupt, "");
      interrupted = true;
    }
    if (holdReply && interrupted && !faultVerified
      && lane?.provisioningStep?.status === "waiting" && lane.provisioningStep.reason === "toolchain-reply-lost") {
      if (!faultEntry.worker || processIdentityStatus(faultEntry.worker) !== "dead") {
        const stopAt = Date.now() + 3_000;
        while (Date.now() < stopAt && processIdentityStatus(faultEntry.worker) !== "dead") {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (processIdentityStatus(faultEntry.worker) !== "dead") throw new Error(`${holdReply} worker survived its lost reply`);
      }
      if (process.platform === "linux" && !await fixtureLockAvailable(cacheFence, env)) {
        throw new Error(`${holdReply} worker exit retained the cache fence`);
      }
      const beforeRelease = await readFile(eventsFile, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
      await writeFile(release, "");
      await new Promise(resolve => setTimeout(resolve, 250));
      const afterRelease = await readFile(eventsFile, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
      if (afterRelease !== beforeRelease) throw new Error(`${holdReply} worker wrote effects after its reply was interrupted`);
      faultVerified = true;
    }
    if (lane?.provisioningStep?.status === "parked") {
      throw new Error(`provisioning fixture parked at ${lane.provisioningStep.step} (${lane.provisioningStep.reason ?? "refused"})`);
    }
    if (["toolchain-start-failed", "toolchain-reply-lost"].includes(lane?.provisioningStep?.reason)
      && !(holdReply && faultVerified && lane.provisioningStep.reason === "toolchain-reply-lost")) {
      throw new Error(`provisioning fixture interrupted at ${lane.provisioningStep.step} (${lane.provisioningStep.reason})`);
    }
    const receiptConsumed = lane?.lastPassedCommit === planned && lane.state !== "provisioning" && !lane.provisioningStep;
    const attemptCount = lane?.runs?.[0]?.attempts?.length ?? 0;
    // Provisioning commits the running lane before the controller records its first attempt.
    waitingForFirstAttempt = receiptConsumed && attemptCount === 0 && lane.state === "running" && lane.cursor?.state === "pending";
    if (receiptConsumed && !waitingForFirstAttempt) {
      if (holdReply && !faultVerified) throw new Error(`${holdReply} fixture never verified the held reply transition`);
      if (attemptCount !== 1) {
        const detail = lane.stateDetail ? `: ${lane.stateDetail}` : "";
        throw new Error(`${fixture} fixture observed ${attemptCount} first-stage attempts (expected one, lane ${lane.state})${detail}`);
      }
      if (holdReply) {
        const events = (await readFile(eventsFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        const adds = events.filter(event => event.type === "worktree-add" && event.pipelineId === laneId);
        const installs = events.filter(event => event.type === "dependency-effect" && event.effect === "install-cache");
        if (adds.length !== 1) throw new Error(`${holdReply} fixture dispatched ${adds.length} worktree adds`);
        if (installs.length !== 1) throw new Error(`${holdReply} fixture dispatched ${installs.length} cold installs`);
      }
      if ((await git(lane.worktreeDir, "rev-parse", "HEAD")) !== planned) throw new Error("release fixture checkout has an unexpected HEAD");
      const graph = await realpath(path.join(lane.worktreeDir, "node_modules"));
      const common = await git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const relative = path.relative(common, graph).split(path.sep);
      const key = relative[2];
      if (relative.length !== 4 || relative[0] !== "delegatus-dependencies" || relative[1] !== "v4"
        || !/^[a-f0-9]{64}$/.test(key) || relative[3] !== "node_modules") throw new Error("release fixture has no linked shared graph");
      const receipt = JSON.parse(await readFile(path.join(graph, "..", "installed.json"), "utf8"));
      if (receipt.key !== key) throw new Error("release fixture graph has no matching receipt");
      return { lane: laneId, planned, graph: key, workerEntry: workerPath, ...(holdReply ? { heldReply: holdReply } : {}) };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (waitingForFirstAttempt) {
    throw new Error(`${fixture} fixture consumed its provisioning receipt but no first-stage attempt appeared within 60 s`);
  }
  throw new Error("release fixture did not consume its cold provisioning receipt inside 60 s");
}

async function fixtureLockAvailable(filename, env) {
  const info = await lstat(filename).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return true;
  try {
    await run("flock", ["-n", filename, "true"], { env, timeout: 2_000 });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

export async function serveProvisioningFixture({ root, bun, standalone = false, temporaryRoot = tmpdir() }) {
  const sandbox = await mkdtemp(path.join(temporaryRoot, "provision-release-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = await provisioningFixtureEnvironment(sandbox, {
    PATH: process.env.PATH, HOME: sandbox, TMPDIR: sandbox, XDG_CONFIG_HOME: path.join(sandbox, "config"),
    LLV_STATE_DIR: path.join(sandbox, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    LLV_BUN_EXECUTABLE: bun, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", HOSTNAME: "127.0.0.1", PORT: String(port),
  });
  const child = spawn(bun, standalone ? ["--no-env-file", "server.js"] :
    ["--no-env-file", "--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => {
    child.once("close", resolve);
    child.once("error", resolve);
  });
  let log = "";
  for (const output of [child.stdout, child.stderr]) output.on("data", chunk => { log = (log + String(chunk)).slice(-128_000); });
  try {
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const health = await fetch(`${origin}/api/files`, { signal: AbortSignal.timeout(1_000) });
        await health.arrayBuffer();
        if (health.ok) { ready = true; break; }
      } catch { /* Attempt the same private listener through the startup bound. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("the disposable Viewer did not become ready");
    const evidence = await verifyProvisioningRelease(origin, sandbox, env);
    if (!log.split("\n").some(line => line.includes(`"pipelineId":"${evidence.lane}"`) && line.includes('"phase":"toolchain-ready"'))) {
      throw new Error("the release did not record the provisioning worker ready frame");
    }
    return { ...evidence, runtime: path.basename(bun), readyFrame: true };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const stop = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await exited; } finally { clearTimeout(stop); }
    }
    await removeProvisioningFixture(sandbox);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = process.cwd();
  await verifyProvisioningTrace(root);
  const evidence = await serveProvisioningFixture({ root, bun: process.execPath });
  process.stdout.write(`provisioning-release ${JSON.stringify(evidence)}\n`);
}
