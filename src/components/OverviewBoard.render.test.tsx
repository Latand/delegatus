import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { en } from "@/lib/i18n/en";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { OverviewBoard } from "./OverviewBoard";

/* Issue #345, on the surface #1820 gave the Overview: a card presents its
   project's display name and never its canonical key, and the server render
   of the whole page — the kanban board included — holds. */

const NOW = 1_800_000_000;
const LEDGER = "-work-acme-ledger";
const ATLAS = "-work-dune-atlas";

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: LEDGER,
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 30,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function task(id: string, project: string, path: string): BoardTask {
  return {
    id,
    project,
    text: `Work on ${id}`,
    status: "assigned",
    placement: "unplaced",
    assignments: [{ path, conversationId: null, panePid: null, state: "delivered", error: null, at: "2026-09-18T10:00:00.000Z" }],
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    revision: "task-v1:00000000-0000-4000-8000-000000000001",
  } as BoardTask;
}

/** Only what the operator reads: every tag, and so every attribute, removed. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'");

test("overview cards show display names, canonical keys never render as text", () => {
  const files = [
    fileEntry({ path: "/sessions/ledger.jsonl", title: "Builder", activity: "live", lastTurn: { startedAt: (NOW - 120) * 1000, endedAt: null } }),
    fileEntry({ path: "/sessions/atlas.jsonl", project: ATLAS, title: "Reviewer", activity: "live", lastTurn: { startedAt: (NOW - 90) * 1000, endedAt: null } }),
  ];
  const html = renderToStaticMarkup(
    <OverviewBoard
      files={files}
      projectCatalog={[]}
      projectDisplayNames={{ [LEDGER]: "acme-ledger", [ATLAS]: "dune-atlas" }}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      tasks={[task("ledger", LEDGER, "/sessions/ledger.jsonl"), task("atlas", ATLAS, "/sessions/atlas.jsonl")]}
      flows={[]}
      loaded
      now={NOW}
      onSelectProject={() => {}}
    />,
  );
  const text = visibleText(html);
  expect(text).toContain("acme-ledger");
  expect(text).toContain("dune-atlas");
  expect(text).not.toContain(LEDGER);
  expect(text).not.toContain(ATLAS);
  /* The one board, server-rendered: two projects' cards in its columns. */
  expect(html).toContain('data-id="task:ledger"');
  expect(html).toContain('data-id="task:atlas"');
  expect(text).toContain(en["overview.workingOnly"]);
});
