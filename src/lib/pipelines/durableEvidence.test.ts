import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readStableTailRecords } from "@/lib/scanner/activity";
import { oauthFailureWithRecoveryTail } from "@/lib/accounts/migration/fixtures/claudeRecoveryTail";

import { durableStageTurnEvidence, MAX_REPORT_EVIDENCE_BYTES } from "./durableEvidence";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-durable-evidence-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeTranscript(name: string, records: Record<string, unknown>[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

const PASS_TEXT = "done\n\n```json\n{\"status\":\"pass\"}\n```";

test("Codex unavailable prompt metadata stays external without losing terminal evidence", async () => {
  const cut = Date.parse("2026-10-05T10:00:00Z");
  const file = writeTranscript("codex-unavailable-prompt.jsonl", [
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete",
      error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } },
    { type: "event_msg", timestamp: new Date(cut + 1000).toISOString(), payload: { type: "user_message",
      message: `<!-- llv:structured-user ctx=a.${"A".repeat(43)}.${"B".repeat(16)} -->\nWait for my review` } },
    { type: "event_msg", timestamp: new Date(cut + 2000).toISOString(), payload: { type: "agent_message", message: PASS_TEXT } },
    { type: "event_msg", timestamp: new Date(cut + 3000).toISOString(), payload: { type: "task_complete" } },
  ]);
  for (const afterCut of [undefined, cut]) {
    const evidence = await durableStageTurnEvidence("codex", file, undefined, undefined, undefined, afterCut);
    // The agent's answer closed the cut chain: no cut is open, and the saved cut is not in one.
    expect(evidence).toMatchObject({
      turn: "terminal", message: { text: PASS_TEXT },
      prompts: [{ ts: cut + 1000, origin: "external" }], firstProviderCutAt: null,
      ...(afterCut ? { requestedCutOpen: false } : {}),
    });
    expect(evidence?.externalPromptAfterCut).toBeUndefined();
  }
});

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} reads the full assistant brief before stage_report and the later closing message`, async () => {
    const before = "2026-07-18T10:02:00.000Z";
    const after = "2026-07-18T10:05:00.000Z";
    const brief = "Full builder brief with exact implementation details.";
    const closing = "Brief ready.";
    const file = writeTranscript(`${engine}-reported-brief.jsonl`, engine === "claude" ? [
      { type: "assistant", timestamp: "2026-07-18T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Previous turn." }] } },
      { type: "user", timestamp: "2026-07-18T10:01:00.000Z", message: { role: "user", content: "Write the brief." } },
      { type: "assistant", timestamp: before, message: { role: "assistant", content: [{ type: "text", text: brief }] } },
      { type: "assistant", timestamp: after, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: closing }] } },
    ] : [
      { timestamp: "2026-07-18T10:00:00.000Z", payload: { type: "agent_message", message: "Previous turn." } },
      { timestamp: "2026-07-18T10:01:00.000Z", payload: { type: "task_started" } },
      { timestamp: before, payload: { type: "agent_message", message: brief } },
      { timestamp: after, payload: { type: "agent_message", message: closing } },
      { timestamp: "2026-07-18T10:06:00.000Z", payload: { type: "task_complete", last_agent_message: closing } },
    ]);
    expect(await durableStageTurnEvidence(engine, file, "2026-07-18T10:03:00.000Z", "2026-07-18T10:01:00.000Z"))
      .toMatchObject({ turn: "terminal", message: { text: closing }, reportProse: brief });
  });

  for (const [caseName, briefLength, toolLength] of [
    ["one oversized assistant record", 150_000, 0],
    ["a later oversized tool result", 50_000, 100_000],
  ] as const) {
    test(`${engine} recovers the reported brief beyond the transcript tail after ${caseName}`, async () => {
      const brief = `BEGIN BRIEF\n${"b".repeat(briefLength)}\nEND BRIEF`;
      const tool = "t".repeat(toolLength);
      const file = writeTranscript(`${engine}-large-reported-brief-${briefLength}.jsonl`, engine === "claude" ? [
        { type: "user", timestamp: "2026-07-18T10:01:00.000Z", message: { role: "user", content: "Write the brief." } },
        { type: "assistant", timestamp: "2026-07-18T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: brief }] } },
        ...(toolLength ? [{ type: "user", timestamp: "2026-07-18T10:03:00.000Z", message: { role: "user", content: [{ type: "tool_result", content: tool }] } }] : []),
        { type: "assistant", timestamp: "2026-07-18T10:05:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
      ] : [
        { timestamp: "2026-07-18T10:01:00.000Z", payload: { type: "task_started" } },
        { timestamp: "2026-07-18T10:02:00.000Z", payload: { type: "agent_message", message: brief } },
        ...(toolLength ? [{ timestamp: "2026-07-18T10:03:00.000Z", payload: { type: "function_call_output", output: tool } }] : []),
        { timestamp: "2026-07-18T10:05:00.000Z", payload: { type: "agent_message", message: "Done." } },
        { timestamp: "2026-07-18T10:06:00.000Z", payload: { type: "task_complete", last_agent_message: "Done." } },
      ]);

      const tail = await readStableTailRecords(file);
      expect(tail).toMatchObject({ integrity: "complete", prefixTruncated: true });
      expect(tail.records.some((record) => JSON.stringify(record).includes("BEGIN BRIEF"))).toBe(false);
      expect(await durableStageTurnEvidence(engine, file, "2026-07-18T10:04:00.000Z", "2026-07-18T10:01:00.000Z"))
        .toMatchObject({ turn: "terminal", message: { text: "Done." }, reportProse: brief });
    });
  }

  test(`${engine} recovers an oversized final message after stage_report`, async () => {
    const brief = `BEGIN FINAL BRIEF\n${"f".repeat(150_000)}\nEND FINAL BRIEF`;
    const file = writeTranscript(`${engine}-large-final-brief.jsonl`, engine === "claude" ? [
      { type: "user", timestamp: "2026-07-18T10:01:00.000Z", message: { role: "user", content: "Write the brief." } },
      { type: "assistant", timestamp: "2026-07-18T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Short report prose." }] } },
      { type: "user", timestamp: "2026-07-18T10:03:00.000Z", message: { role: "user", content: [{ type: "tool_result", content: "Report accepted." }] } },
      { type: "assistant", timestamp: "2026-07-18T10:05:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: brief }] } },
    ] : [
      { timestamp: "2026-07-18T10:01:00.000Z", payload: { type: "task_started" } },
      { timestamp: "2026-07-18T10:02:00.000Z", payload: { type: "agent_message", message: "Short report prose." } },
      { timestamp: "2026-07-18T10:03:00.000Z", payload: { type: "function_call_output", output: "Report accepted." } },
      { timestamp: "2026-07-18T10:05:00.000Z", payload: { type: "agent_message", message: brief } },
      { timestamp: "2026-07-18T10:06:00.000Z", payload: { type: "task_complete" } },
    ]);

    const tail = await readStableTailRecords(file);
    expect(tail).toMatchObject({ integrity: "complete", prefixTruncated: true });
    expect(tail.records.some((record) => JSON.stringify(record).includes("BEGIN FINAL BRIEF"))).toBe(false);
    expect(await durableStageTurnEvidence(engine, file, "2026-07-18T10:04:00.000Z", "2026-07-18T10:01:00.000Z"))
      .toMatchObject({ turn: "terminal", message: { text: brief }, reportProse: "Short report prose." });
  });
}

test("a wider re-read that fails keeps the last complete read and its background-task hold", async () => {
  const brief = `BEGIN BRIEF\n${"b".repeat(150_000)}\nEND BRIEF`;
  const file = writeTranscript("claude-reread-fails.jsonl", [
    { type: "user", timestamp: "2026-07-18T10:01:00.000Z", message: { role: "user", content: "Write the brief." } },
    { type: "assistant", timestamp: "2026-07-18T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: brief }] } },
    {
      type: "user",
      timestamp: "2026-07-18T10:04:30.000Z",
      message: { role: "user", content: [{ tool_use_id: "toolu_bg1", type: "tool_result", content: "Command running in background with ID: bg1." }] },
      toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg1" },
    },
    { type: "assistant", timestamp: "2026-07-18T10:05:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
  ]);
  /* The transcript was appended between the first read and the wider one. */
  const reads: number[] = [];
  const appendedMeanwhile: typeof readStableTailRecords = async (pathname, nbytes = 131_072) => {
    reads.push(nbytes);
    return reads.length === 1 ? readStableTailRecords(pathname, nbytes) : { integrity: "uncertain", records: [] };
  };
  const evidence = await durableStageTurnEvidence("claude", file, "2026-07-18T10:04:00.000Z", "2026-07-18T10:01:00.000Z", appendedMeanwhile);
  expect(reads.length).toBe(2);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: "Done." }, reportProse: null });
  expect(evidence?.backgroundTasks?.map((task) => task.id)).toEqual(["bg1"]);
});

test("a report with no prose before it stops widening once the window reaches the attempt's start", async () => {
  const history = Array.from({ length: 200 }, (_, index) => ({
    type: "assistant",
    timestamp: new Date(Date.parse("2026-07-18T09:00:00.000Z") + index * 1_000).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: `Earlier turn ${index} ${"h".repeat(10_000)}` }] },
  }));
  const file = writeTranscript("claude-no-report-prose.jsonl", [
    ...history,
    { type: "user", timestamp: "2026-07-18T10:01:00.000Z", message: { role: "user", content: "Build it." } },
    { type: "user", timestamp: "2026-07-18T10:03:00.000Z", message: { role: "user", content: [{ type: "tool_result", content: "Report accepted." }] } },
    { type: "assistant", timestamp: "2026-07-18T10:05:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
  ]);
  expect(fs.statSync(file).size).toBeGreaterThan(2_000_000);
  const reads: number[] = [];
  const counted: typeof readStableTailRecords = async (pathname, nbytes = 131_072) => {
    reads.push(nbytes);
    return readStableTailRecords(pathname, nbytes);
  };
  expect(await durableStageTurnEvidence("claude", file, "2026-07-18T10:04:00.000Z", "2026-07-18T10:00:30.000Z", counted))
    .toMatchObject({ turn: "terminal", message: { text: "Done." }, reportProse: null });
  expect(reads).toEqual([131_072]);
});

test("the widening read stops at an absolute cap when nothing bounds it", async () => {
  const reads: number[] = [];
  const endless: typeof readStableTailRecords = async (_pathname, nbytes = 131_072) => {
    reads.push(nbytes);
    return {
      integrity: "complete",
      prefixTruncated: true,
      records: [{ type: "assistant", timestamp: "2026-07-18T10:05:00.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }],
    };
  };
  const file = writeTranscript("claude-capped.jsonl", [{ type: "user", timestamp: "2026-07-18T10:01:00.000Z", message: { role: "user", content: "Build it." } }]);
  for (const startedAt of ["2026-07-18T10:01:00.000Z", null]) {
    reads.length = 0;
    expect(await durableStageTurnEvidence("claude", file, "2026-07-18T10:04:00.000Z", startedAt, endless))
      .toMatchObject({ turn: "terminal", message: { text: "Done." }, reportProse: null });
    expect(Math.max(...reads)).toBe(MAX_REPORT_EVIDENCE_BYTES);
    expect(reads.length).toBeLessThanOrEqual(8);
  }
});

test("a one-record Codex launch transcript reports no agent progress (#1325)", async () => {
  const file = writeTranscript("codex-launch-only.jsonl", [
    { type: "session_meta", timestamp: "2026-08-31T09:00:00.000Z", payload: { originator: "synthetic" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    launchOnly: true,
    message: null,
  });
});

test("a one-record Codex user event reports transcript progress (#1325)", async () => {
  const file = writeTranscript("codex-user-only.jsonl", [
    { type: "event_msg", timestamp: "2026-08-31T09:00:01.000Z", payload: { type: "user_message", message: "begin" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    launchOnly: false,
  });
});

test("a truncated tail ending in session metadata does not grant launch-only evidence (#1325)", async () => {
  const file = path.join(dir, "codex-truncated-before-session-meta.jsonl");
  const earlierProgress = JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_reasoning", text: "x".repeat(140_000) },
  });
  const replayedMetadata = JSON.stringify({ type: "session_meta", payload: { originator: "synthetic" } });
  fs.writeFileSync(file, `${earlierProgress}\n${replayedMetadata}\n`, "utf8");

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    launchOnly: false,
  });
});

test("a Claude end-turn transcript yields terminal evidence with its final message", async () => {
  const file = writeTranscript("claude-terminal.jsonl", [
    { type: "user", timestamp: "2026-07-18T10:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T10:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
  expect(evidence!.message!.ts).toBe(Date.parse("2026-07-18T10:05:00.000Z"));
});

test("a mid-work Claude assistant message is busy, never terminal", async () => {
  const file = writeTranscript("claude-midwork.jsonl", [
    { type: "user", timestamp: "2026-07-18T10:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T10:01:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "midway through the fix" }] },
    },
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({ turn: "busy", message: { text: "midway through the fix" } });
});

test("a Codex task_complete transcript yields terminal evidence with the final agent message", async () => {
  const file = writeTranscript("codex-terminal.jsonl", [
    { timestamp: "2026-07-18T11:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T11:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T11:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
  ]);

  const evidence = await durableStageTurnEvidence("codex", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
  expect(evidence!.message!.ts).toBe(Date.parse("2026-07-18T11:05:00.000Z"));
});

test("a re-hosted Codex continuation settles after a tool call cut off in the prior turn (#1589)", async () => {
  const file = writeTranscript("codex-rehosted-continuation.jsonl", [
    { timestamp: "2026-09-09T05:36:42.000Z", type: "response_item", payload: { type: "function_call", call_id: "old-tool" } },
    { timestamp: "2026-09-09T05:38:44.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "continued-turn" } },
    { timestamp: "2026-09-09T05:40:17.000Z", type: "event_msg", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-09-09T05:40:18.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "continued-turn", last_agent_message: PASS_TEXT } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "terminal",
    message: { text: PASS_TEXT },
  });
});

test("a Codex tail window truncated above its own function_call stays busy (#1589)", async () => {
  /* The real shape behind the guard: a rollout whose single tool output is
     large enough that the 128 KiB window starts inside it, so the matching
     `function_call` is above the window and no boundary is visible. The last
     agent message parses as a verdict, so `unknown` here would hand the engine
     a settlement candidate over a transcript that is still mid-turn. */
  const file = path.join(dir, "codex-truncated-tool-output.jsonl");
  const rows = [
    JSON.stringify({ timestamp: "2026-09-09T07:30:00.000Z", type: "response_item", payload: { type: "function_call", call_id: "oversized" } }),
    /* Bulk that pushes the call out of the window; the read starts inside it. */
    JSON.stringify({ timestamp: "2026-09-09T07:30:01.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "r".repeat(200_000) } }),
    JSON.stringify({ timestamp: "2026-09-09T07:30:02.000Z", type: "event_msg", payload: { type: "agent_message", message: PASS_TEXT } }),
    JSON.stringify({ timestamp: "2026-09-09T07:30:03.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "oversized", output: "x".repeat(40_000) } }),
    JSON.stringify({ timestamp: "2026-09-09T07:30:04.000Z", type: "event_msg", payload: { type: "token_count" } }),
  ];
  fs.writeFileSync(file, rows.join("\n") + "\n", "utf8");

  const read = await readStableTailRecords(file);
  expect(read).toMatchObject({ integrity: "complete", prefixTruncated: true });
  expect(read.records.map((record) => (record.payload as { type: string }).type))
    .toEqual(["agent_message", "custom_tool_call_output", "token_count"]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "busy",
    message: { text: PASS_TEXT },
  });
});

test("a Codex turn with an open tool call is busy", async () => {
  const file = writeTranscript("codex-busy.jsonl", [
    { timestamp: "2026-07-18T11:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T11:01:00.000Z", payload: { type: "function_call", call_id: "call-1" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "busy" });
});

test("a Codex terminal verdict with trailing bookkeeping records stays terminal (#337 production shape)", async () => {
  /* The exact production tail: fenced verdict, task_complete, then bookkeeping
     records append after the turn ends — the scan holds jsonl_turn_stalled at
     this final size while the turn is durably terminal. */
  const file = writeTranscript("codex-terminal-bookkeeping.jsonl", [
    { timestamp: "2026-07-18T12:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T12:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T12:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
    { timestamp: "2026-07-18T12:05:01.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 52_144, output_tokens: 3_902 } } } },
  ]);

  const evidence = await durableStageTurnEvidence("codex", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
  expect(evidence!.message!.ts).toBe(Date.parse("2026-07-18T12:05:00.000Z"));
});

test("a Claude end-turn verdict with a trailing bookkeeping record stays terminal (#337 production shape)", async () => {
  const file = writeTranscript("claude-terminal-bookkeeping.jsonl", [
    { type: "user", timestamp: "2026-07-18T12:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T12:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
    { type: "file-history-snapshot", timestamp: "2026-07-18T12:05:01.000Z", snapshot: { trackedFileBackups: {} } },
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({ turn: "terminal", message: { text: PASS_TEXT } });
});

test("a Codex verdict whose turn still holds an open tool call is busy, never terminal", async () => {
  const file = writeTranscript("codex-open-tool-verdict.jsonl", [
    { timestamp: "2026-07-18T13:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T13:01:00.000Z", payload: { type: "function_call", call_id: "call-9" } },
    { timestamp: "2026-07-18T13:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T13:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "busy" });
});

test("a user record after a terminal Codex verdict reopens the turn as busy", async () => {
  const file = writeTranscript("codex-user-followup.jsonl", [
    { timestamp: "2026-07-18T14:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-07-18T14:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-07-18T14:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
    { timestamp: "2026-07-18T14:06:00.000Z", payload: { type: "user_message", message: "one more request before you stop" } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "busy" });
});

test("a user record after a terminal Claude verdict reopens the turn as busy", async () => {
  const file = writeTranscript("claude-user-followup.jsonl", [
    { type: "user", timestamp: "2026-07-18T14:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-07-18T14:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
    { type: "user", timestamp: "2026-07-18T14:06:00.000Z", message: { role: "user", content: "one more request" } },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "busy" });
});

test("a missing or torn artifact yields no durable evidence", async () => {
  expect(await durableStageTurnEvidence("claude", path.join(dir, "absent.jsonl"))).toBeNull();

  const torn = path.join(dir, "torn.jsonl");
  fs.writeFileSync(torn, '{"type":"assistant","message":{"stop_reason":"end_turn"\n', "utf8");
  expect(await durableStageTurnEvidence("claude", torn)).toBeNull();
});

/* #1141 — a provider limit cuts the turn off mid-flight, so the transcript's
   last record is the CLI's own notice and there is no verdict to read. The
   invented notices below are the two shapes the CLIs write; never copy a real
   transcript into a fixture. */
const CLAUDE_SESSION_LIMIT = "You've hit your session limit. Try again once the window resets.";

function claudeLimitRecord(timestamp: string, text = CLAUDE_SESSION_LIMIT): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp,
    isApiErrorMessage: true,
    error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text }] },
  };
}

test("a Claude turn cut off by a session limit reports the provider's notice as terminal evidence (#1141)", async () => {
  const file = writeTranscript("claude-session-limit.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:20:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "halfway through the fix" }] },
    },
    claudeLimitRecord("2026-08-27T09:41:00.000Z"),
  ]);

  const evidence = await durableStageTurnEvidence("claude", file);
  expect(evidence).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: { text: CLAUDE_SESSION_LIMIT },
  });
  expect(evidence!.terminalProviderMessage!.ts).toBe(Date.parse("2026-08-27T09:41:00.000Z"));
});

test("a limit notice under trailing bookkeeping records still closes the turn (#1141)", async () => {
  const file = writeTranscript("claude-session-limit-bookkeeping.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    claudeLimitRecord("2026-08-27T09:41:00.000Z"),
    { type: "file-history-snapshot", timestamp: "2026-08-27T09:41:01.000Z", snapshot: { trackedFileBackups: {} } },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: { text: CLAUDE_SESSION_LIMIT },
  });
});

test("a turn that ended on its own verdict carries no provider notice (#1141)", async () => {
  const file = writeTranscript("claude-verdict-no-notice.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:05:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] },
    },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({
    turn: "terminal",
    message: { text: PASS_TEXT },
    terminalProviderMessage: null,
  });
});

test("a silent mid-work transcript carries no provider notice (#1141)", async () => {
  const file = writeTranscript("claude-silent-midwork.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:02:00.000Z",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "reading the failing test" }] },
    },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "busy", terminalProviderMessage: null });
});

test("prose that merely quotes a limit notice is not one (#1141)", async () => {
  const file = writeTranscript("claude-quoted-limit.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    {
      type: "assistant",
      timestamp: "2026-08-27T09:05:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `The stage agent stopped on "${CLAUDE_SESSION_LIMIT}" last night.` }],
      },
    },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "terminal", terminalProviderMessage: null });
});

test("a prompt after the limit notice reopens the turn and withdraws the evidence (#1141)", async () => {
  const file = writeTranscript("claude-limit-then-prompt.jsonl", [
    { type: "user", timestamp: "2026-08-27T09:00:00.000Z", message: { role: "user", content: "prompt" } },
    claudeLimitRecord("2026-08-27T09:41:00.000Z"),
    { type: "user", timestamp: "2026-08-27T13:00:00.000Z", message: { role: "user", content: "carry on now that the window reset" } },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "busy", terminalProviderMessage: null });
});

test("a Codex turn refused for usage carries the provider's notice (#1141)", async () => {
  const file = writeTranscript("codex-usage-limit.jsonl", [
    { timestamp: "2026-08-27T10:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-08-27T10:04:00.000Z", payload: { type: "agent_message", message: "starting on the stage" } },
    {
      timestamp: "2026-08-27T10:05:00.000Z",
      payload: {
        type: "task_complete",
        error: { message: "You've hit your usage limit. Try again after reset.", codex_error_info: "usage_limit_exceeded" },
      },
    },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: { text: "You've hit your usage limit. Try again after reset." },
  });
});

test("a Codex usage-limit terminal record carries its governing reset (#1371)", async () => {
  const resetsAt = Math.floor(Date.parse("2026-09-07T10:05:00.000Z") / 1_000);
  const file = writeTranscript("codex-usage-limit-reset.jsonl", [
    { timestamp: "2026-08-31T10:00:00.000Z", payload: { type: "task_started" } },
    {
      timestamp: "2026-08-31T10:04:00.000Z",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 27, window_minutes: 10_080, resets_at: resetsAt },
          secondary: null,
          credits: { has_credits: true, balance: "0" },
          plan_type: "pro",
        },
      },
    },
    {
      timestamp: "2026-08-31T10:05:00.000Z",
      payload: {
        type: "task_complete",
        message: "You've hit your usage limit. Try again after the weekly reset.",
        codex_error_info: "usage_limit",
      },
    },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: {
      text: "You've hit your usage limit. Try again after the weekly reset.",
      usageLimit: { resetsAt },
    },
  });
});

test("a recorded Claude session-limit API error resolves its timestamped timezone reset", async () => {
  // Shape observed in a 2026-09-26 Claude stage transcript: the CLI writes a
  // synthetic assistant with error=rate_limit and stop_sequence, then appends
  // bookkeeping. Resolve the local clock from the notice's own timestamp.
  const file = writeTranscript("claude-session-limit.jsonl", [
    { type: "user", timestamp: "2026-09-26T11:24:17.140Z", message: { role: "user", content: "fix the stage" } },
    { type: "assistant", timestamp: "2026-09-26T11:27:59.577Z", message: { role: "assistant", content: [{ type: "text", text: "Working on the edit" }] } },
    {
      type: "assistant", timestamp: "2026-09-26T11:28:23.296Z", isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your session limit · resets 2:30pm (Europe/Kyiv)" }] },
    },
    { type: "cost-state", timestamp: "2026-09-26T11:28:23.300Z" },
  ]);

  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({
    turn: "terminal",
    terminalProviderMessage: {
      text: "You've hit your session limit · resets 2:30pm (Europe/Kyiv)",
      usageLimit: { resetsAt: Date.parse("2026-09-26T11:30:00Z") / 1_000 },
    },
  });
});

test.each([
  ["2026-10-02T00:16:00Z", "2:30pm (UTC)", "2026-10-02T14:30:00Z"],
  ["2026-10-02T23:16:00Z", "2:30pm (UTC)", "2026-10-03T14:30:00Z"],
  ["2026-10-02T23:16:00Z", "2:30am (Asia/Kolkata)", "2026-10-03T21:00:00Z"],
  ["2026-10-02T00:16:00Z", "12am (UTC)", "2026-10-03T00:00:00Z"],
  ["2026-10-02T00:16:00Z", "12pm (UTC)", "2026-10-02T12:00:00Z"],
  ["2026-10-02T00:16:00Z", "Oct 9 at 2:30pm (UTC)", "2026-10-09T14:30:00Z"],
  ["2026-12-31T00:16:00Z", "Jan 2, 2:30pm (UTC)", "2027-01-02T14:30:00Z"],
  ["2026-10-24T23:16:00Z", "3:30am (Europe/Kyiv)", "2026-10-25T01:30:00Z"],
  ["2026-03-29T00:16:00Z", "3:30am (Europe/Kyiv)", null],
  ["2026-10-02T00:16:00Z", "2:30pm", null],
  ["2026-10-02T00:16:00Z", "2:30pm (Unknown/Zone)", null],
  ["2026-10-02T00:16:00Z", "25:30 (UTC)", null],
  ["2026-10-02T00:16:00Z", "2:90pm (UTC)", null],
  ["2026-10-02T00:16:00Z", "Feb 30 at 2:30pm (UTC)", null],
  ["2026-10-02T00:16:00Z", "Oct 1, 2026 at 2:30pm (UTC)", null],
  ["invalid", "2:30pm (UTC)", null],
  ["2026-10-02T00:16:00", "2:30pm (UTC)", null],
] as const)("native Claude weekly reset at %s: %s", async (timestamp, label, expected) => {
  const file = writeTranscript("claude-weekly-reset.jsonl", [{
    type: "assistant", timestamp, isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: `You've hit your weekly limit · resets ${label}` }] },
  }]);
  expect((await durableStageTurnEvidence("claude", file))?.terminalProviderMessage?.usageLimit)
    .toEqual({ resetsAt: expected === null ? null : Date.parse(expected) / 1_000 });
});

