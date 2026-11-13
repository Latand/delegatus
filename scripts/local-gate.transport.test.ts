import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { SUPPORTED_CODEX_VERSIONS } from "../src/lib/accounts/codexVersions";
import { PUBLICATION_TRANSPORT_MS, publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { publishPipelineBranch } from "../src/lib/pipelines/git";
import { pipelineCorpus } from "../src/lib/pipelines/fixtures/corpus";
import { findPipelineRecord, loadPipelines, savePipelines } from "../src/lib/pipelines/store";
import { realExec, type ExecPort } from "../src/lib/workflows/provision";
import { DEFAULT_PUBLICATION_PUSH_MS, PUBLICATION_PACK_MARGIN_MS } from "../src/lib/pipelines/gateBudget";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, nativeFixture, touchedChecks, commitFixtureInputs, httpFixture } = createPublicationFixtures(root, roots);

nativeTest("a first cold native publication completes one check phase before one gated push", async () => {
  const f = nativeFixture(), http = await httpFixture(f, false), previous = loadPipelines();
  try {
    const subject = pipelineCorpus(2, 1)[1]!;
    Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
    subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
      disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
    savePipelines([subject]);
    let pushes = 0;
    const exec: ExecPort = (command, args, cwd, overrides, options) => {
      if (command === "git" && args[0] === "push") {
        pushes++;
        expect(readPublicationCheckReceipt(overrides!.LLV_GATE_PUBLICATION_RECEIPT!, publicationCheckBinding(overrides!)).inputs).toMatch(/^[a-f0-9]{64}$/);
        expect(touchedChecks(f)).toHaveLength(1);
      }
      return realExec(command, args, cwd, { ...f.env, ...overrides }, options);
    };
    expect(await publishPipelineBranch(subject, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, sha: f.head, remote: "published" });
    expect(pushes).toBe(1); expect(http.rpc()).toBe(1); expect(http.rejected()).toBe(0);
    expect(f.calls().filter(call => call.args[0] === "native-install").map(call => call.args[2]))
      .toEqual(SUPPORTED_CODEX_VERSIONS.map(version => `@openai/codex@${version}`));
    expect(touchedChecks(f)).toHaveLength(1);
    expect(spawnSync("git", ["--git-dir", http.bare, "rev-parse", "refs/heads/main"], { env: f.env, encoding: "utf8" }).stdout.trim()).toBe(f.head);
  } finally { savePipelines(previous); http.close(); }
}, 120_000);

test.each(["active", "expired"] as const)("native Git expires its discovered password across checks; the fenced publisher checks before mint and publishes once (%s enclosing deadline)", async (enclosing) => {
  // Red control exercises exactly the old native ordering.
  const red = fixture(), redHttp = await httpFixture(red);
  const enclosingDeadline = process.env.LLV_GATE_PUSH_DEADLINE;
  process.env.LLV_GATE_PUSH_DEADLINE = enclosing === "active" ? String(Date.UTC(2100, 0, 1)) : "1";
  try {
    // realExec merges its overrides over process.env. Explicitly clear the
    // enclosing publication's deadline so this fixture owns its own budget,
    // including when that caller spent longer than its deadline in admission.
    const env = { ...red.env, LLV_GATE_PUBLICATION_RECEIPT: undefined, LLV_GATE_PUSH_DEADLINE: undefined };
    const result = await realExec("git", ["push", redHttp.remote, `${red.head}:refs/heads/main`], red.dir, env, { timeoutMs: 60_000 });
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("401");
    expect(redHttp.events().filter(e => ["mint", "checks"].includes(e.kind)).map(e => e.kind)).toEqual(["mint", "checks"]);
    expect(redHttp.rejected()).toBeGreaterThan(0); expect(redHttp.rpc()).toBe(0);
    expect(spawnSync("git", ["--git-dir", redHttp.bare, "rev-parse", "--verify", "refs/heads/main"], { env: red.env }).status).not.toBe(0);
  } finally {
    if (enclosingDeadline === undefined) delete process.env.LLV_GATE_PUSH_DEADLINE;
    else process.env.LLV_GATE_PUSH_DEADLINE = enclosingDeadline;
    redHttp.close();
  }
  const f = fixture(), http = await httpFixture(f);
  const previous = loadPipelines();
  try {
    const subject = pipelineCorpus(2, 1)[1]!;
    Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
    subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
      disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
    savePipelines([subject]);
    const commands: string[] = [];
    const exec: ExecPort = (command, args, cwd, overrides, options) => {
      commands.push([command, ...args].join(" "));
      return realExec(command, args, cwd, { ...f.env, ...overrides }, options);
    };
    const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
    expect(result).toMatchObject({ ok: true, sha: f.head, remote: "published" });
    expect(http.events().map(event => event.kind)).toEqual(["checks", "mint", "rpc"]);
    expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
    expect(http.rpc()).toBe(1); expect(http.rejected()).toBe(0);
    expect(commands.filter(command => command.startsWith("git push "))).toHaveLength(1);
    expect(findPipelineRecord(subject.id)!.delivery!.operation!.state).toBe("settled");
    expect(await publishPipelineBranch(findPipelineRecord(subject.id)!, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, remote: "published" });
    expect(http.rpc()).toBe(1);
  } finally { savePipelines(previous); http.close(); }
}, 150_000);

