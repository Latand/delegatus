import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportLines, parseExportLine } from "./humanInput";
import { zonedDate } from "./method";
import { exportHumanInputs, listTranscriptFiles, type ConversationResolution, type TranscriptFacts } from "./transcriptExport";

/* One invented host's transcript stores on disk: two account stores, a shared
   mirror and an old file, with Codex and Claude sessions. Nothing here is
   real data. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-export-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const KYIV = "Europe/Kyiv";
const mark = (origin: "o" | "a", key: string) => `<!-- llv:structured-user ctx=${origin}.${key.padEnd(43, "A")}.${"B".repeat(16)} -->\n`;

function write(relative: string, lines: unknown[]): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

const codexUser = (at: string, id: string, text: string) => ({ timestamp: at, type: "response_item", payload: { type: "message", role: "user", id, content: [{ type: "input_text", text }] } });
const codexMeta = (at: string, cwd: string, originator = "llv-structured-host") => ({ timestamp: at, type: "session_meta", payload: { id: "session", cwd, originator, source: "vscode" } });
const claudeUser = (at: string, uuid: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "user", timestamp: at, uuid, promptId: `p-${uuid}`, sessionId: "s", cwd: "/work/harbor", entrypoint: "sdk-cli", promptSource: "sdk",
  message: { role: "user", content: text }, ...extra,
});

/* A Codex session filed under the day it began, the 22nd, holding the
   operator's messages at 23:50 on the 22nd and 00:20 on the 23rd in Kyiv. The
   23rd's message names another project; the conversation runs in harbor. */
const crossing = write("accounts/a/sessions/2026/09/22/rollout-crossing.jsonl", [
  codexMeta("2026-09-22T20:40:00Z", "/work/harbor"),
  codexUser("2026-09-22T20:41:00Z", "i-0", "# AGENTS.md instructions for the repo"),
  codexUser("2026-09-22T20:50:00Z", "i-1", `${mark("o", "K1")}reconcile the ledger before the close`),
  codexUser("2026-09-22T20:52:00Z", "i-2", `${mark("a", "K2")}Reviewer: two findings, see the report`),
  codexUser("2026-09-22T20:55:00Z", "i-3", "worker note that arrived with role=user and no marker"),
  codexUser("2026-09-22T21:20:00Z", "i-4", `${mark("o", "K4")}also check the lantern export totals`),
]);
/* Its continuation copies the history, ids and markers included, and adds one. */
write("accounts/a/sessions/2026/09/23/rollout-continued.jsonl", [
  codexMeta("2026-09-23T06:00:00Z", "/work/harbor"),
  codexUser("2026-09-22T21:20:00Z", "i-4", `${mark("o", "K4")}also check the lantern export totals`),
  codexUser("2026-09-23T06:05:00Z", "i-5", `${mark("o", "K5")}ship it`),
]);
/* A Claude conversation in an account store and its copy in the shared mirror. */
const claudeLines = [
  claudeUser("2026-09-23T07:00:00Z", "u-1", "add the audit column"),
  claudeUser("2026-09-23T07:01:00Z", "u-2", "[Image: original 1280x800]", { isMeta: true }),
  claudeUser("2026-09-23T07:30:00Z", "u-3", "<task-notification>recovery finished</task-notification>", { promptSource: "system" }),
];
write("accounts/b/projects/-work-harbor/claude-one.jsonl", claudeLines);
write("shared/projects/-work-harbor/claude-one.jsonl", claudeLines);
/* A pipeline stage: its first prompt is the generated template. */
write("accounts/a/sessions/2026/09/23/rollout-stage.jsonl", [
  codexMeta("2026-09-23T08:00:00Z", "/work/client-a"),
  codexUser("2026-09-23T08:00:10Z", "s-1", `${mark("o", "S1")}You are a Deployer. Deploy the exact SHA…`),
  codexUser("2026-09-23T08:40:00Z", "s-2", `${mark("o", "S2")}hold the deploy until 10:00`),
]);
/* Untouched since before the window: never read. */
const old = write("accounts/a/sessions/2026/08/01/rollout-old.jsonl", [codexMeta("2026-08-01T08:00:00Z", "/work/harbor"), codexUser("2026-08-01T08:01:00Z", "o-1", `${mark("o", "O1")}old`)]);
fs.utimesSync(old, new Date("2026-08-01T09:00:00Z"), new Date("2026-08-01T09:00:00Z"));

