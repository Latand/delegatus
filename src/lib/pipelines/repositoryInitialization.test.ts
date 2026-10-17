import { afterAll, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { defaultPipelinePorts, harness, createPipelineFromRequest, tickPipelines, loadPipelines, savePipelines, RUN_STAGES, finishReported, entry } from "./engine.fixture";
import { canonicalProject } from "@/lib/projects/aliases";
import { directoryProjectId, localRepositoryProjectId } from "@/lib/projects/identity";
import { projectForCwd } from "@/lib/scanner/describe";
import { globalCache } from "@/lib/scanner/caches";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { clearPipelinePreflightCache } from "./preflight";
import { realProvisionExec } from "./git";
import { realExec } from "@/lib/workflows/provision";
import { POST as preflight } from "@/app/api/pipelines/preflight/route";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-init-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
function folder() {
  const dir = path.join(root, String(++serial));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "readme.txt"), "Project baseline\n");
  return dir;
}
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const admit = (dir: string) => defaultPipelinePorts().preflightRepo(dir);
function ports() {
  const h = harness();
  h.ports.preflightRepo = defaultPipelinePorts().preflightRepo;
  h.ports.projectForCwd = dir => projectForCwd(dir);
  h.ports.exec = realExec;
  h.ports.provisionExec = realProvisionExec;
  return h;
}

test("A: board eligibility is read-only; creation initializes main and reports its safe baseline", async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, ".gitignore"), "custom-output/\n");
  for (const name of [".env", ".env.example", "private.key", "credentials.json", ".npmrc", ".gitconfig", "auth.json", "private.ppk"]) fs.writeFileSync(path.join(dir, name), "private fixture\n");
  fs.mkdirSync(path.join(dir, ".docker"));
  fs.writeFileSync(path.join(dir, ".docker", "config.json"), JSON.stringify({ auths: { registry: { auth: "fixture-value" } } }));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "dependency.js"), "dependency\n");
  const response = await preflight(new NextRequest("http://localhost/api/pipelines/preflight", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ repoDir: dir }) }));
  expect(response.status).toBe(200);
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  const h = ports();
  const result = await createPipelineFromRequest({ task: "Initialize project", repoDir: dir, stages: RUN_STAGES as never }, h.ports);
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.state).toBe("provisioning");
  expect(git(dir, "branch", "--show-current")).toBe("main");
  expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(dir, "show", "-s", "--format=%an|%cn")).toBe("Delegatus|Delegatus");
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", "readme.txt"]);
  expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toStartWith("custom-output/\n");
  expect(JSON.stringify(result)).toContain("committedFiles");
  const reports = readBridgeReportLog().reports.filter(report => report.project === result.pipeline!.project);
  expect(JSON.stringify(reports)).toContain("readme.txt");
  expect(JSON.stringify(reports)).toContain(".env");
});

test("B: refuses home and state roots with a reason and without modifying their files", async () => {
  for (const dir of [os.homedir(), process.env.LLV_STATE_DIR!]) {
    const result = await admit(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/home|state/i);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  }
});

test("B: refuses a candidate over the configured file-count bound before creating git or ignore files", async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "second.txt"), "second\n");
  const previous = process.env.LLV_PIPELINE_INIT_MAX_FILES;
  process.env.LLV_PIPELINE_INIT_MAX_FILES = "1";
  try {
    const result = await admit(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("file");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_INIT_MAX_FILES;
    else process.env.LLV_PIPELINE_INIT_MAX_FILES = previous;
  }
});

