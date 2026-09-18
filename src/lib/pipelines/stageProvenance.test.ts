import { expect, test } from "bun:test";

import type { ExecPort, ExecResult } from "@/lib/workflows/provision";

import { collectStageProvenance } from "./stageProvenance";

/* Graph slice 2: the provenance on a stage report is what the SERVER read, so
   every read here is a mocked command and nothing reaches a real repository. */

const PIPELINE = { worktreeDir: "/work/pipeline", branch: "pipeline/slice-two" };
const HEAD = "4f8b1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f607182";

type Reply = Partial<ExecResult> | undefined;

function execWith(replies: Record<string, Reply>): { exec: ExecPort; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecPort = (command, args, cwd) => {
    calls.push([command, ...args, cwd]);
    const key = [command, ...args].join(" ");
    const match = Object.entries(replies).find(([prefix]) => key.startsWith(prefix));
    return { code: 0, stdout: "", stderr: "", ...(match?.[1] ?? {}) } as ExecResult;
  };
  return { exec, calls };
}

test("provenance is the head, the branch's pull request and the declared outputs the server found", () => {
  const { exec, calls } = execWith({
    "git status --porcelain": { stdout: "" },
    "git rev-parse HEAD": { stdout: `${HEAD}\n` },
    "git ls-files": { stdout: "docs/report.html\0src/lib/x.ts\0" },
    "timeout --signal=KILL 10s gh pr list": { stdout: '[{"url":"https://forge.example/x/pull/7","number":7,"state":"OPEN"}]' },
  });

  const provenance = collectStageProvenance(PIPELINE, ["docs/report.html", "docs/missing.html"], exec);

  expect(provenance).toEqual({
    head: HEAD,
    branch: "pipeline/slice-two",
    uncommitted: [],
    pullRequest: { url: "https://forge.example/x/pull/7", number: 7, state: "OPEN" },
    outputs: [
      { path: "docs/report.html", present: true },
      { path: "docs/missing.html", present: false },
    ],
  });
  /* The forge read is bounded and made in the pipeline's own worktree. */
  expect(calls.find((call) => call[0] === "timeout")).toEqual([
    "timeout", "--signal=KILL", "10s",
    "gh", "pr", "list", "--head", "pipeline/slice-two", "--state", "all", "--limit", "1", "--json", "url,number,state",
    "/work/pipeline",
  ]);
});

test("a dirty worktree is reported as the paths the server saw, and the report is not refused", () => {
  const { exec } = execWith({
    "git status --porcelain": { stdout: " M src/lib/x.ts\n?? notes.md\n" },
    "git rev-parse HEAD": { stdout: `${HEAD}\n` },
    "timeout --signal=KILL 10s gh pr list": { stdout: "[]" },
  });

  const provenance = collectStageProvenance(PIPELINE, [], exec);

  expect(provenance.uncommitted).toEqual(["src/lib/x.ts", "notes.md"]);
  expect(provenance.head).toBe(HEAD);
  expect(provenance.outputs).toEqual([]);
});

test("reads the server cannot make are null, never a claim and never a refusal", () => {
  const { exec } = execWith({
    "git status --porcelain": { code: 128, stderr: "not a git repository" },
    "git rev-parse HEAD": { code: 128, stderr: "unknown revision" },
    "git ls-files": { code: 128, stderr: "not a git repository" },
    /* A forge that timed out under the bound, which `timeout` kills. */
    "timeout --signal=KILL 10s gh pr list": { code: 137, signal: "SIGKILL" },
  });

  expect(collectStageProvenance(PIPELINE, ["docs/report.html"], exec)).toEqual({
    head: null,
    branch: "pipeline/slice-two",
    uncommitted: null,
    pullRequest: null,
    outputs: [{ path: "docs/report.html", present: false }],
  });
});

test("a forge answer that is not a pull request record is read as no pull request", () => {
  for (const stdout of ["", "not json", "[]", '[{"url":"https://forge.example/x/pull/7"}]']) {
    const { exec } = execWith({
      "git rev-parse HEAD": { stdout: `${HEAD}\n` },
      "timeout --signal=KILL 10s gh pr list": { stdout },
    });
    expect(collectStageProvenance(PIPELINE, [], exec).pullRequest).toBeNull();
  }
});