for (const capability of ["absent", "unsupported", "malformed"] as const) {
  test(`a gate with ${capability} preparation capability keeps one ordinary gated push`, async () => {
    const f = fixture();
    delete f.env.LLV_GATE_PUBLICATION_RECEIPT;
    const marker = path.join(f.dir, "scripts/local-gate-capabilities.json");
    if (capability === "absent") fs.rmSync(marker);
    else fs.writeFileSync(marker, capability === "unsupported" ? '{"publicationPrepare":2}' : '{');
    // The native entry point retains the ordinary pre-push protocol. In
    // particular, nothing may try its unknown --publication-prepare argument.
    f.git("-c", "core.hooksPath=/dev/null", "add", "scripts/local-gate-capabilities.json", "scripts/local-gate.ts");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "legacy gate capability");
    const http = await httpFixture(f, false), previous = loadPipelines();
    try {
      const subject = pipelineCorpus(2, 1)[1]!;
      Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
      subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
        disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
      savePipelines([subject]);
      let preparations = 0, pushes = 0;
      const exec: ExecPort = (command, args, cwd, env, options) => {
        if (command === "bun" && args.includes("--publication-prepare")) preparations++;
        if (command === "git" && args[0] === "push") {
          pushes++;
          expect(env?.LLV_GATE_PUBLICATION_RECEIPT).toBeUndefined();
        }
        return realExec(command, args, cwd, { ...f.env, ...env }, options);
      };
      expect(await publishPipelineBranch(subject, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, remote: "published" });
      expect(preparations).toBe(0); expect(pushes).toBe(1); expect(http.rpc()).toBe(1);
      expect(http.events().map(event => event.kind)).toEqual(["mint", "checks", "rpc"]);
      expect(spawnSync("git", ["--git-dir", http.bare, "rev-parse", "refs/heads/main"], { env: f.env, encoding: "utf8" }).stdout.trim()).toBe(f.head);
    } finally { savePipelines(previous); http.close(); }
  }, 90_000);
}

