import { expect, test } from "bun:test";

import { dropLegacyWorkflowDrafts } from "./workflowModel";

test("dropLegacyWorkflowDrafts fences persisted wf-* drafts, keeping agent drafts (#136)", () => {
  const agentA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const agentB = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const ids = [agentA, "wf-abc", agentB, "wf-def"];
  /* Legacy workflow drafts are dropped so a tab that outlived a deploy shows
     none; ordinary agent drafts are untouched. */
  expect(dropLegacyWorkflowDrafts(ids)).toEqual([agentA, agentB]);
  expect(dropLegacyWorkflowDrafts([agentA])).toEqual([agentA]);
  expect(dropLegacyWorkflowDrafts(["wf-only"])).toEqual([]);
});
