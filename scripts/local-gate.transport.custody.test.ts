import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { publishPipelineBranch } from "../src/lib/pipelines/git";
import { pipelineCorpus } from "../src/lib/pipelines/fixtures/corpus";
import { findPipelineRecord, loadPipelines, savePipelines } from "../src/lib/pipelines/store";
import { realExec, type ExecPort } from "../src/lib/workflows/provision";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture, httpFixture } = createPublicationFixtures(root, roots);

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
    } finally { savePipelines(previous); http.close(); }
  }, 90_000);
}