test("B: content secrets, nested ignore overrides, links and large files never enter the commit or answer", async () => {
  const dir = folder();
  const secret = ["gh", "p_", "a".repeat(36)].join("");
  fs.writeFileSync(path.join(dir, "ordinary.txt"), "a".repeat(16_000) + "token" + "\n".repeat(16_000));
  fs.writeFileSync(path.join(dir, "innocent.txt"), secret);
  const escaped = [...secret].map(char => String.fromCharCode(92) + "u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  fs.writeFileSync(path.join(dir, "escaped.txt"), escaped);
  fs.writeFileSync(path.join(dir, "encoded.txt"), Buffer.from(secret, "utf16le"));
  fs.writeFileSync(path.join(dir, "encoded-be.txt"), Buffer.from(secret, "utf16le").swap16());
  fs.writeFileSync(path.join(dir, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), "!.env\n!innocent.txt\n!large.bin\n");
  fs.writeFileSync(path.join(dir, "nested", "innocent.txt"), secret);
  fs.writeFileSync(path.join(dir, "nested", "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(dir, "nested", ".env"), secret);
  fs.symlinkSync(path.join(dir, "readme.txt"), path.join(dir, "link.txt"));
  const result = await admit(dir);
  expect(result.ok).toBe(true);
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("innocent.txt");
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/large|link|encoded|escaped|\.env/);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(git(dir, "status", "--porcelain")).toBe("");
  git(dir, "add", "--all");
  expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
});


test("B: standard connection URLs and PGP private key armor are ignored from the first commit", async () => {
  const dir = folder();
  const password = "fixture-" + "p".repeat(48);
  const keyBody = "private-material-" + "k".repeat(48);
  const connection = `postgresql://fixture-user:${password}@db.invalid:5432/app`;
  const privateKey = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${keyBody}\n-----END PGP PRIVATE KEY BLOCK-----`;
  fs.writeFileSync(path.join(dir, "settings.toml"), `database_url = "${connection}"\n`);
  fs.writeFileSync(path.join(dir, "backup.asc"), privateKey);

  const result = await admit(dir);
  expect(result.ok).toBe(true);
  const committed = git(dir, "ls-tree", "-r", "--name-only", "HEAD");
  expect(committed).toContain("readme.txt");
  expect(committed).not.toMatch(/settings\.toml|backup\.asc/);
  expect(git(dir, "check-ignore", "settings.toml")).toBe("settings.toml");
  expect(git(dir, "check-ignore", "backup.asc")).toBe("backup.asc");
  expect(git(dir, "status", "--porcelain")).toBe("");
  const outward = JSON.stringify({ result, reports: readBridgeReportLog().reports });
  expect(outward).toContain("settings.toml");
  expect(outward).toContain("backup.asc");
  expect(outward).not.toContain(password);
  expect(outward).not.toContain(keyBody);
  expect(execFileSync("git", ["-C", dir, "show", "HEAD:.gitignore"], { encoding: "utf8" })).not.toContain(password);
  expect(fs.readFileSync(path.join(dir, "settings.toml"), "utf8")).toContain(password);
});

test("P1: common INI, YAML and htpasswd credentials stay excluded from the initial and later index", async () => {
  const dir = folder();
  const valueOne = "fixture-value-" + "a".repeat(36);
  const valueTwo = "fixture-value-" + "b".repeat(36);
  const awsField = ["aws", "secret", "access", "key"].join("_");
  const passField = ["pa", "ss"].join("");
  fs.writeFileSync(path.join(dir, "storage.ini"), `${awsField} = ${valueOne}\n`);
  fs.writeFileSync(path.join(dir, "database.yml"), `database:\n  ${passField}: ${valueTwo}\n`);
  fs.writeFileSync(path.join(dir, ".htpasswd"), "fixture-user:fixture-hash\n");

  const result = await admit(dir);
  expect(result.ok).toBe(true);
  const committed = git(dir, "ls-tree", "-r", "--name-only", "HEAD");
  expect(committed).toContain("readme.txt");
  expect(committed).not.toMatch(/storage\.ini|database\.yml|\.htpasswd/);
  expect(git(dir, "check-ignore", "storage.ini")).toBe("storage.ini");
  expect(git(dir, "check-ignore", "database.yml")).toBe("database.yml");
  expect(git(dir, "check-ignore", ".htpasswd")).toBe(".htpasswd");
  const outward = JSON.stringify({ result, reports: readBridgeReportLog().reports });
  expect(outward).toContain("storage.ini");
  expect(outward).toContain("database.yml");
  expect(outward).toContain(".htpasswd");
  expect(outward).not.toContain(valueOne);
  expect(outward).not.toContain(valueTwo);
  expect(outward).not.toContain("fixture-user:fixture-hash");
  expect(git(dir, "show", "HEAD:.gitignore")).not.toContain(valueOne);
  expect(git(dir, "show", "HEAD:.gitignore")).not.toContain(valueTwo);

  git(dir, "add", "--all");
  expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
});

test.each(["initializer", "board", "creation"])("B: inherited Git discovery overrides cannot hide an enclosing repository: %s", async surface => {
  const parent = folder();
  git(parent, "init", "-b", "main", "--template=");
  const child = path.join(parent, "child");
  fs.mkdirSync(child);
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = parent;
  try {
    if (surface === "initializer") {
      expect(await admit(child)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("existing repository's working tree") });
    } else if (surface === "board") {
      const response = await preflight(new NextRequest("http://localhost/api/pipelines/preflight", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ repoDir: child }) }));
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).toContain("existing repository's working tree");
    } else {
      const h = ports();
      const result = await createPipelineFromRequest({ task: "Refuse hidden nested project", repoDir: child, stages: RUN_STAGES as never }, h.ports);
      expect(result.status).toBe(403);
      expect(result.error).toContain("existing repository's working tree");
      expect(result.pipeline).toBeUndefined();
    }
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
  expect(fs.existsSync(path.join(child, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(child, ".gitignore"))).toBe(false);
  expect(fs.existsSync(path.join(parent, ".gitignore"))).toBe(false);
});

test("P2: repeated board preflight reuses the successful existing-repository Git probes", async () => {
  const dir = folder();
  git(dir, "init", "-b", "main", "--template=");
  const bin = path.join(root, "git-probe-bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "git-probe-count");
  const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" rev-parse "*) printf x >> '${log}' ;; esac\nexec '${actualGit}' "$@"\n`, { mode: 0o755 });
  clearPipelinePreflightCache();
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previous ?? "");
  try {
    for (let i = 0; i < 2; i++) {
      const response = await preflight(new NextRequest("http://localhost/api/pipelines/preflight", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ repoDir: dir }) }));
      expect(response.status).toBe(200);
    }
    expect(fs.readFileSync(log, "utf8")).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    clearPipelinePreflightCache();
  }
});

