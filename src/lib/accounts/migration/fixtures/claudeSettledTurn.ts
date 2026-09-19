/**
 * The record shapes behind issue #1792: an ordinary Claude turn that ENDED.
 *
 * Claude's CLI never writes a top-level `result` record into a session
 * transcript — that record only exists in `--print` stream output — so a
 * settled turn's own last bytes are an assistant record carrying
 * `stop_reason: "end_turn"`, sometimes followed by the harness bookkeeping the
 * CLI appends after the provider is done (the AI title, the latch, the mode
 * marker). Modelled field by field on live transcripts so the turn projection
 * regresses against the real envelope; every identifier and body is synthetic.
 */

export type TranscriptRecord = Record<string, unknown>;

const CWD = "/workspace/demo";
const SESSION_ID = "session-settled-turn";

function envelope(timestamp: string, uuid: string, parentUuid: string | null): TranscriptRecord {
  return {
    parentUuid,
    isSidechain: false,
    uuid,
    timestamp,
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: CWD,
    sessionId: SESSION_ID,
    version: "2.1.0",
    gitBranch: "main",
  };
}

export function promptRecord(timestamp: string): TranscriptRecord {
  return {
    ...envelope(timestamp, "rec-prompt", null),
    promptId: "prompt-settled-turn",
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Summarise the repository layout." }] },
  };
}

/** The assistant record that asks for a tool: the turn continues past it. */
export function toolUseRecord(timestamp: string): TranscriptRecord {
  return {
    ...envelope(timestamp, "rec-tool-use", "rec-prompt"),
    type: "assistant",
    apiBlockIndex: 0,
    requestId: "req-tool-use",
    message: {
      id: "msg-tool-use",
      model: "claude-opus-5",
      role: "assistant",
      type: "message",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [{ type: "tool_use", id: "toolu-1", name: "Read", input: { file_path: `${CWD}/README.md` } }],
    },
  };
}

export function toolResultRecord(timestamp: string): TranscriptRecord {
  return {
    ...envelope(timestamp, "rec-tool-result", "rec-tool-use"),
    promptId: "prompt-settled-turn",
    type: "user",
    sourceToolAssistantUUID: "rec-tool-use",
    toolUseResult: { type: "text", file: { filePath: `${CWD}/README.md` } },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "# Demo" }] },
  };
}

/** The provider's own end-of-turn evidence: the last assistant record of a
    finished turn, with no `result` record anywhere behind it. */
export function endTurnRecord(timestamp: string): TranscriptRecord {
  return {
    ...envelope(timestamp, "rec-end-turn", "rec-tool-result"),
    type: "assistant",
    apiBlockIndex: 1,
    requestId: "req-end-turn",
    message: {
      id: "msg-end-turn",
      model: "claude-opus-5",
      role: "assistant",
      type: "message",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "The repository has one package and a docs directory." }],
    },
  };
}

/** Harness bookkeeping appended after the provider finished. Carries no turn
    evidence of its own and must not disturb the verdict above. */
export function bookkeepingRecords(timestamp: string): TranscriptRecord[] {
  return [
    { type: "ai-title", timestamp, title: "Repository layout", sessionId: SESSION_ID },
    { type: "atis-latch", timestamp, sessionId: SESSION_ID },
  ];
}

export const SETTLED_TURN_ENDED_AT = "2026-09-19T02:46:20.000Z";

/** A transcript whose last provider record ended the turn — the shape every
    settled Claude conversation on disk has. */
export function settledClaudeTurnRecords(): TranscriptRecord[] {
  return [
    promptRecord("2026-09-19T02:40:00.000Z"),
    toolUseRecord("2026-09-19T02:41:00.000Z"),
    toolResultRecord("2026-09-19T02:41:02.000Z"),
    endTurnRecord(SETTLED_TURN_ENDED_AT),
    ...bookkeepingRecords("2026-09-19T02:46:21.000Z"),
  ];
}

/** The same conversation one record earlier: a tool call is outstanding, so the
    turn is genuinely still running. */
export function runningClaudeTurnRecords(): TranscriptRecord[] {
  return [
    promptRecord("2026-09-19T02:40:00.000Z"),
    toolUseRecord("2026-09-19T02:41:00.000Z"),
  ];
}

/** One record of a SPLIT parallel-tool message.
 *
 * When the provider asks for several tools at once, the CLI writes one record
 * per content block — same `message.id`, rising `apiBlockIndex` — and every one
 * of them carries the whole message's `end_turn` stop reason while its own tool
 * call is still outstanding. The stop reason is therefore not on its own a
 * statement that no tool work is pending; the block the record carries is. */
export function parallelToolBlockRecord(timestamp: string): TranscriptRecord {
  return {
    ...envelope(timestamp, "rec-parallel-block", "rec-prompt"),
    type: "assistant",
    apiBlockIndex: 2,
    requestId: "req-parallel",
    message: {
      id: "msg-parallel",
      model: "claude-opus-5",
      role: "assistant",
      type: "message",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "tool_use", id: "toolu-parallel", name: "Grep", input: { pattern: "demo" } }],
    },
  };
}

/** A transcript whose last record is one block of such a message: the stop
    reason says the message ended, the outstanding tool call says the turn did
    not, and the turn is the thing a queued send waits on. */
export function outstandingToolClaudeTurnRecords(): TranscriptRecord[] {
  return [
    promptRecord("2026-09-19T02:40:00.000Z"),
    parallelToolBlockRecord("2026-09-19T02:41:00.000Z"),
  ];
}

/** One JSONL transcript body from a record list. */
export function transcriptBody(records: TranscriptRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}