test("Claude limit prose without the terminal rate-limit envelope is not capacity evidence", async () => {
  const file = writeTranscript("claude-quoted-limit.jsonl", [
    { type: "user", timestamp: "2026-09-26T11:24:17.140Z", message: { role: "user", content: "explain the incident" } },
    { type: "assistant", timestamp: "2026-09-26T11:28:23.296Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit · resets 2:30pm (Europe/Kyiv)" }] } },
  ]);
  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "terminal", terminalProviderMessage: null });
});

test("a generic terminal Claude API rate limit is not a session-capacity verdict", async () => {
  const file = writeTranscript("claude-generic-rate-limit.jsonl", [
    { type: "user", timestamp: "2026-09-26T11:24:17.140Z", message: { role: "user", content: "run the stage" } },
    { type: "assistant", timestamp: "2026-09-26T11:28:23.296Z", isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "Rate limit exceeded" }] } },
  ]);
  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({
    turn: "terminal", terminalProviderMessage: { text: "Rate limit exceeded" },
  });
  expect((await durableStageTurnEvidence("claude", file))?.terminalProviderMessage?.usageLimit).toBeUndefined();
});

test("a Codex turn that completed normally carries no provider notice (#1141)", async () => {
  const file = writeTranscript("codex-clean-complete.jsonl", [
    { timestamp: "2026-08-27T10:00:00.000Z", payload: { type: "task_started" } },
    { timestamp: "2026-08-27T10:04:00.000Z", payload: { type: "agent_message", message: PASS_TEXT } },
    { timestamp: "2026-08-27T10:05:00.000Z", payload: { type: "task_complete", last_agent_message: PASS_TEXT } },
  ]);

  expect(await durableStageTurnEvidence("codex", file)).toMatchObject({ turn: "terminal", terminalProviderMessage: null });
});

