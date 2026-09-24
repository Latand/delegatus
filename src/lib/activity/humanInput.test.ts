import { describe, expect, test } from "bun:test";

import {
  candidateFor,
  canonicalTextHash,
  classifyUserRecord,
  claudeSessionKind,
  codexSessionKind,
  dedupeCandidates,
  exportLines,
  FALLBACK_WINDOW_MS,
  ledgerRequestId,
  ledgerRowKey,
  mergeHumanInputs,
  parseClaudeUserRecord,
  parseCodexUserRecord,
  parseExportLine,
  requestKey,
  type HumanInput,
  type TranscriptContext,
  type UserRecord,
} from "./humanInput";

/* Invented records only: projects, ids and words below exist nowhere. */

const AT = Date.parse("2026-09-22T09:00:00Z");
const iso = (offsetSec: number) => new Date(AT + offsetSec * 1000).toISOString();
/** An operator-origin marker; each delivery carries its own key. */
const mark = (key: string) => `<!-- llv:structured-user ctx=o.${key.padEnd(43, "A")}.${"B".repeat(16)} -->\n`;
const OPERATOR_MARK = mark("K0");
const AGENT_MARK = `<!-- llv:structured-user ctx=a.${"C".repeat(43)}.${"D".repeat(16)} -->\n`;

function context(overrides: Partial<TranscriptContext> = {}): TranscriptContext {
  return { host: "stage", project: "client-a", conversation: "conv-1", session: "delegatus", launch: "operator", ...overrides };
}

function codex(text: string, id: string | null = "item-1", offsetSec = 0): UserRecord {
  return parseCodexUserRecord({
    timestamp: iso(offsetSec),
    type: "response_item",
    payload: { type: "message", role: "user", ...(id ? { id } : {}), content: [{ type: "input_text", text }] },
  })!;
}

function claude(text: string, fields: Record<string, unknown> = {}, offsetSec = 0): UserRecord {
  return parseClaudeUserRecord({
    type: "user",
    timestamp: iso(offsetSec),
    uuid: "uuid-1",
    promptId: "prompt-1",
    message: { role: "user", content: text },
    ...fields,
  })!;
}