test.each(["initializer", "board", "creation"])("B: a subfolder of an existing working tree is refused with a reason: %s", async surface => {
  const dir = folder();
  git(dir, "init", "-b", "main", "--template=");
  const nested = path.join(dir, "nested");
  fs.mkdirSync(nested);
  if (surface === "initializer") {
    expect(await admit(nested)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("existing repository's working tree") });
  } else if (surface === "board") {
    const response = await preflight(new NextRequest("http://localhost/api/pipelines/preflight", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ repoDir: nested }) }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("existing repository's working tree");
  } else {
    const h = ports();
    const result = await createPipelineFromRequest({ task: "Refuse nested project", repoDir: nested, stages: RUN_STAGES as never }, h.ports);
    expect(result.status).toBe(403);
    expect(result.error).toContain("existing repository's working tree");
    expect(result.pipeline).toBeUndefined();
  }
  expect(fs.existsSync(path.join(nested, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(nested, ".gitignore"))).toBe(false);
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test("C: initialization records the directory-to-local-repository succession immediately", async () => {
  const dir = folder();
  const before = directoryProjectId(dir);
  expect(projectForCwd(dir)).toBe(before);
  expect((await admit(dir)).ok).toBe(true);
  globalCache("project-info-cwd-v2").clear();
  const after = localRepositoryProjectId(dir)!;
  expect(canonicalProject(before)).toBe(after);
  expect(projectForCwd(dir)).toBe(after);
});

test("D: a new local repository provisions and completes its branch with no remote or PR", async () => {
  const dir = folder();
  const h = ports();
  h.ports.exec = (command, args, ...rest) => {
    expect(command).not.toBe("gh");
    expect(args).not.toContain("push");
    expect(args).not.toContain("fetch");
    return realExec(command, args, ...rest);
  };
  h.ports.provisionExec = (command, args, ...rest) => {
    expect(command).not.toBe("gh");
    expect(args).not.toContain("push");
    expect(args).not.toContain("fetch");
    return realProvisionExec(command, args, ...rest);
  };
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Local pipeline", repoDir: dir, stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] }, h.ports);
  expect(result.error).toBeUndefined();
  expect(result.pipeline?.delivery?.target.remote).toBe("");
  expect(result.pipeline?.delivery?.target.pr).toBeUndefined();
  expect(git(dir, "remote")).toBe("");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]?.state).toBe("running");
  expect(fs.existsSync(path.join(loadPipelines()[0]!.worktreeDir, ".git"))).toBe(true);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  const finished = finishReported(h, attempt.agentPath!, "pass", "Local work complete");
  await tickPipelines([finished], h.ports);
  for (let i = 0; i < 5 && loadPipelines()[0]?.state !== "completed"; i++) await tickPipelines([entry(attempt.agentPath!)], h.ports);
  expect(loadPipelines()[0]?.state).toBe("completed");
  expect(git(dir, "show-ref", "--verify", "refs/heads/" + lane.branch)).toContain(git(dir, "rev-parse", "HEAD"));
  expect(git(dir, "remote")).toBe("");
});