for (const [code, text, kind] of [
  ["rate_limit", "You've hit your weekly limit · resets 2:30pm", "usage_limit"],
  ["rate_limit", "You've hit your Opus limit", "usage_limit"],
  ["rate_limit", "You've reached your Fable limit", "usage_limit"],
  ["server_error", "Failed to refresh OAuth token: retry in a minute", "transient"],
  ["authentication_failed", "expired", "auth_required"],
  ["overloaded", "busy", "transient"],
] as const) {
  test(`terminal Claude ${code} carries its provider class: ${kind}`, async () => {
    const file = writeTranscript(`provider-${kind}-${text.length}.jsonl`, [
      { type: "user", timestamp: "2026-10-02T10:00:00Z", message: { role: "user", content: "continue" } },
      { type: "assistant", timestamp: "2026-10-02T10:01:00Z", isApiErrorMessage: true, error: code,
        message: { role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text }] } },
    ]);
    const evidence = await durableStageTurnEvidence("claude", file);
    expect(evidence?.terminalProviderMessage).toMatchObject({ errorClass: code });
    if (kind === "usage_limit") expect(evidence?.terminalProviderMessage?.usageLimit).toEqual({ resetsAt: null });
  });
}

for (const engine of ["codex", "claude"] as const) {
  test(`${engine} native aborted turn carries cut evidence and drops stale assistant output`, async () => {
    const file = writeTranscript(`${engine}-native-abort.jsonl`, engine === "codex" ? [
      { timestamp: "2026-10-02T10:00:00Z", type: "event_msg", payload: { type: "task_started" } },
      { timestamp: "2026-10-02T10:01:00Z", type: "event_msg", payload: { type: "agent_message", message: "unfinished edit" } },
      { timestamp: "2026-10-02T10:02:00Z", type: "event_msg", payload: { type: "turn_aborted" } },
    ] : [
      { timestamp: "2026-10-02T10:00:00Z", type: "user", message: { role: "user", content: "continue" } },
      { timestamp: "2026-10-02T10:01:00Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "unfinished edit" }] } },
      { timestamp: "2026-10-02T10:02:00Z", type: "user", interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } },
    ]);
    const evidence = await durableStageTurnEvidence(engine, file);
    expect(evidence).toMatchObject({ turn: "terminal", terminalProviderMessage: { errorClass: "turn_aborted", ts: Date.parse("2026-10-02T10:02:00Z") } });
  });
}

