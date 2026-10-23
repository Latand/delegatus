import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { PipelineEditor } from "./PipelineEditor";

/* A draft prepared from a PR names, in the existing draft editor, the PR it
   delivers to (docs/research/competitors-2026-10.md rank 4). */

const stage = { id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null, onFail: null } as unknown as PipelineStage;

function draft(delivery?: Pipeline["delivery"]): Pipeline {
  return {
    id: "d1", task: "PR #41: Links", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "pipeline/d1",
    baseBranch: "release", baseRef: "a".repeat(40), lastPassedCommit: "a".repeat(40), baseRefPinned: false,
    stages: [stage], runs: [{ stageId: "implement", attempts: [] }], cursor: { stageId: "implement", state: "pending", input: null, activatedBy: null },
    state: "draft", taskIds: [], createdAt: "2026-10-23T00:00:00Z", closedAt: null,
    ...(delivery ? { delivery } : {}),
  } as unknown as Pipeline;
}

const PR_DELIVERY = {
  target: { repository: "repo-x", remote: "https://github.com/contributor/project.git", branch: "refs/heads/feature/links", pr: 41 },
  disposition: "owner", publish: "enabled", ownerId: "d1", epoch: 1, active: true,
} as Pipeline["delivery"];

test("a PR draft shows its PR, base and head beside the draft fields", () => {
  /* Server rendering reads the English snapshot; uk is checked through the
     same key, which the locale files keep in lockstep. */
  const html = renderToStaticMarkup(<PipelineEditor pipeline={draft(PR_DELIVERY)} onClose={() => undefined} />);
  expect(html).toContain("data-pipeline-editor-source");
  expect(html).toContain(">Source<");
  expect(html).toContain("PR #41 · release ← feature/links");
  expect(translate("uk", "groupOverride.source")).toBe("Джерело");
  expect(translate("uk", "groupOverride.sourcePr", { number: 41, base: "release", head: "feature/links" })).toBe("PR #41 · release ← feature/links");
});

test("a draft with no PR delivery shows no source line", () => {
  const html = renderToStaticMarkup(<PipelineEditor pipeline={draft()} onClose={() => undefined} />);
  expect(html).not.toContain("data-pipeline-editor-source");
  const noPr = renderToStaticMarkup(<PipelineEditor pipeline={draft({ ...PR_DELIVERY!, target: { ...PR_DELIVERY!.target, pr: undefined } })} onClose={() => undefined} />);
  expect(noPr).not.toContain("data-pipeline-editor-source");
});