test("A: an empty folder receives its baseline ignore file and one commit", async () => {
  const dir = folder();
  fs.unlinkSync(path.join(dir, "readme.txt"));
  expect((await admit(dir)).ok).toBe(true);
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toBe(".gitignore");
});

test("A: existing ignore rules and executable files survive initialization", async () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, ".gitignore"), "custom-output/\n");
  fs.mkdirSync(path.join(dir, "custom-output"));
  fs.writeFileSync(path.join(dir, "custom-output", "result.txt"), "generated\n");
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\r\nexit 0\r\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, ".gitattributes"), "run.sh text eol=lf\n");
  fs.writeFileSync(path.join(dir, ":(glob)**"), "literal path\n");
  expect((await admit(dir)).ok).toBe(true);
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("result.txt");
  expect(git(dir, "ls-tree", "HEAD", "run.sh")).toStartWith("100755");
  expect(execFileSync("git", ["-C", dir, "show", "HEAD:run.sh"])).toEqual(fs.readFileSync(path.join(dir, "run.sh")));
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toContain(":(glob)**");
  expect(fs.readFileSync(path.join(dir, "custom-output", "result.txt"), "utf8")).toBe("generated\n");
});

test("B: byte-bound refusal is unchanged after a real process restart", async () => {
  const dir = folder();
  const previous = process.env.LLV_PIPELINE_INIT_MAX_BYTES;
  process.env.LLV_PIPELINE_INIT_MAX_BYTES = "1";
  try {
    const result = await admit(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("size bound");
    const child = Bun.spawn([process.execPath, "-e", 'const {defaultPipelinePorts}=await import("./src/lib/pipelines/engine"); console.log(JSON.stringify(await defaultPipelinePorts().preflightRepo(process.argv[1])));', dir], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("size bound") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_INIT_MAX_BYTES;
    else process.env.LLV_PIPELINE_INIT_MAX_BYTES = previous;
  }
});

test("B: a symlink to state and existing foreign Git metadata are refused", async () => {
  const linked = path.join(root, "state-link");
  fs.symlinkSync(process.env.LLV_STATE_DIR!, linked, "dir");
  const result = await admit(linked);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.detail).toContain("state directory");
  const dir = folder();
  fs.writeFileSync(path.join(dir, ".git"), "foreign metadata\n");
  expect((await admit(dir)).ok).toBe(false);
  expect(fs.readFileSync(path.join(dir, ".git"), "utf8")).toBe("foreign metadata\n");
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test("B: inherited author, hooks and templates cannot affect the baseline commit", async () => {
  const dir = folder();
  const foreign = folder();
  const hooks = path.join(foreign, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
  const settings = { GIT_AUTHOR_NAME: "Foreign fixture", GIT_COMMITTER_NAME: "Foreign fixture", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks, GIT_TEMPLATE_DIR: foreign };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    expect((await admit(dir)).ok).toBe(true);
    expect(git(dir, "show", "-s", "--format=%an|%cn")).toBe("Delegatus|Delegatus");
    expect(fs.readFileSync(path.join(hooks, "pre-commit"), "utf8")).toContain("exit 77");
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("A/C: concurrent creators and a restarted process reuse the one initial commit and report", async () => {
  const dir = folder();
  const results = await Promise.all([admit(dir), admit(dir)]);
  expect(results.every(result => result.ok)).toBe(true);
  const head = git(dir, "rev-parse", "HEAD");
  const child = Bun.spawn([process.execPath, "-e", 'const {defaultPipelinePorts}=await import("./src/lib/pipelines/engine"); console.log(JSON.stringify(await defaultPipelinePorts().preflightRepo(process.argv[1])));', dir], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ ok: true, repositoryInitialization: { commit: head } });
  expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  expect(readBridgeReportLog().reports.filter(report => report.project === localRepositoryProjectId(dir))).toHaveLength(1);
});

test("C: fresh succession and receipt replay yield at the contended write boundary", async () => {
  expect((await admit(folder())).ok).toBe(true);
  for (const replay of [false, true]) {
    const dir = folder();
    if (replay) expect((await admit(dir)).ok).toBe(true);
    const database = path.join(process.env.LLV_STATE_DIR!, "state.sqlite");
    const ready = path.join(dir, "peer-ready");
    const release = path.join(dir, "peer-release");
    const waitLogs: string[] = [];
    resetBlockingWaitsForTests(line => waitLogs.push(line));
    const peer = Bun.spawn([process.execPath, "src/lib/state/lockWait.fixture.ts", "hold", database, ready, release, "manual"], { env: process.env, stdout: "ignore", stderr: "pipe" });
    let pending: Promise<Awaited<ReturnType<typeof admit>>> | undefined;
    try {
      const deadline = performance.now() + 10_000;
      while (!fs.existsSync(ready)) {
        if (peer.exitCode !== null) throw new Error(await new Response(peer.stderr).text());
        if (performance.now() > deadline) throw new Error("peer lock readiness deadline");
        await Bun.sleep(2);
      }
      let settled = false;
      let outcome = "pending";
      const operation = Promise.resolve(admit(dir));
      pending = operation;
      operation.then(result => { settled = true; outcome = result.ok ? "ok" : result.code; }, () => { settled = true; outcome = "rejected"; });
      while (!waitLogs.some(line => {
        const entry = JSON.parse(line.replace(/^\[blocking-wait\] /, ""));
        return entry.site === "state-write-lock" && entry.stateWait?.outcome === "waiting" && /state\.lease\.sqlite|pipelines\.repository-initialization/.test(entry.stateWait.callSite);
      })) {
        if (settled) throw new Error(`initialization settled before the contended state-write boundary (${outcome})`);
        if (performance.now() > deadline) throw new Error("initialization never reached its contended state-write boundary");
        await Bun.sleep(2);
      }
      expect(settled).toBe(false);
      if (!replay) expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      try {
        const heartbeatDeadline = performance.now() + 2_000;
        while (ticks < 3 && performance.now() < heartbeatDeadline) await Bun.sleep(2);
        expect(ticks).toBeGreaterThanOrEqual(3);
        expect(fs.existsSync(release)).toBe(false);
      } finally { clearInterval(timer); }
      fs.writeFileSync(release, "release");
      expect((await operation).ok).toBe(true);
      expect(await peer.exited).toBe(0);

      // Negative control: a synchronous SQLite writer on this same state DB
      // must stall its own event loop while the peer holds the database lock.
      const controlReady = path.join(dir, "sync-ready");
      const controlGo = path.join(dir, "sync-go");
      const controlBlocked = path.join(dir, "sync-blocked");
      const controlRelease = path.join(dir, "sync-release");
      const holderReady = path.join(dir, "control-peer-ready");
      const holder = Bun.spawn([process.execPath, "src/lib/state/lockWait.fixture.ts", "hold", database, holderReady, controlRelease, "manual"], { env: process.env, stdout: "ignore", stderr: "pipe" });
      const control = Bun.spawn([process.execPath, "src/lib/state/lockWait.fixture.ts", "sync-probe", database, controlReady, controlGo, "500", controlBlocked], { env: process.env, stdout: "pipe", stderr: "pipe" });
      try {
        const controlDeadline = performance.now() + 10_000;
        while (!fs.existsSync(holderReady) || !fs.existsSync(controlReady)) {
          if (holder.exitCode !== null || control.exitCode !== null) throw new Error("synchronous-writer control exited before lock contention");
          if (performance.now() > controlDeadline) throw new Error("synchronous-writer control readiness deadline");
          await Bun.sleep(2);
        }
        fs.writeFileSync(controlGo, "go");
        const attemptDeadline = performance.now() + 10_000;
        while (!fs.existsSync(controlBlocked)) {
          if (control.exitCode !== null) throw new Error("synchronous writer exited before confirming SQLite lock contention");
          if (performance.now() > attemptDeadline) throw new Error("synchronous writer did not confirm SQLite lock contention");
          await Bun.sleep(2);
        }
        // The marker is written only after BEGIN IMMEDIATE timed out on the
        // held lock, so scheduling before the SQLite attempt cannot release it.
        fs.writeFileSync(controlRelease, "release");
        const output = await new Response(control.stdout).text();
        expect(await control.exited).toBe(0);
        expect(JSON.parse(output)).toMatchObject({ blocked: true });
        expect(JSON.parse(output).maxGap).toBeGreaterThan(200);
        expect(await holder.exited).toBe(0);
      } finally {
        if (control.exitCode === null) { control.kill("SIGKILL"); await control.exited; }
        if (holder.exitCode === null) { holder.kill("SIGKILL"); await holder.exited; }
      }
    } finally {
      if (pending && !fs.existsSync(release)) fs.writeFileSync(release, "release");
      if (peer.exitCode === null) { peer.kill("SIGKILL"); await peer.exited; }
      resetBlockingWaitsForTests();
    }
  }
}, 20_000);

test("B: existing linked worktrees retain their repository and receive no initialization receipt", async () => {
  const dir = folder();
  expect((await admit(dir)).ok).toBe(true);
  const linked = path.join(root, "existing-linked-worktree");
  git(dir, "worktree", "add", "-b", "linked", linked);
  const result = await admit(linked);
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain("repositoryInitialization");
  expect(git(linked, "branch", "--show-current")).toBe("linked");
});

test("B: a file changed after its snapshot is refused before installation", async () => {
  const dir = folder();
  const target = path.join(dir, "readme.txt");
  const original = fsAsync.open.bind(fsAsync);
  let changed = false;
  const hook = spyOn(fsAsync, "open").mockImplementation(async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] === target && !changed) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); changed = true; fs.writeFileSync(target, "changed after inspection\n"); };
    }
    return handle;
  });
  try {
    const result = await admit(dir);
    expect(changed).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("changed") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("changed after inspection\n");
  } finally { hook.mockRestore(); }
});