for (const code of ["authentication_failed", "rate_limit", "server_error"] as const) {
  test(`Claude shutdown recovery bookkeeping preserves the native ${code} failure`, async () => {
    const records = oauthFailureWithRecoveryTail();
    if (code === "rate_limit") records[1] = { ...records[1], error: code,
      message: { role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your weekly limit" }] } };
    if (code === "server_error") records[1] = { ...records[1], error: code,
      message: { role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: "Failed to refresh OAuth token: retry in a minute" }] } };
    const file = writeTranscript(`claude-${code}-recovery-tail.jsonl`, records);
    const evidence = await durableStageTurnEvidence("claude", file);
    expect(evidence).toMatchObject({ turn: "terminal", terminalProviderMessage: { errorClass: code } });
    if (code === "rate_limit") expect(evidence?.terminalProviderMessage?.usageLimit).toEqual({ resetsAt: null });
  });
}

test("a real Claude continuation cut is newer than an earlier provider failure", async () => {
  const records = oauthFailureWithRecoveryTail();
  records.splice(2, records.length - 2,
    { type: "user", timestamp: "2026-07-24T08:00:00Z", message: { role: "user", content: "Continue the stage after the account switch." } },
    { type: "user", timestamp: "2026-07-24T08:01:00Z", interruptedByShutdown: true,
      message: { role: "user", content: "[Request interrupted by user]" } });
  const file = writeTranscript("claude-real-continuation-cut.jsonl", records);
  expect(await durableStageTurnEvidence("claude", file)).toMatchObject({ turn: "terminal",
    terminalProviderMessage: { errorClass: "turn_aborted", ts: Date.parse("2026-07-24T08:01:00Z") } });
});