describe("only real operator input counts", () => {
  test("marker-only counting: the operator-origin marker is the positive signal, unmarked records are excluded", () => {
    expect(classifyUserRecord(codex(`${OPERATOR_MARK}Ship the invoice export`), context(), false)).toEqual({ human: true, kind: "message", surface: "unknown" });
    expect(classifyUserRecord(codex(`<!-- llv:structured-user sha256=${"e".repeat(64)} origin=operator -->\nShip it`), context(), false)).toMatchObject({ human: true });
    expect(classifyUserRecord(codex("Ship the invoice export"), context(), false)).toEqual({ human: false, reason: "unmarked" });
    /* An interactive session's unmarked prompt is excluded too, and counted. */
    expect(classifyUserRecord(codex("Ship the invoice export"), context({ session: "interactive", launch: null }), false)).toEqual({ human: false, reason: "unmarked" });
  });

  test("a worker-to-manager message that arrives with role=user is excluded", () => {
    expect(classifyUserRecord(codex(`${AGENT_MARK}Builder finished: tests green, PR opened`), context(), false)).toEqual({ human: false, reason: "agent-message" });
    /* A Claude delivery the host's provenance attributes to an agent. */
    const relay = claude("Review round 2 findings attached", { promptSource: "sdk" });
    expect(classifyUserRecord(relay, context({ deliveryOrigin: () => ({ origin: "agent" }) }), false)).toEqual({ human: false, reason: "agent-message" });
    /* The same delivery attributed to the operator counts, carrying its request key. */
    expect(classifyUserRecord(relay, context({ deliveryOrigin: () => ({ origin: "operator", idempotencyKey: "client-msg-7" }) }), false))
      .toEqual({ human: true, kind: "message", surface: "unknown", idempotencyKey: "client-msg-7" });
  });

  test("the engine's own typed-by-a-person flag is a positive signal", () => {
    expect(classifyUserRecord(claude("rename the column", { promptSource: "typed", entrypoint: "cli" }), context({ session: "interactive", launch: null }), false))
      .toEqual({ human: true, kind: "message", surface: "terminal" });
  });

  test("generated prompts, notifications, hints and screenshots are excluded by reason", () => {
    const cases: Array<[UserRecord, TranscriptContext, boolean, string]> = [
      [codex(`${OPERATOR_MARK}You are a Reviewer. Review the diff…`), context({ launch: "pipeline" }), true, "stage-template"],
      [codex("You are a Builder in plain mode…"), context({ launch: "agent" }), true, "scaffold"],
      [codex("You are a Scribe. Draft the notes…"), context({ launch: "operator" }), true, "scaffold"],
      [claude("<task-notification>seat tick</task-notification>"), context(), false, "notification"],
      [claude("resume note", { promptSource: "system" }), context(), false, "notification"],
      [claude("This session is being continued from a previous conversation that ran out of context."), context(), false, "notification"],
      [claude("<system-reminder>skill hint</system-reminder>"), context(), false, "injected"],
      [codex("# AGENTS.md instructions for the repo"), context(), true, "injected"],
      [claude("[Image: original 1280x800]", { isMeta: true }), context(), false, "attachment"],
      [claude("[Request interrupted by user]"), context(), false, "interrupt"],
      [claude("explore the schema", { isSidechain: true }), context(), false, "subagent"],
      [codex(`${OPERATOR_MARK}ignored`), context({ session: "automation" }), false, "automation"],
    ];
    for (const [rec, ctx, first, reason] of cases) expect(classifyUserRecord(rec, ctx, first)).toEqual({ human: false, reason: reason as never });
  });

  test("sessions are classified from their own first records", () => {
    expect(codexSessionKind({ originator: "codex_exec", source: "exec" })).toBe("automation");
    expect(codexSessionKind({ originator: "llv-structured-host", source: { subagent: { thread_spawn: {} } } })).toBe("subagent");
    expect(codexSessionKind({ originator: "llv-structured-host", source: "vscode" })).toBe("delegatus");
    expect(codexSessionKind({ originator: "codex_desktop_app", source: "cli" })).toBe("interactive");
    expect(claudeSessionKind("cli", false)).toBe("interactive");
    expect(claudeSessionKind("sdk-cli", true)).toBe("delegatus");
    expect(claudeSessionKind("sdk-cli", false)).toBe("automation");
  });
});

