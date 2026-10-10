import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { DraftAgentPane } from "./DraftAgentPane";

/* A conversation of the project, which is where an unseeded draft reads the project's folder from. */
const inProject = {
  path: "/sessions/one.jsonl", root: "claude-projects", name: "one.jsonl", project: "proj", projectRoot: "/repo", title: "One", engine: "claude",
  kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "idle", proc: null, pid: null, model: null,
} as unknown as FileEntry;

/* SSR runs no effects and has no sessionStorage, so the pane renders in its
   fresh `draft` phase: the composer is live and no frozen launch bubble shows.
   The frozen phases are covered by DraftLaunchStatus.render.test.tsx and the
   lifecycle logic by draftSpawn.test.ts. */
test("a fresh draft renders the composer with no frozen launch status", () => {
  const html = renderToStaticMarkup(
    <DraftAgentPane draftId="d1" project="proj" files={[inProject]} onClose={() => {}} onSpawned={() => {}} />,
  );
  expect(html).toContain("Draft of a new agent conversation");
  /* The form is the composer and nothing else: no role, no directory, no select. */
  expect(html).toContain("data-runtime-pill");
  expect(html).not.toContain("Agent role preset");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("Choose an engine and a directory");
  /* The composer's send affordance is present (draft is the only sendable phase). */
  expect(html).toContain('aria-label="Launch the agent"');
  /* No frozen launch status while composing — none of the lifecycle copy shows. */
  expect(html).not.toContain("waiting for the conversation");
  expect(html).not.toContain("may already be running");
});