test("quota prompt provenance keeps human overrides and excludes tool results", async () => {
  const file = writeTranscript("quota-prompt-provenance.jsonl", [
    { type: "user", timestamp: "2026-10-05T16:56:00Z", origin: { kind: "task-notification" }, promptSource: "system", message: { content: "<task-notification>done</task-notification>" } },
    { type: "user", timestamp: "2026-10-05T16:56:01Z", origin: { kind: "human" }, turnOrigin: "task_notification", promptSource: "typed", message: { content: "<task-notification>human words</task-notification>" } },
    { type: "user", timestamp: "2026-10-05T16:56:02Z", message: { content: [{ type: "tool_result", content: "Tool finished" }] } },
    { type: "user", timestamp: "2026-10-05T16:56:03Z", origin: "task", message: { content: "Task finished" } },
    { type: "user", timestamp: "2026-10-05T16:56:04Z", origin: { kind: "task" }, message: { content: "Task finished" } },
    { type: "user", timestamp: "2026-10-05T16:56:05Z", origin: "task", promptSource: "typed", message: { content: "Wait for my review" } },
  ]);
  expect((await durableStageTurnEvidence("claude", file))?.prompts).toEqual([
    { ts: Date.parse("2026-10-05T16:56:00Z"), origin: "harness" },
    { ts: Date.parse("2026-10-05T16:56:01Z"), origin: "external" },
    { ts: Date.parse("2026-10-05T16:56:03Z"), origin: "harness" },
    { ts: Date.parse("2026-10-05T16:56:04Z"), origin: "harness" },
    { ts: Date.parse("2026-10-05T16:56:05Z"), origin: "external" },
  ]);
});

