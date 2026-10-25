import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const retired = [
  "src/components/scheme/BulkActionBar.tsx",
  "src/components/scheme/EdgeChips.tsx",
  "src/components/scheme/GroupOverridePanel.tsx",
  "src/components/scheme/Minimap.tsx",
  "src/components/scheme/SchemeBoard.tsx",
  "src/components/scheme/SubagentBadges.tsx",
  "src/components/scheme/SubagentTrayView.tsx",
  "src/components/scheme/TaskBandsLayer.tsx",
  "src/components/scheme/TaskCard.tsx",
  "src/components/scheme/TaskEdgesLayer.tsx",
  "src/components/scheme/TaskStickyComposer.tsx",
  "src/components/scheme/TasksLayer.tsx",
  "src/components/scheme/assignmentState.ts",
  "src/components/scheme/bulkActions.ts",
  "src/components/scheme/canvasGrid.ts",
  "src/components/scheme/currentWork.ts",
  "src/components/scheme/domOrder.ts",
  "src/components/scheme/expandedNode.ts",
  "src/components/scheme/findFreeSlot.ts",
  "src/components/scheme/lasso.ts",
  "src/components/scheme/nodes.tsx",
  "src/components/scheme/offscreenClusters.ts",
  "src/components/scheme/renameRequest.ts",
  "src/components/scheme/spatialNav.ts",
  "src/components/scheme/subagentBadgeAnchors.ts",
  "src/components/scheme/subagentBadgeLayout.ts",
  "src/components/scheme/taskPlacement.ts",
  "src/components/scheme/useLasso.ts",
  "src/components/scheme/useSchemeCamera.ts",
  "src/components/scheme/useSpatialNav.ts",
  "src/components/scheme/visibilityIndex.ts",
  "src/components/flows/FlowDialog.tsx",
  "src/components/flows/FlowHub.tsx",
  "src/components/flows/FlowStrip.tsx",
  "src/components/flows/RoleTag.tsx",
  "src/components/pipelines/PipelineEditor.tsx",
  "src/components/pipelines/PipelineHub.tsx",
  "src/components/pipelines/PipelineStrip.tsx",
  "src/components/pipelines/StageCompletedCard.tsx",
  "src/components/pipelines/StageStatusRow.tsx",
  "src/components/pipelines/VerdictPopover.tsx",
  "src/components/tasks/TaskWorkflowPanel.tsx",
  "scripts/capture-board-density.ts",
  "scripts/fixtures/board-density.tsx",
];

test("the retired scheme board cannot return through its old component, fixture, or docs artifact", () => {
  expect(retired.filter(path => existsSync(join(root, path)))).toEqual([]);

  const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
  expect(css).not.toContain(".scheme-session");

  const renderer = readFileSync(join(root, "docs/design/task-board-integration/artifact/build-renderer.mjs"), "utf8");
  expect(renderer).not.toContain("src/components/scheme/SchemeBoard.tsx");
});
