import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { SUPPORTED_CODEX_VERSIONS } from "../src/lib/accounts/codexVersions";
import { PUBLICATION_TRANSPORT_MS, publicationCheckBinding, readPublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";
import { publishPipelineBranch } from "../src/lib/pipelines/git";
import { engineForgeWriteEnv, FORGE_APP_REPOSITORIES_FILE } from "../src/lib/git/agentForgeCredentials";
import { pipelineCorpus } from "../src/lib/pipelines/fixtures/corpus";
import { findPipelineRecord, loadPipelines, savePipelines } from "../src/lib/pipelines/store";
import { realExec, type ExecPort } from "../src/lib/workflows/provision";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const nativeTest = test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch));
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, nativeFixture, touchedChecks, httpFixture } = createPublicationFixtures(root, roots);

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
        expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
      }
      return realExec(command, args, cwd, { ...f.env, ...overrides, PATH: f.env.PATH }, options);
    };
    expect(await publishPipelineBranch(subject, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, sha: f.head, remote: "published" });
    expect(pushes).toBe(1); expect(http.rpc()).toBe(1); expect(http.rejected()).toBe(0);
    expect(f.calls().filter(call => call.args[0] === "native-install").map(call => call.args[2]))
      .toEqual(SUPPORTED_CODEX_VERSIONS.map(version => `@openai/codex@${version}`));
    expect(http.events().filter(event => event.kind === "checks")).toHaveLength(1);
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
      return realExec(command, args, cwd, { ...f.env, ...overrides, PATH: f.env.PATH }, options);
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
  test(`a gate with ${capability} preparation capability uses the current canonical checks once`, async () => {
    const f = fixture();
    const savedImageBun = process.env.LLV_GATE_IMAGE_BUN;
    const savedCwd = process.cwd;
    delete f.env.LLV_GATE_PUBLICATION_RECEIPT;
    const marker = path.join(f.dir, "scripts/local-gate-capabilities.json");
    if (capability === "absent") fs.rmSync(marker);
    else fs.writeFileSync(f.writablePath("scripts/local-gate-capabilities.json"), capability === "unsupported" ? '{"publicationPrepare":4}' : '{');
    // Historical candidates are checked by the current canonical gate. The
    // prepared receipt drives the current native hook and trusted transport gate.
    f.git("-c", "core.hooksPath=/dev/null", "add", "scripts/local-gate-capabilities.json", "scripts/local-gate.ts");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "legacy gate capability");
    const http = await httpFixture(f, false), previous = loadPipelines();
    let appCredentialEnv: Record<string, string | undefined> | undefined;
    let appDeclaration: string | undefined;
    let previousAppDeclaration: Buffer | undefined;
    if (capability === "absent") {
      const state = process.env.LLV_STATE_DIR!;
      appDeclaration = path.join(state, FORGE_APP_REPOSITORIES_FILE);
      if (fs.existsSync(appDeclaration)) previousAppDeclaration = fs.readFileSync(appDeclaration);
      fs.writeFileSync(appDeclaration, JSON.stringify(["fixture/repo-fixture"]));
      appCredentialEnv = engineForgeWriteEnv();
    }
    let packagedRoot = root;
    if (capability === "absent") {
      packagedRoot = path.join(f.dir, ".git", "packaged-docker-app");
      fs.mkdirSync(path.join(packagedRoot, ".githooks"), { recursive: true });
      fs.mkdirSync(path.join(packagedRoot, "scripts"), { recursive: true });
      fs.copyFileSync(path.join(root, "Dockerfile"), path.join(packagedRoot, "Dockerfile"));
      fs.copyFileSync(path.join(root, ".githooks/pre-push"), path.join(packagedRoot, ".githooks/pre-push"));
      fs.symlinkSync(path.join(root, "scripts/local-gate.ts"), path.join(packagedRoot, "scripts/local-gate.ts"));
      fs.symlinkSync(path.join(root, "scripts/local-gate-tests.ts"), path.join(packagedRoot, "scripts/local-gate-tests.ts"));
      fs.copyFileSync(path.join(root, "scripts/local-gate-capabilities.json"), path.join(packagedRoot, "scripts/local-gate-capabilities.json"));
      expect(fs.readFileSync(path.join(packagedRoot, "Dockerfile"), "utf8")).toContain("COPY --from=build /app/scripts ./scripts");
      process.cwd = () => packagedRoot;
      process.env.LLV_GATE_IMAGE_BUN = "bun-container";
    }
    try {
      const subject = pipelineCorpus(2, 1)[1]!;
      Object.assign(subject, { project: "fixture", repoDir: path.join(path.dirname(f.dir), "source"), worktreeDir: f.dir, lastPassedCommit: f.head });
      subject.delivery = { target: { repository: "repo-fixture", remote: http.remote, branch: "refs/heads/main" },
        disposition: "owner", publish: "enabled", active: true, ownerId: subject.id, epoch: 1, journal: [] };
      savePipelines([subject]);
      let preparations = 0, pushes = 0;
      const exec: ExecPort = (command, args, cwd, env, options) => {
        if ((command === "bun" || command === "bun-container") && args.includes("--publication-prepare")) {
          preparations++;
          if (capability === "absent") expect(command).toBe("bun-container");
          expect(args[0]).not.toBe("scripts/local-gate.ts");
          expect(env?.LLV_GATE_CANONICAL_TOOLS).toBe("1");
        }
        if (command === "git" && args[0] === "push") {
          pushes++;
          expect(env?.LLV_GATE_PUBLICATION_RECEIPT).toBeDefined();
          expect(env?.LLV_SKIP_HOOKS).toBeUndefined();
          const hookIndex = Number(env?.GIT_CONFIG_COUNT) - 2;
          expect(Number(env?.GIT_CONFIG_COUNT)).toBeGreaterThanOrEqual(2);
          if (capability === "absent") {
            expect(env?.LLV_GATE_IMAGE_BUN).toBe("bun-container");
            expect(Number(env?.GIT_CONFIG_COUNT)).toBeGreaterThan(Number(appCredentialEnv!.GIT_CONFIG_COUNT));
            for (let index = 0; index < Number(appCredentialEnv!.GIT_CONFIG_COUNT); index++) {
              expect(env?.[`GIT_CONFIG_KEY_${index}`]).toBe(appCredentialEnv![`GIT_CONFIG_KEY_${index}`]);
              expect(env?.[`GIT_CONFIG_VALUE_${index}`]).toBe(appCredentialEnv![`GIT_CONFIG_VALUE_${index}`]);
            }
          }
          expect(env?.[`GIT_CONFIG_VALUE_${hookIndex}`]).toBe(path.join(packagedRoot, ".githooks"));
        }
        return realExec(command, args, cwd, { ...f.env, ...env, PATH: f.env.PATH }, options);
      };
      expect(await publishPipelineBranch(subject, exec, { acceptedSha: f.head })).toMatchObject({ ok: true, remote: "published" });
      expect(preparations).toBe(1); expect(pushes).toBe(1); expect(http.rpc()).toBe(1);
      expect(http.events().map(event => event.kind)).toEqual(["checks", "mint", "rpc"]);
      if (capability === "absent") {
        const selected = fs.readFileSync(`${f.env.HOOK_LOG}.bun-container`, "utf8").trim().split("\n");
        expect(selected.some(line => line.includes("--publication-prepare"))).toBeTrue();
        expect(selected.filter(line => line.includes("scripts/local-gate.ts pre-push")).length).toBeGreaterThanOrEqual(2);
        expect(f.calls().filter(call => call.args[0] === "scripts/privacy-publication-gate.ts").length).toBeGreaterThanOrEqual(2);
      }
      expect(spawnSync("git", ["--git-dir", http.bare, "rev-parse", "refs/heads/main"], { env: f.env, encoding: "utf8" }).stdout.trim()).toBe(f.head);
    } finally {
      savePipelines(previous); http.close();
      if (appDeclaration) {
        if (previousAppDeclaration) fs.writeFileSync(appDeclaration, previousAppDeclaration);
        else fs.rmSync(appDeclaration, { force: true });
      }
      if (savedImageBun === undefined) delete process.env.LLV_GATE_IMAGE_BUN; else process.env.LLV_GATE_IMAGE_BUN = savedImageBun;
      process.cwd = savedCwd;
    }
  }, 90_000);
}