for (const engine of ["claude", "codex"] as const) {
  test.each(["before", "after"] as const)(`${engine} prompt order survives clock skew %s the cut`, async position => {
    const cut = Date.parse("2026-10-05T16:56:00Z");
    const promptAt = cut + (position === "before" ? 1 : -1);
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(promptAt).toISOString(), message: { content: "Please wait" } }
      : { type: "event_msg", timestamp: new Date(promptAt).toISOString(), payload: { type: "user_message", message: "Please wait" } };
    const notice = engine === "claude" ? { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const file = writeTranscript(`skewed-cut-${engine}-${position}.jsonl`, position === "before" ? [prompt, notice] : [notice, prompt, notice]);
    const evidence = await durableStageTurnEvidence(engine, file, undefined, new Date(cut - 1000).toISOString(), undefined, cut);
    expect(evidence?.externalPromptAfterCut).toBe(position === "after");
  });
}

for (const engine of ["claude", "codex"] as const) {
  for (const size of [150_000, 9 * 1024 * 1024]) {
    for (const firstTick of [false, true]) {
      test(`${engine} backdated context cannot hide a human reply (size=${size}, first=${firstTick})`, async () => {
        const cut = Date.parse("2026-10-05T16:56:00Z");
        const notice = (at: number) => engine === "claude" ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
          message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
          : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
        const prompt = engine === "claude" ? { type: "user", timestamp: new Date(cut + 1000).toISOString(), message: { content: "Wait for my review" } }
          : { type: "event_msg", timestamp: new Date(cut + 1000).toISOString(), payload: { type: "user_message", message: "Wait for my review" } };
        const file = writeTranscript(`backdated-${engine}-${size}-${firstTick}.jsonl`, [notice(cut), prompt,
          { type: "queue-operation", timestamp: new Date(cut + 1500).toISOString(), padding: "x".repeat(size) },
          { type: "turn_context", timestamp: new Date(cut - 500).toISOString() }, notice(cut + 2000)]);
        const evidence = await durableStageTurnEvidence(engine, file, undefined, new Date(cut - 1000).toISOString(), undefined, firstTick ? undefined : cut);
        if (size < 8 * 1024 * 1024) expect(evidence).toMatchObject({ promptHistoryComplete: true, externalPromptAfterCut: true, firstProviderCutAt: cut });
        else expect(evidence?.promptHistoryComplete).toBe(false);
      });
    }
  }
  test(`${engine} first provider cut follows native order when timestamps run backward`, async () => {
    const cut = Date.parse("2026-10-05T16:56:00Z");
    const notice = (at: number) => engine === "claude" ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(cut - 10).toISOString(), message: { content: "Wait for me" } }
      : { type: "event_msg", timestamp: new Date(cut - 10).toISOString(), payload: { type: "user_message", message: "Wait for me" } };
    const file = writeTranscript(`backward-cuts-${engine}.jsonl`, [notice(cut), prompt, notice(cut - 20)]);
    expect(await durableStageTurnEvidence(engine, file, undefined, new Date(cut - 1000).toISOString()))
      .toMatchObject({ firstProviderCutAt: cut, externalPromptAfterCut: true });
  });
}

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} a native append between verified evidence and authorship join remains uncertain`, async () => {
    const cut = Date.parse("2026-10-05T16:56:00Z");
    const text = "Continue the same stage";
    const notice = engine === "claude" ? { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const prompt = engine === "claude" ? { type: "user", uuid: "raced-pipeline-prompt", timestamp: new Date(cut + 1000).toISOString(), message: { content: text } }
      : { type: "event_msg", timestamp: new Date(cut + 1000).toISOString(), payload: { type: "user_message", message: (await import("@/lib/runtime/codexStructuredUserText.server")).encodeCodexStructuredUserText(text, undefined, null, { kind: "agent", role: "pipeline" }) } };
    const file = writeTranscript(`raced-authorship-${engine}.jsonl`, [notice]);
    fs.appendFileSync(file, JSON.stringify(prompt) + "\n");
    if (engine === "claude") {
      const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const session = path.basename(file, ".jsonl");
      ledger.recordQueued(session, { id: "raced-send", text, origin: { kind: "agent", role: "pipeline" } }, "turn-started");
      ledger.confirmDelivered(session, "raced-send", "raced-pipeline-prompt");
    }
    const raced: typeof readStableTailRecords = async (pathname, bytes) => {
      const snapshot = await readStableTailRecords(pathname, bytes);
      fs.appendFileSync(file, JSON.stringify({ type: "turn_context", timestamp: new Date(cut + 2000).toISOString() }) + "\n");
      return snapshot;
    };
    expect(await durableStageTurnEvidence(engine, file, undefined, undefined, raced, cut)).toBeNull();
    expect((await durableStageTurnEvidence(engine, file, undefined, undefined, undefined, cut))?.prompts)
      .toEqual([{ ts: cut + 1000, origin: "pipeline" }]);
  });
}
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} large historical prefix preserves a recent named cut (human=%s)`, async human => {
    const cut = Date.parse("2026-10-05T10:00:00Z");
    const reset = cut / 1000 + 3600;
    const notice = engine === "claude" ? { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit · resets 11am (UTC)" }] } }
      : { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete",
        error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(cut - 1).toISOString(), message: { content: "Wait for my review" } }
      : { type: "event_msg", timestamp: new Date(cut - 1).toISOString(), payload: { type: "user_message", message: "Wait for my review" } };
    const observation = { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "token_count",
      rate_limits: { primary: { used_percent: 100, resets_at: reset } } } };
    const records = engine === "claude" ? human ? [notice, prompt, notice] : [notice]
      : human ? [observation, notice, prompt, observation, notice] : [observation, notice];
    const file = writeTranscript(`large-prefix-${engine}-${human}.jsonl`, records);
    const recent = fs.readFileSync(file);
    const old = JSON.stringify({ type: "turn_context", timestamp: new Date(cut - 86400000).toISOString(), padding: "x".repeat(1100) }) + "\n";
    fs.writeFileSync(file, old.repeat(8500));
    fs.appendFileSync(file, recent);
    const first = await durableStageTurnEvidence(engine, file, undefined, new Date(cut - 1000).toISOString());
    expect(first?.promptHistoryComplete).toBe(true);
    expect(first?.externalPromptAfterCut).toBe(human);
    expect(first?.terminalProviderMessage?.usageLimit?.resetsAt).toBe(reset);
    const again = await durableStageTurnEvidence(engine, file, undefined, new Date(cut - 1000).toISOString(), undefined,
      first!.terminalProviderMessage!.ts);
    expect(again?.promptHistoryComplete).toBe(true);
  });
  test(`${engine} large relevant history with backdated rows remains incomplete`, async () => {
    const cut = Date.parse("2026-10-05T10:00:00Z");
    const notice = engine === "claude" ? { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit",
      message: { stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(cut - 1).toISOString(), message: { content: "Wait for my review" } }
      : { type: "event_msg", timestamp: new Date(cut - 1).toISOString(), payload: { type: "user_message", message: "Wait for my review" } };
    const file = writeTranscript(`large-relevant-${engine}.jsonl`, [notice, prompt]);
    const old = JSON.stringify({ type: "turn_context", timestamp: new Date(cut - 86400000).toISOString(), padding: "x".repeat(1100) }) + "\n";
    fs.appendFileSync(file, old.repeat(8500) + JSON.stringify(notice) + "\n");
    expect((await durableStageTurnEvidence(engine, file, undefined, new Date(cut - 1000).toISOString()))?.promptHistoryComplete).toBe(false);
  });
}

