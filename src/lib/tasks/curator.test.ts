import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-curator-state-"));
const { applyTaskCuratorProposals, collectTaskCuratorInputs, collectTaskCuratorProjects } = await import("./curator");
const { loadTasks } = await import("./store");

const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-curator-files-"));

function tmpTasksFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-curator-tasks-")), "tasks.json");
}

function claudeJsonl(name: string, rows: unknown[]): string {
  const filePath = path.join(FILES_DIR, name);
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return filePath;
}

function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: pathname,
    root: "claude-projects",
    name: path.basename(pathname),
    project: "proj",
    title: path.basename(pathname),
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: new Date("2026-07-08T10:59:00.000Z").getTime() / 1000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

describe("task curator", () => {
  test("collects recent real user inputs with source links and context", () => {
    const pathname = claudeJsonl("context.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:10:00.000Z",
        message: { content: [{ type: "text", text: "# AGENTS.md instructions\nnoise\n</INSTRUCTIONS>\n\nCreate a short task curator API." }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-08T10:11:00.000Z",
        message: { content: [{ type: "text", text: "I will inspect it." }] },
      },
      {
        type: "user",
        timestamp: "2026-07-08T08:00:00.000Z",
        message: { content: [{ type: "text", text: "Old request" }] },
      },
    ]);

    const inputs = collectTaskCuratorInputs([file(pathname)], {
      now: new Date("2026-07-08T11:00:00.000Z"),
      lookbackMs: 60 * 60 * 1000,
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.source.text).toBe("Create a short task curator API.");
    expect(inputs[0]!.session.href).toBe("/#f=" + encodeURIComponent(pathname));
    expect(inputs[0]!.context.map((line) => line.role)).toContain("assistant");
    expect(inputs[0]!.counts.messages).toBe(3);
    expect(inputs[0]!.hints.likelyAgentInstruction).toBe(false);
  });

  test("scopes inputs to one project and lists all projects in the window", () => {
    const alphaPath = claudeJsonl("alpha.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:10:00.000Z",
        message: { content: [{ type: "text", text: "Alpha needs a curator project filter." }] },
      },
    ]);
    const betaPath = claudeJsonl("beta.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:20:00.000Z",
        message: { content: [{ type: "text", text: "Beta wants its own board card." }] },
      },
    ]);
    const entries = [file(alphaPath, { project: "alpha" }), file(betaPath, { project: "beta" })];
    const options = { now: new Date("2026-07-08T11:00:00.000Z"), lookbackMs: 60 * 60 * 1000 };

    const all = collectTaskCuratorInputs(entries, options);
    expect(all.map((input) => input.project).sort()).toEqual(["alpha", "beta"]);

    const scoped = collectTaskCuratorInputs(entries, { ...options, project: "beta" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.project).toBe("beta");
    expect(scoped[0]!.source.text).toBe("Beta wants its own board card.");

    const projects = collectTaskCuratorProjects(entries, options);
    expect(projects).toEqual([
      { project: "alpha", sessions: 1 },
      { project: "beta", sessions: 1 },
    ]);
  });

  test("marks tmux worker prompts as likely agent instructions", () => {
    const pathname = claudeJsonl("worker.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:10:00.000Z",
        message: { content: [{ type: "text", text: "Read `.tmux-multi-agent/sessions/abcd/brief.md` first.\nWrite your handoff." }] },
      },
    ]);

    const inputs = collectTaskCuratorInputs([file(pathname)], {
      now: new Date("2026-07-08T11:00:00.000Z"),
      lookbackMs: 60 * 60 * 1000,
    });

    expect(inputs[0]!.hints.likelyAgentInstruction).toBe(true);
  });

  test("applies only short curated proposals and deduplicates them", () => {
    const pathname = claudeJsonl("apply.jsonl", [
      {
        type: "user",
        timestamp: "2026-07-08T10:10:00.000Z",
        message: { content: [{ type: "text", text: "Please add hourly task curation for agent inputs." }] },
      },
    ]);
    const entries = [file(pathname)];
    const tasksFile = tmpTasksFile();
    const [input] = collectTaskCuratorInputs(entries, { now: new Date("2026-07-08T11:00:00.000Z") });
    if (!input) throw new Error("missing input");

    const first = applyTaskCuratorProposals(
      entries,
      [
        { inputId: input.id, title: "Add hourly task curator" },
        {
          inputId: input.id,
          title:
            "This title is intentionally too long because it looks like a pasted transcript instead of a compact task title that belongs on the board",
        },
      ],
      { now: new Date("2026-07-08T11:00:00.000Z"), tasksFile },
    );
    const second = applyTaskCuratorProposals(entries, [{ inputId: input.id, title: "Add hourly task curator" }], {
      now: new Date("2026-07-08T11:00:00.000Z"),
      tasksFile,
    });

    expect(first.created).toHaveLength(1);
    expect(first.created[0]!.text).toBe("Add hourly task curator");
    expect(first.created[0]!.dueAt).toBeUndefined(); expect(first.created[0]!.dueTz).toBeUndefined();
    expect(first.created[0]!.source?.path).toBe(pathname);
    expect(first.skipped[0]!.reason).toBe("title must be short and clean");
    expect(second.created).toHaveLength(0);
    expect(second.skipped[0]!.reason).toBe("duplicate");
    expect(loadTasks(tasksFile)).toHaveLength(1);
  });
});
