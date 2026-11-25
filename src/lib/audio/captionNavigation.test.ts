import { describe, expect, test } from "bun:test";

import { openCaptionTarget } from "./captionNavigation";

interface Entry { id: string }
interface File { path: string; conversationId?: string; project: string }

function shell(files: File[] = [], needsYou: Entry[] = []) {
  const calls: string[] = [];
  return {
    calls,
    navigation: {
      needsYou,
      files,
      jumpToEntry: (entry: Entry) => { calls.push(`entry:${entry.id}`); },
      focusLane: (pipelineId: string, project: string) => { calls.push(`lane:${pipelineId}@${project}`); },
      selectProject: (project: string) => { calls.push(`project:${project}`); },
      openFile: (file: File) => { calls.push(`open:${file.project}:${file.path}`); },
    },
  };
}

describe("a sound caption's click navigates", () => {
  test("a project target selects that project", () => {
    const { calls, navigation } = shell();
    openCaptionTarget({ kind: "project", project: "other-project" }, navigation);
    expect(calls).toEqual(["project:other-project"]);
  });

  test("a conversation target in another project opens that file, which switches the project", () => {
    const file = { path: "/sessions/reviewer.jsonl", conversationId: "conv-1", project: "other-project" };
    const { calls, navigation } = shell([{ path: "/sessions/here.jsonl", project: "demo" }, file]);
    openCaptionTarget({ kind: "conversation", path: file.path }, navigation);
    expect(calls).toEqual(["open:other-project:/sessions/reviewer.jsonl"]);
  });

  test("a conversation target named only by its id finds the same file", () => {
    const file = { path: "/sessions/reviewer.jsonl", conversationId: "conv-1", project: "other-project" };
    const { calls, navigation } = shell([file]);
    openCaptionTarget({ kind: "conversation", conversationId: "conv-1" }, navigation);
    expect(calls).toEqual(["open:other-project:/sessions/reviewer.jsonl"]);
  });

  test("a conversation that is not known opens nothing", () => {
    const { calls, navigation } = shell([{ path: "/sessions/here.jsonl", project: "demo" }]);
    openCaptionTarget({ kind: "conversation", path: "/sessions/gone.jsonl" }, navigation);
    expect(calls).toEqual([]);
  });

  test("a lane target focuses the lane in its project", () => {
    const { calls, navigation } = shell();
    openCaptionTarget({ kind: "lane", pipelineId: "p1", project: "other-project" }, navigation);
    expect(calls).toEqual(["lane:p1@other-project"]);
  });

  test("a waiting entry wins, and a gone entry falls back to what it names", () => {
    const waiting = shell([], [{ id: "e1" }]);
    openCaptionTarget({ kind: "needs-you", entryId: "e1", then: { kind: "project", project: "p" } }, waiting.navigation);
    expect(waiting.calls).toEqual(["entry:e1"]);

    const gone = shell();
    openCaptionTarget({ kind: "needs-you", entryId: "e1", then: { kind: "project", project: "p" } }, gone.navigation);
    expect(gone.calls).toEqual(["project:p"]);
  });
});
