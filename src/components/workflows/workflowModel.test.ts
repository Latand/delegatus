import { expect, test } from "bun:test";

import { dropLegacyWorkflowDrafts } from "./workflowModel";

test("dropLegacyWorkflowDrafts fences persisted wf-* drafts, keeping agent drafts (#136)", () => {
  const agentA = "agent-draft-a";
  const agentB = "agent-draft-b";
  const ids = [agentA, "wf-abc", agentB, "wf-def"];
  /* Legacy workflow drafts are dropped so a tab that outlived a deploy shows
     none; ordinary agent drafts are untouched. */
  expect(dropLegacyWorkflowDrafts(ids)).toEqual([agentA, agentB]);
  expect(dropLegacyWorkflowDrafts([agentA])).toEqual([agentA]);
  expect(dropLegacyWorkflowDrafts(["wf-only"])).toEqual([]);
});