test.skipIf(process.platform !== "linux")("B: swapping the project for a state symlink during install never writes into state", async () => {
  const dir = folder();
  const moved = dir + "-moved";
  const original = fsAsync.writeFile.bind(fsAsync);
  let movedRoot = false;
  const hook = spyOn(fsAsync, "writeFile").mockImplementation(async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    const name = String(args[0]);
    if (!movedRoot && name.startsWith("/proc/self/fd/") && name.endsWith("/.gitignore")) {
      fs.renameSync(dir, moved);
      fs.symlinkSync(process.env.LLV_STATE_DIR!, dir, "dir");
      movedRoot = true;
    }
    return result;
  });
  try {
    const result = await admit(dir);
    expect(movedRoot).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "initialization_refused" });
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(moved, ".git"))).toBe(false);
  } finally { hook.mockRestore(); }
});

test("B: a secret-bearing filename never enters generated ignore rules or a response", async () => {
  const dir = folder();
  const value = ["gh", "p_", "b".repeat(36)].join("");
  fs.writeFileSync(path.join(dir, value + ".txt"), "fixture\n");
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused" });
  expect(JSON.stringify(result)).not.toContain(value);
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test.each(["link", "encoding", "secret"] as const)("B: an unsafe existing gitignore is preserved: %s", async kind => {
  const dir = folder();
  const ignore = path.join(dir, ".gitignore");
  const target = path.join(dir, "original.txt");
  fs.writeFileSync(target, "original rules\n");
  const value = ["gh", "p_", "c".repeat(36)].join("");
  if (kind === "link") fs.symlinkSync(target, ignore);
  else fs.writeFileSync(ignore, kind === "encoding" ? Buffer.from("rules\n", "utf16le") : value);
  const before = fs.readFileSync(ignore);
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused" });
  expect(fs.readFileSync(ignore)).toEqual(before);
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(JSON.stringify(result)).not.toContain(value);
});

test.each(["0", "invalid", "1.5"])("B: invalid initialization bounds are refused: %s", async value => {
  const dir = folder();
  const previous = process.env.LLV_PIPELINE_INIT_MAX_FILES;
  process.env.LLV_PIPELINE_INIT_MAX_FILES = value;
  try {
    expect(await admit(dir)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("limit") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_PIPELINE_INIT_MAX_FILES; else process.env.LLV_PIPELINE_INIT_MAX_FILES = previous;
  }
});

test("B: an oversized path inventory is refused before any project mutation", async () => {
  const dir = folder();
  for (let index = 0; index < 20; index++) fs.writeFileSync(path.join(dir, String(index).padStart(2, "0") + "a".repeat(220)), "fixture\n");
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("path-list bound") });
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
});

test.each(["LLV_PIPELINE_INIT_MAX_FILES", "LLV_PIPELINE_INIT_MAX_BYTES", "LLV_PIPELINE_INIT_MAX_FILE_BYTES"] as const)("B: generated ignore data also counts toward %s", async name => {
  const dir = folder();
  const previous = process.env[name];
  process.env[name] = name.endsWith("FILES") ? "1" : String(fs.statSync(path.join(dir, "readme.txt")).size);
  try {
    expect(await admit(dir)).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("bound") });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test("B: nested negations cannot re-admit excluded files on a later git add", async () => {
  const dir = folder();
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), "!private.txt\n!large.bin\n");
  fs.writeFileSync(path.join(dir, "nested", "private.txt"), ["gh", "p_", "d".repeat(36)].join(""));
  fs.writeFileSync(path.join(dir, "nested", "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  expect((await admit(dir)).ok).toBe(true);
  git(dir, "add", "--all");
  expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
});

test.each(["secret", "large", "ignored"])("B: an unmergeable nested gitignore refuses initialization: %s", async kind => {
  const dir = folder();
  fs.mkdirSync(path.join(dir, "nested"));
  const privateFixture = ["gh", "p_", "e".repeat(36)].join("");
  const contents = kind === "secret" ? privateFixture : kind === "large" ? "#".repeat(2 * 1024 * 1024 + 1) : "!private.txt\n";
  fs.writeFileSync(path.join(dir, "nested", ".gitignore"), contents);
  if (kind === "ignored") fs.writeFileSync(path.join(dir, ".gitignore"), "nested/.gitignore\n");
  const result = await admit(dir);
  expect(result).toMatchObject({ ok: false, code: "initialization_refused", detail: expect.stringContaining("gitignore") });
  expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  expect(fs.readFileSync(path.join(dir, "nested", ".gitignore"), "utf8")).toBe(contents);
});