/** The host's knowledge: project from the conversation's working directory,
    Delegatus sessions registered, and one pipeline stage. */
function resolve(facts: TranscriptFacts): ConversationResolution {
  const project = facts.cwd === "/work/harbor" ? "harbor" : facts.cwd === "/work/client-a" ? "client-a" : null;
  const stage = facts.path.endsWith("rollout-stage.jsonl");
  return {
    project,
    registered: true,
    launch: stage ? "pipeline" : "operator",
    deliveryOrigin: (rec) => rec.engine === "claude" && rec.messageId === "u-1" ? { origin: "operator" } : null,
  };
}

const roots = [path.join(root, "accounts/a/sessions"), path.join(root, "accounts/b/projects"), path.join(root, "shared/projects")];
const day = (date: string) => zonedDate(date, KYIV)!;
const NOW = Date.parse("2026-09-24T12:00:00Z");

async function exportDay(date: string) {
  const window = day(date);
  return exportHumanInputs({ host: "stage", from: window.start, to: window.end, now: NOW, files: listTranscriptFiles(roots, window.start), resolve });
}

describe("one host's transcripts into human input", () => {
  test("files are chosen by modification time, never by the date directory a session was filed under", () => {
    const files = listTranscriptFiles(roots, day("2026-09-23").start);
    expect(files).toContain(crossing);
    expect(files).not.toContain(old);
  });

  test("each message lands on its own day in Kyiv, however the session was filed", async () => {
    const d22 = await exportDay("2026-09-22");
    const d23 = await exportDay("2026-09-23");
    expect(d22.inputs.map((input) => input.at)).toEqual([Date.parse("2026-09-22T20:50:00Z")]);
    expect(d23.inputs.map((input) => new Date(input.at).toISOString())).toEqual([
      "2026-09-22T21:20:00.000Z",
      "2026-09-23T06:05:00.000Z",
      "2026-09-23T07:00:00.000Z",
      "2026-09-23T08:40:00.000Z",
    ]);
  });

  test("only marked operator input counts, every exclusion is counted by reason, and copies count once", async () => {
    const { manifest } = await exportDay("2026-09-23");
    expect(manifest).toMatchObject({ host: "stage", coveredFrom: day("2026-09-23").start, coveredUntil: day("2026-09-23").end });
    expect(manifest.excluded).toEqual({
      /* The shared mirror's copy of the Claude conversation and the continuation's copy of i-4. */
      duplicate: 2,
      /* The pipeline stage's generated first prompt, despite its marker. */
      "stage-template": 1,
      /* Both copies of the attached screenshot and of the recovery notification. */
      attachment: 2,
      notification: 2,
    });
  });

  test("the 22nd excludes the worker's role=user note, the relay and the injected instructions", async () => {
    const { manifest } = await exportDay("2026-09-22");
    expect(manifest.excluded).toEqual({ "agent-message": 1, unmarked: 1, injected: 1 });
  });

  test("the project comes from the conversation's context, never from a name in the text", async () => {
    const { inputs } = await exportDay("2026-09-23");
    const lantern = inputs.find((input) => input.at === Date.parse("2026-09-22T21:20:00Z"))!;
    expect(lantern.project).toBe("harbor");
    expect(inputs.find((input) => input.at === Date.parse("2026-09-23T08:40:00Z"))!.project).toBe("client-a");
  });

  test("the export file carries no text, path or raw id", async () => {
    const result = await exportDay("2026-09-23");
    const text = exportLines(result.manifest, result.inputs);
    for (const leaked of ["reconcile", "lantern", "ship it", "/work/", "rollout-", "i-4", "u-1", "claude-one"]) expect(text).not.toContain(leaked);
    expect(text.trim().split("\n").map(parseExportLine).every((row) => row !== null)).toBe(true);
  });
});