describe("copies of one input count once", () => {
  const human = { kind: "message" as const, surface: "unknown" as const };
  const candidate = (rec: UserRecord, conversation: string, host = "stage") => candidateFor(rec, context({ conversation, host }), human);

  test("a shared-mirror copy and an account-store copy share the prompt id", () => {
    const original = claude("move the cron to 06:00", { uuid: "uuid-9", promptId: "prompt-9" });
    const mirror = claude("move the cron to 06:00", { uuid: "uuid-9", promptId: "prompt-9" });
    const inputs = dedupeCandidates([candidate(original, "accounts/a/projects/x.jsonl"), candidate(mirror, "shared/projects/x.jsonl")]);
    expect(inputs).toHaveLength(1);
  });

  test("a continuation that copies history with the event ids counts it once", () => {
    const first = codex(`${mark("K42")}rerun the migration`, "item-42", 0);
    const resumed = codex(`${mark("K42")}rerun the migration`, "item-42", 0);
    const later = codex(`${mark("K43")}now deploy to stage`, "item-43", 600);
    const inputs = dedupeCandidates([candidate(first, "rollout-a"), candidate(resumed, "rollout-b"), candidate(later, "rollout-b")]);
    expect(inputs.map((input) => input.at)).toEqual([AT, AT + 600_000]);
  });

  test("id-less copies within 90 s count once, and further apart count twice", () => {
    /* Copies with no event id and no delivery marker: a pasted prompt typed in a terminal. */
    const typed = (text: string, offsetSec: number) => claude(text, { uuid: undefined, promptId: undefined, promptSource: "typed" }, offsetSec);
    const a = typed("check the payout totals", 0);
    const near = typed("check the payout  totals ", 80);
    const far = typed("check the payout totals", 80 + FALLBACK_WINDOW_MS / 1000 + 5);
    expect(a.messageId).toBeNull();
    expect(dedupeCandidates([candidate(a, "one"), candidate(near, "two")])).toHaveLength(1);
    expect(dedupeCandidates([candidate(a, "one"), candidate(far, "two")])).toHaveLength(2);
  });

  test("two messages of one conversation with their own ids stay two, whatever they say", () => {
    const yes = codex(`${mark("K1")}yes`, "item-1", 0);
    const again = codex(`${mark("K2")}yes`, "item-2", 30);
    expect(dedupeCandidates([candidate(yes, "same"), candidate(again, "same")])).toHaveLength(2);
  });

  test("a fan-out to three conversations within 90 s is one input", () => {
    const copies = ["w1", "w2", "w3"].map((conversation, index) => candidate(codex(`${mark(`F${index}`)}pull main and rebase`, `item-${conversation}`, index * 20), conversation));
    expect(dedupeCandidates(copies)).toHaveLength(1);
  });

  test("the same message in stores on two hosts is one input; a host's ledger wins over its delivered transcript copies", () => {
    const hash = canonicalTextHash("tag the release");
    const input = (host: string, source: HumanInput["source"], at: number, ids: string[], surface: HumanInput["surface"] = "unknown"): HumanInput =>
      ({ ids, at, host, source, project: "client-a", kind: "message", surface, hash: source === "ledger" ? null : hash });
    /* Same prompt id on both hosts. */
    expect(mergeHumanInputs([input("stage", "transcripts", AT, ["m:1".padEnd(66, "0")]), input("local", "transcripts", AT + 1000, ["m:1".padEnd(66, "0")])], new Map())).toHaveLength(1);
    /* No id in common: the content hash within 90 s on another host. */
    expect(mergeHumanInputs([input("stage", "transcripts", AT, ["m:a".padEnd(66, "0")]), input("local", "transcripts", AT + 60_000, ["m:b".padEnd(66, "0")])], new Map())).toHaveLength(1);
    /* A ledger row and the transcript record of the same request share its key. */
    const key = ledgerRowKey("client-msg-7");
    expect(requestKey("client-msg-7")).toBe(ledgerRequestId(key));
    expect(mergeHumanInputs([input("local", "ledger", AT, [ledgerRequestId(key)], "desktop"), input("stage", "transcripts", AT + 2000, [requestKey("client-msg-7")])], new Map())).toHaveLength(1);
    /* Inside the local ledger's span its delivered transcript copies are dropped; a terminal prompt stays. */
    const merged = mergeHumanInputs([
      input("local", "transcripts", AT + 5000, ["m:c".padEnd(66, "0")], "unknown"),
      input("local", "transcripts", AT + 9000, ["m:d".padEnd(66, "0")], "terminal"),
    ], new Map([["local", [{ start: AT - 1, end: AT + 3_600_000 }]]]));
    expect(merged.map((row) => row.surface)).toEqual(["terminal"]);
  });
});

describe("export rows carry no text", () => {
  test("a round trip keeps ids, hash, time, host, project, kind and surface only", () => {
    const rec = codex(`${OPERATOR_MARK}invoice INV-0042 for the harbor client`, "item-77");
    const [input] = dedupeCandidates([candidateFor(rec, context(), { kind: "message", surface: "unknown" })]);
    const text = exportLines({ host: "stage", coveredFrom: AT - 1, coveredUntil: AT + 1, exportedAt: AT + 2, records: 3, excluded: { unmarked: 2 } }, [input!]);
    expect(text).not.toContain("invoice");
    expect(text).not.toContain("item-77");
    const [manifest, event] = text.trim().split("\n").map(parseExportLine);
    expect(manifest).toMatchObject({ type: "manifest", host: "stage", excluded: { unmarked: 2 } });
    expect(Object.keys(event!).sort()).toEqual(["at", "hash", "host", "ids", "kind", "project", "surface", "type", "v"]);
    expect(parseExportLine(JSON.stringify({ ...event, text: "leak" }))).not.toHaveProperty("text");
  });
});
