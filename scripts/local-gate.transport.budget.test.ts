import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { publishPipelineBranch } from "../src/lib/pipelines/git";
import { pipelineCorpus } from "../src/lib/pipelines/fixtures/corpus";
import { findPipelineRecord, loadPipelines, savePipelines } from "../src/lib/pipelines/store";
import { realExec, type ExecPort } from "../src/lib/workflows/provision";
import { DEFAULT_PUBLICATION_PUSH_MS, PUBLICATION_PACK_MARGIN_MS, PUBLICATION_TRANSPORT_HOOK_MS } from "../src/lib/pipelines/gateBudget";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, httpFixture, commitFixtureInputs } = createPublicationFixtures(root, roots);

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
    const transportMs = scenario === "over cap" ? PUBLICATION_TRANSPORT_HOOK_MS + 1
      : scenario === "capped budget" ? 70_000 : preparationMs;
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
      let pushes = 0, transportBudget = 0, hookAllowance = 0, preparationTimeout = 0;
      const exec: ExecPort = async (command, args, cwd, env, options) => {
        if (command === "bun" && args.includes("--publication-prepare")) preparationTimeout = options?.timeoutMs ?? 0;
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
      expect(preparationTimeout).toBe(DEFAULT_PUBLICATION_PUSH_MS);
      expect(transportBudget).toBe(PUBLICATION_TRANSPORT_HOOK_MS + PUBLICATION_PACK_MARGIN_MS);
      expect(hookAllowance).toBe(PUBLICATION_TRANSPORT_HOOK_MS);
      expect(pushes).toBe(1);
      expect(http.rpc()).toBe(["slow privacy", "capped budget"].includes(scenario) ? 1 : 0);
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
          Math.max(PUBLICATION_TRANSPORT_HOOK_MS, 2 * preparationMs) + PUBLICATION_PACK_MARGIN_MS);
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