for (const scenario of ["slow privacy", "changed input", "capped budget", "over cap"] as const) {
  test(`measured publication transport handles ${scenario}`, async () => {
    const f = fixture();
    // This path is embedded in tracked record.ts and scanned by the real
    // privacy gate, so keep it independent of the checkout's absolute path.
    const clock = ".git/privacy-elapsed";
    const clockFile = path.join(f.dir, clock);
    const preload = path.join(f.dir, ".git", "privacy-clock.ts");
    fs.writeFileSync(clockFile, "0");
    const startedAt = Date.UTC(2030, 0, 1);
    fs.writeFileSync(preload, `import fs from "node:fs"; Date.now = () => ${startedAt} + Number(fs.readFileSync(${JSON.stringify(clockFile)}, "utf8"));`);
    f.env.HOOK_CLOCK = preload;
    f.env.HOOK_PRIVACY = path.join(root, "scripts/privacy-publication-gate.ts");
    fs.copyFileSync(path.join(root, "scripts/privacy-known-value-fingerprints.json"), path.join(f.dir, "scripts/privacy-known-value-fingerprints.json"));
    const preparationMs = ["capped budget", "over cap"].includes(scenario) ? 600_000 : 70_000;
    const transportMs = scenario === "over cap" ? DEFAULT_PUBLICATION_PUSH_MS - PUBLICATION_PACK_MARGIN_MS + 1 : preparationMs;
    // After each real scan, its child advances the shared clock. The over-cap
    // child stays pending until the hook cancels it, keeping the verdict stable.
    fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "scripts/privacy-publication-gate.ts") {
      require("node:child_process").execFileSync(process.execPath, [process.env.HOOK_PRIVACY, ...process.argv.slice(3)], { stdio: "inherit" });
      const fs = require("node:fs"), file = ${JSON.stringify(clock)};
      fs.writeFileSync(file, String(Number(fs.readFileSync(file, "utf8")) + (process.env.LLV_GATE_PUBLICATION_OBSERVED ? ${transportMs} : ${preparationMs})));
      ${scenario === "over cap" ? 'if (process.env.LLV_GATE_PUBLICATION_OBSERVED) await new Promise(() => {});' : ""}
    }\n`);
    commitFixtureInputs(f);
    const http = await httpFixture(f, false), previous = loadPipelines();
    const elapsed = () => Number(fs.readFileSync(clockFile, "utf8"));
    const date = spyOn(Date, "now").mockImplementation(() => startedAt + elapsed());
    const monotonicNow = performance.now.bind(performance);
    const monotonic = spyOn(performance, "now").mockImplementation(() => monotonicNow() + elapsed());
    try {
      const subject = pipelineCorpus(2, 1)[1]!;
      Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
      subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
        disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
      savePipelines([subject]);
      let pushes = 0, transportBudget = 0, hookAllowance = 0;
      const exec: ExecPort = async (command, args, cwd, env, options) => {
        if (command === "git" && args[0] === "push") {
          pushes++;
          transportBudget = options?.timeoutMs ?? 0;
          hookAllowance = Number(env?.LLV_GATE_PUSH_DEADLINE) - Date.now();
          if (scenario === "changed input") fs.appendFileSync(path.join(f.dir, "example.ts"), "// changed after preparation\n");
        }
        return realExec(command, args, cwd, { ...f.env, ...env }, options);
      };
      const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
      if (scenario === "changed input") {
        expect(result).toMatchObject({ ok: false });
        expect(result.ok ? "" : result.error).toContain("publication inputs cannot be certified: dirty worktree");
      } else if (scenario === "over cap") {
        expect(result).toMatchObject({ ok: false, failure: { retryableDeadline: true, hookStoppedCheck: "privacy" } });
      } else {
        expect(result).toMatchObject({ ok: true, sha: f.head, remote: "published" });
        expect(spawnSync("git", ["--git-dir", http.bare, "rev-parse", "refs/heads/main"], { env: f.env, encoding: "utf8" }).stdout.trim()).toBe(f.head);
      }
      expect(transportBudget).toBeGreaterThanOrEqual(Math.min(DEFAULT_PUBLICATION_PUSH_MS, 2 * preparationMs + PUBLICATION_PACK_MARGIN_MS));
      expect(transportBudget).toBeLessThanOrEqual(DEFAULT_PUBLICATION_PUSH_MS);
      if (scenario === "capped budget") expect(transportBudget).toBe(DEFAULT_PUBLICATION_PUSH_MS);
      expect(hookAllowance).toBe(transportBudget - PUBLICATION_PACK_MARGIN_MS);
      expect(pushes).toBe(1);
      expect(http.rpc()).toBe(["slow privacy", "capped budget"].includes(scenario) ? 1 : 0);
      expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
      expect(f.calls().filter(call => call.args[0] === "scripts/privacy-publication-gate.ts")).toHaveLength(scenario === "changed input" ? 1 : 2);
      expect(findPipelineRecord(subject.id)!.delivery!.operation!.state).toBe("settled");
    } finally { monotonic.mockRestore(); date.mockRestore(); savePipelines(previous); http.close(); }
  }, 90_000);
}

test.each([["short preparation", 10_000], ["long preparation", 40_000]] as const)("an overrun after %s ends with its deadline verdict before Git's pack timeout", async (_label, preparationMs) => {
  const f = fixture();
  const clock = path.join(f.dir, ".git", "transport-clock");
  const preload = path.join(f.dir, ".git", "transport-clock.ts");
  const startedAt = Date.now();
  fs.writeFileSync(clock, String(startedAt));
  fs.writeFileSync(preload, `import fs from "node:fs"; Date.now = () => Number(fs.readFileSync(${JSON.stringify(clock)}, "utf8"));`);
  f.env.HOOK_CLOCK = preload;
  // Advance the hook's clock past its deadline during the fresh privacy
  // observation. No elapsed-time sleeps or transport-kill races are needed.
  fs.appendFileSync(path.join(f.dir, "record.ts"), `\nif (process.argv[2] === "scripts/privacy-publication-gate.ts" && process.env.LLV_GATE_PUBLICATION_OBSERVED) require("node:fs").writeFileSync(${JSON.stringify(clock)}, String(Number(process.env.LLV_GATE_PUSH_DEADLINE) + 1));\n`);
  const http = await httpFixture(f), previous = loadPipelines();
  let elapsedMonotonicMs = 0;
  let preparationCompletedAt = 0;
  const monotonic = spyOn(performance, "now").mockImplementation(() => elapsedMonotonicMs);
  try {
    const subject = pipelineCorpus(2, 1)[1]!;
    Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
    subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
      disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
    savePipelines([subject]);
    let pushes = 0;
    const exec: ExecPort = async (command, args, cwd, env, options) => {
      if (command === "git" && args[0] === "push") pushes++;
      const result = await realExec(command, args, cwd, { ...f.env, ...env }, options);
      if (command === "bun" && args.includes("--publication-prepare") && result.code === 0) {
        elapsedMonotonicMs = preparationMs;
        preparationCompletedAt = Date.now();
      }
      if (command === "git" && args[0] === "push") {
        const expectedBudget = Math.min(DEFAULT_PUBLICATION_PUSH_MS,
          Math.max(PUBLICATION_TRANSPORT_MS, 2 * preparationMs) + PUBLICATION_PACK_MARGIN_MS);
        const deadline = Number(env?.LLV_GATE_PUSH_DEADLINE);
        expect(options?.timeoutMs).toBe(expectedBudget);
        expect(deadline).toBeGreaterThanOrEqual(preparationCompletedAt + expectedBudget - PUBLICATION_PACK_MARGIN_MS);
        expect(deadline).toBeLessThanOrEqual(Date.now() + expectedBudget - PUBLICATION_PACK_MARGIN_MS);
      }
      return result;
    };
    const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
    expect(result).toMatchObject({ ok: false, failure: { code: 1, retryableDeadline: true, hookStoppedCheck: "publication input validation" } });
    expect(result).not.toHaveProperty("uncertain");
    expect(findPipelineRecord(subject.id)!.delivery!.operation!.state).toBe("settled");
    expect(http.events().map(event => event.kind)).toEqual(["checks", "mint"]);
    expect(pushes).toBe(1); expect(http.rpc()).toBe(0);
  } finally { monotonic.mockRestore(); savePipelines(previous); http.close(); }
}, 90_000);

for (const change of ["pause", "epoch", "owner", "head", "authentication", "lost-reply"] as const) {
  test(`prepared publication preserves custody and reconciliation on ${change}`, async () => {
    const f = fixture(), http = await httpFixture(f);
    const previous = loadPipelines();
    try {
      const subject = pipelineCorpus(2, 1)[1]!;
      Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
      subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
        disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
      savePipelines([subject]);
      if (change === "authentication") http.refuseRpc();
      let pushes = 0;
      const exec: ExecPort = async (command, args, cwd, overrides, options) => {
        if (command === "git" && args[0] === "push") pushes++;
        const result = await realExec(command, args, cwd, { ...f.env, ...overrides }, options);
        if (command === "bun" && args[2] === "--publication-prepare" && result.code === 0) {
          const current = findPipelineRecord(subject.id)!;
          if (change === "pause") current.state = "paused";
          if (change === "epoch") { current.delivery!.epoch++; current.delivery!.operation!.epoch++; }
          if (change === "owner") { current.delivery!.ownerId = "other-owner"; current.delivery!.active = false; current.delivery!.disposition = "comparison"; current.delivery!.publish = "disabled"; }
          if (change === "head") f.git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "moved head");
          if (["pause", "epoch", "owner"].includes(change)) savePipelines([current]);
        }
        if (change === "lost-reply" && command === "git" && args[0] === "push" && result.code === 0) return { code: null, stdout: "", stderr: "reply lost" };
        return result;
      };
      const result = await publishPipelineBranch(subject, exec, { acceptedSha: f.head });
      if (change === "lost-reply") {
        expect(result).toMatchObject({ ok: true, remote: "unreachable", uncertain: true });
        expect(http.rpc()).toBe(1);
        // A fresh controller process reads the durable operation and reconciles
        // the already-written remote without another transport or credential.
        const childSource = path.join(f.dir, ".git", "recover.ts");
        fs.writeFileSync(childSource, `import { reconcilePipelinePublication } from ${JSON.stringify(path.join(root, "src/lib/pipelines/git.ts"))};
          import { realExec } from ${JSON.stringify(path.join(root, "src/lib/workflows/provision.ts"))};
          const result = await reconcilePipelinePublication(${JSON.stringify(subject.id)}, 1, realExec);
          if (result !== null) throw new Error(String(result));`);
        const child = await realExec(process.execPath, [childSource], root, { ...f.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR }, { timeoutMs: 30_000 });
        expect(child.code, child.stderr).toBe(0);
        expect(findPipelineRecord(subject.id)!.publishedCommit).toBe(f.head);
      } else {
        expect(result.ok).toBeFalse();
        expect(http.rpc()).toBe(0);
        if (change === "authentication") {
          expect(result.ok ? undefined : result.failure?.retryableApp403).not.toBeTrue();
          expect(http.rejected()).toBeGreaterThan(0); expect(pushes).toBe(1);
          expect(findPipelineRecord(subject.id)!.publishedCommit).not.toBe(f.head);
        } else expect(pushes).toBe(0);
      }
      expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
    } finally { savePipelines(previous); http.close(); }
  }, 90_000);
}