for (const engine of ["claude", "codex"] as const) {
  const cut = Date.parse("2026-10-05T17:22:09Z");
  const notice = (at: number) => engine === "claude" ? { type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
    message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
    : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_complete", error: { message: "usage limit", codex_error_info: "usage_limit_exceeded" } } };
  const prompt = (at: number, text: string) => engine === "claude" ? { type: "user", timestamp: new Date(at).toISOString(), message: { content: text } }
    : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "user_message", message: text } };
  const output = (at: number) => engine === "claude" ? { type: "assistant", timestamp: new Date(at).toISOString(), message: { model: "claude-opus", stop_reason: "end_turn", content: [{ type: "text", text: "Reviewed" }] } }
    : { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Reviewed" } };
  const later = cut + 4 * 3600_000;
  const startedAt = new Date(cut - 1000).toISOString();

  test(`${engine} agent output closes a cut chain and the next cut opens its own`, async () => {
    const closed = writeTranscript(`chain-closed-${engine}.jsonl`, [notice(cut), prompt(cut + 1000, "Continue reviewing"), output(cut + 2000), notice(later)]);
    expect(await durableStageTurnEvidence(engine, closed, undefined, startedAt, undefined, cut))
      .toMatchObject({ firstProviderCutAt: later, externalPromptAfterCut: false, requestedCutOpen: false, promptHistoryComplete: true });
    const open = writeTranscript(`chain-open-${engine}.jsonl`, [notice(cut), prompt(cut + 1000, "Wait for my answer"), notice(cut + 1500)]);
    expect(await durableStageTurnEvidence(engine, open, undefined, startedAt, undefined, cut + 1500))
      .toMatchObject({ firstProviderCutAt: cut, externalPromptAfterCut: true, requestedCutOpen: true, promptHistoryComplete: true });
  });

  test(`${engine} a zero-time request names the chain open since the attempt start`, async () => {
    const inherited = writeTranscript(`chain-zero-open-${engine}.jsonl`, [notice(cut), prompt(cut + 1000, "Continue"), notice(cut + 1500)]);
    expect(await durableStageTurnEvidence(engine, inherited, undefined, startedAt, undefined, 0))
      .toMatchObject({ firstProviderCutAt: cut, requestedCutOpen: true });
    const worked = writeTranscript(`chain-zero-closed-${engine}.jsonl`, [notice(cut), prompt(cut + 1000, "Continue"), output(cut + 2000), notice(later)]);
    expect(await durableStageTurnEvidence(engine, worked, undefined, startedAt, undefined, 0))
      .toMatchObject({ firstProviderCutAt: later, externalPromptAfterCut: false, requestedCutOpen: false });
  });

  test(`${engine} the verified window measures from the open chain past a large closed history`, async () => {
    const filler = { type: "queue-operation", timestamp: new Date(cut + 3000).toISOString(), padding: "x".repeat(1100) };
    const records = [notice(cut), prompt(cut + 1000, "Continue reviewing"), output(cut + 2000),
      ...Array.from({ length: 8500 }, () => filler), notice(later), prompt(later + 1000, "Wait for my review"), notice(later + 1500)];
    const file = writeTranscript(`chain-window-${engine}.jsonl`, records);
    expect(fs.statSync(file).size).toBeGreaterThan(MAX_REPORT_EVIDENCE_BYTES);
    expect(await durableStageTurnEvidence(engine, file, undefined, startedAt, undefined, cut))
      .toMatchObject({ firstProviderCutAt: later, externalPromptAfterCut: true, requestedCutOpen: false, promptHistoryComplete: true });
    expect(await durableStageTurnEvidence(engine, file, undefined, startedAt, undefined, later + 1500))
      .toMatchObject({ firstProviderCutAt: later, externalPromptAfterCut: true, requestedCutOpen: true, promptHistoryComplete: true });
  });
}
