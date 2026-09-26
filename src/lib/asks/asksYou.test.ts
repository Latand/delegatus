import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { attentionId, attentionReason } from "@/components/attention";
import { conversationNeedText, decisionLine } from "@/components/attention/decision";
import { askHref } from "@/components/orchestrator/reportLog/reportLogModel";
import { readProjectReportLog } from "@/lib/bridge/reportLog";
import { translate, type TFunction } from "@/lib/i18n";
import { finalAssistantMessageFromRecords, type FinalAssistantMessage } from "@/lib/scanner/lastAssistantMessage";
import type { FileEntry } from "@/lib/types";

import { classifierText, classifyWithJev, JEV_INPUT_PRICE_USD, JevError, jevCostCeilingUsd, type JevVerdict } from "./jev";
import { overlayOperatorAsks } from "./overlay";
import { readAsksYouSettings, writeAsksYouSettings } from "./settings";
import { loadOperatorAsks, mutateOperatorAsks, OperatorAsksUnreadable, operatorAsksSignature, projectReportLogAsks, readOperatorAsks } from "./store";
import { runAskSweep, type AskCandidate, type AskSweepPorts } from "./sweep";

/*
 * "Asks you" end to end, with the classifier stubbed (docs/research/attention-classifier.md
 * §7): the sweep sends the last message of a turn, the answer lands in the
 * store, `/api/files` stamps it on the conversation, the reason model names it
 * on the card, and the project's report log carries one line whose link opens
 * that conversation.
 */

const t: TFunction = (key, params) => translate("en", key, params);
const tUk: TFunction = (key, params) => translate("uk", key, params);

const PROJECT = "repo-widgets";
const CONVERSATION = "conv-builder-1";
const TRANSCRIPT = "/transcripts/builder.jsonl";
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const MESSAGE_AT = NOW - 60_000;
const ASKING = "The migration is ready on the branch and the checks are green.\n\nShould I merge it now, or wait for the review round?";
const ROUTINE = "Ran the suite again; all 42 tests pass and the branch is pushed. Moving on to the next file.";

let stateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-asks-you-"));
  process.env.LLV_STATE_DIR = stateDir;
  writeAsksYouSettings({ enabled: true }, new Date(NOW - 3_600_000));
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function candidate(overrides: Partial<AskCandidate> = {}): AskCandidate {
  return {
    subject: CONVERSATION,
    conversationId: CONVERSATION,
    path: TRANSCRIPT,
    project: PROJECT,
    role: "builder",
    title: "Migrate the ledger",
    working: false,
    structuredAsk: false,
    lastTurnStartedAt: MESSAGE_AT - 120_000,
    ...overrides,
  };
}

function message(text: string, overrides: Partial<FinalAssistantMessage> = {}): FinalAssistantMessage {
  return { id: "claude:msg-1", text, ts: MESSAGE_AT, engineError: false, ...overrides };
}

function verdict(score: number, costUsd = 0.00004): JevVerdict {
  return { score, answers: { asks: score, waiting: 0.1, decision: 0.1 }, costUsd, inputTokens: 900 };
}

/** The ports production wires, over the real store, with the classifier stubbed. */
function ports(overrides: Partial<AskSweepPorts> & { text?: string; classify?: AskSweepPorts["classify"] } = {}): AskSweepPorts & { calls: string[] } {
  const calls: string[] = [];
  const text = overrides.text ?? ASKING;
  const classify = overrides.classify ?? (async () => verdict(0.93));
  return {
    now: () => new Date(NOW),
    settings: () => readAsksYouSettings(),
    enabledSince: NOW - 3_600_000,
    apiKey: "test-key",
    candidates: [candidate()],
    finalMessage: () => message(text),
    read: () => loadOperatorAsks(undefined, new Date(NOW)),
    write: (mutation) => { mutateOperatorAsks(mutation, new Date(NOW)); },
    ...overrides,
    classify: async (body, key) => {
      calls.push(body);
      return classify(body, key);
    },
    calls,
  };
}

/** The conversation's board entry as `/api/files` builds it, turn ended. */
function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: TRANSCRIPT,
    root: "claude-projects",
    name: "builder.jsonl",
    project: PROJECT,
    title: "Migrate the ledger",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: MESSAGE_AT / 1000,
    size: 10,
    activity: "recent",
    proc: "running",
    pid: null,
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: CONVERSATION,
    lastTurn: { startedAt: MESSAGE_AT - 120_000, endedAt: MESSAGE_AT },
    lastAssistantMessageAt: MESSAGE_AT,
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null, memberships: [] },
    ...overrides,
  } as FileEntry;
}

function projected(file: FileEntry = entry()): FileEntry {
  overlayOperatorAsks([file]);
  return file;
}

function reportLog() {
  return readProjectReportLog({ project: PROJECT }, {
    knownCards: () => new Map(),
    asks: (inProject, since, limit) => projectReportLogAsks(inProject, since, limit),
    asksRevision: () => operatorAsksSignature(),
  });
}

describe("an agent whose turn ends asking the operator", () => {
  test("raises an «asks you» reason on its card and one report-log line that opens its conversation", async () => {
    const sweep = ports();
    const result = await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(result.asks).toHaveLength(1);

    const file = projected();
    const reason = attentionReason(file, NOW / 1000)!;
    expect(reason.kind).toBe("ask");
    expect(reason.header).toBe("Should I merge it now, or wait for the review round?");
    expect(attentionId(file, NOW / 1000)).toBe(reason.id);
    expect(conversationNeedText(t, reason)).toBe("asks you");
    expect(conversationNeedText(tUk, reason)).toBe("питає вас");
    expect(decisionLine(t, file, NOW / 1000)).toBe("asks you: Should I merge it now, or wait for the review round? · Builder");

    const log = reportLog();
    expect(log.asks).toHaveLength(1);
    const line = log.asks![0]!;
    expect(line).toMatchObject({ id: reason.id, conversationId: CONVERSATION, role: "builder", gist: "Should I merge it now, or wait for the review round?" });
    expect(line.at).toBe(new Date(MESSAGE_AT).toISOString());
    expect(askHref(line)).toBe(`#c=${CONVERSATION}`);
    /* Never a bridge report: the orchestrator's log and the relay see nothing. */
    expect(log.entries).toHaveLength(0);
  });

  test("the classifier is handed the configured OpenRouter key, never the dedupe key", async () => {
    const credentials: string[] = [];
    await runAskSweep(ports({
      apiKey: "sk-or-real",
      classify: async (_body, credential) => { credentials.push(credential); return verdict(0.93); },
    }));
    expect(credentials).toEqual(["sk-or-real"]);
  });

  test("is sent once: the next sweep neither calls again nor adds a second line", async () => {
    await runAskSweep(ports());
    const again = ports();
    await runAskSweep(again);
    expect(again.calls).toHaveLength(0);
    expect(readOperatorAsks().asks).toHaveLength(1);
    expect(reportLog().asks).toHaveLength(1);
  });

  test("clears when the operator answers, when the agent speaks again or works, and on a dismissal", async () => {
    await runAskSweep(ports());
    expect(attentionReason(projected(), NOW / 1000)?.kind).toBe("ask");
    expect(attentionReason(projected(entry({ lastTurn: { startedAt: MESSAGE_AT + 5_000, endedAt: null }, activity: "live" })), NOW / 1000)).toBeNull();
    expect(attentionReason(projected(entry({ lastTurn: { startedAt: MESSAGE_AT + 5_000, endedAt: MESSAGE_AT + 9_000 } })), NOW / 1000)).toBeNull();
    expect(attentionReason(projected(entry({ lastAssistantMessageAt: MESSAGE_AT + 1_000 })), NOW / 1000)).toBeNull();
    const reason = attentionReason(projected(), NOW / 1000)!;
    const dismissed = projected();
    dismissed.attentionDismissal = { at: new Date(NOW).toISOString(), by: { kind: "operator", surface: "desktop" }, reasonId: reason.id };
    expect(attentionId(dismissed, NOW / 1000)).toBeNull();
  });

  test("stays below every structured reason the conversation carries", async () => {
    await runAskSweep(ports());
    const file = projected(entry({ pendingPermission: { id: "perm-1", tool: "Bash", since: new Date(MESSAGE_AT).toISOString() } as FileEntry["pendingPermission"] }));
    expect(attentionReason(file, NOW / 1000)?.kind).toBe("permission");
  });

  test("turning the switch off mid-sweep sends nothing more", async () => {
    const two = [candidate(), candidate({ subject: "conv-2", conversationId: "conv-2", path: "/transcripts/two.jsonl" })];
    const sweep = ports({
      candidates: two,
      finalMessage: (target) => message(`${ASKING} (${target.subject})`, { id: `claude:${target.subject}` }),
      classify: async () => {
        writeAsksYouSettings({ enabled: false }, new Date(NOW));
        return verdict(0.93);
      },
    });
    const result = await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(result.classified).toBe(1);
    expect(readOperatorAsks().seen).not.toContain("conv-2:claude:conv-2");
  });

  test("turning the switch off takes the reason off every card", async () => {
    await runAskSweep(ports());
    writeAsksYouSettings({ enabled: false }, new Date(NOW));
    const file = projected();
    expect(file.operatorAsk).toBeUndefined();
    expect(attentionReason(file, NOW / 1000)).toBeNull();
  });
});

describe("an agent whose turn ends without asking", () => {
  test("produces nothing: no reason, no log line", async () => {
    const sweep = ports({ text: ROUTINE, classify: async () => verdict(0.12) });
    const result = await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(result.asks).toHaveLength(0);
    const file = projected();
    expect(file.operatorAsk).toBeUndefined();
    expect(attentionReason(file, NOW / 1000)).toBeNull();
    expect(reportLog().asks).toEqual([]);
  });

  test("a stage ending, a short line or an engine error is never sent", async () => {
    for (const [id, text, engineError] of [
      ["claude:a", "All done.\n\nREVIEW_READY: https://example.invalid/pull/1", false],
      ["claude:b", "Merged.", false],
      ["claude:c", "API Error: 529 overloaded, the request could not be completed", true],
    ] as const) {
      const sweep = ports({ finalMessage: () => message(text, { id, engineError }) });
      await runAskSweep(sweep);
      expect(sweep.calls).toHaveLength(0);
    }
    expect(readOperatorAsks().asks).toHaveLength(0);
  });

  test("a message from before the latest turn, from before the switch, or still being written is never sent", async () => {
    for (const overrides of [
      { candidates: [candidate({ lastTurnStartedAt: MESSAGE_AT + 1 })] },
      { enabledSince: MESSAGE_AT + 1 },
      { candidates: [candidate({ working: true })] },
      { candidates: [candidate({ structuredAsk: true })] },
      { settings: () => ({ enabled: false, capUsd: 1 }) },
      { apiKey: null },
    ] satisfies Partial<AskSweepPorts>[]) {
      const sweep = ports(overrides);
      await runAskSweep(sweep);
      expect(sweep.calls).toHaveLength(0);
    }
  });
});

describe("the monthly cap", () => {
  test("stops calls once this month's spend would pass it, and counts what it left unclassified", async () => {
    const ceiling = jevCostCeilingUsd(ASKING);
    writeAsksYouSettings({ capUsd: ceiling * 1.5 }, new Date(NOW));
    const two = [candidate(), candidate({ subject: "conv-2", conversationId: "conv-2", path: "/transcripts/two.jsonl" })];
    const sweep = ports({
      candidates: two,
      finalMessage: (target) => message(`${ASKING} (${target.subject})`, { id: `claude:${target.subject}` }),
      classify: async () => verdict(0.93, ceiling),
    });
    const result = await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(result.capped).toBe(1);
    const spend = readOperatorAsks().spend;
    expect(spend.calls).toBe(1);
    expect(spend.capped).toBe(1);
    expect(spend.usd).toBeCloseTo(ceiling, 12);

    /* A cap already spent calls nothing at all. */
    const spent = ports({ candidates: [candidate({ subject: "conv-3", conversationId: "conv-3", path: "/transcripts/three.jsonl" })] });
    await runAskSweep(spent);
    expect(spent.calls).toHaveLength(0);
  });

  test("admits no call that could bill past it, even for text that tokenizes denser than English", async () => {
    /* Cyrillic runs well past the 0.42 tokens per character measured on
       English; the stub bills the most the tokenizer could. The cap sits
       where a gate on the English estimate admits a second call that the
       bill then carries past it. */
    const dense = (subject: string) => `Міграція готова на гілці, перевірки зелені. Злити її зараз чи дочекатися раунду рецензії? (${subject})`;
    const english = (462 + 0.42 * classifierText(dense("conv-a")).length) * JEV_INPUT_PRICE_USD;
    const ceiling = jevCostCeilingUsd(dense("conv-a"));
    expect(ceiling).toBeGreaterThan(english);
    const capUsd = (ceiling + english + 2 * ceiling) / 2;
    writeAsksYouSettings({ capUsd }, new Date(NOW));
    const three = ["conv-a", "conv-b", "conv-c"].map((subject) => candidate({ subject, conversationId: subject, path: `/transcripts/${subject}.jsonl` }));
    const sweep = ports({
      candidates: three,
      finalMessage: (target) => message(dense(target.subject), { id: `claude:${target.subject}` }),
      classify: async (body) => verdict(0.93, jevCostCeilingUsd(body)),
    });
    await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(readOperatorAsks().spend.usd).toBeLessThanOrEqual(capUsd);
  });

  test("a new month starts from nothing", async () => {
    mutateOperatorAsks((file) => { file.spend.usd = 5; }, new Date(Date.UTC(2026, 7, 31)));
    const sweep = ports();
    await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(readOperatorAsks().spend.month).toBe("2026-09");
  });
});

describe("a classifier failure", () => {
  test("leaves everything unchanged: no reason, no line, nothing retried", async () => {
    const ceiling = jevCostCeilingUsd(ASKING);
    for (const [error, billed] of [
      [new JevError("http", "answered 500", 500), 0],
      [new JevError("shape", "a probability out of range", 200, 0.00002), 0.00002],
      [new JevError("shape", "no cost", 200), ceiling],
      [new Error("socket hang up"), ceiling],
    ] as const) {
      fs.rmSync(path.join(stateDir, "operator-asks.json"), { force: true });
      const sweep = ports({ classify: async () => { throw error; } });
      const result = await runAskSweep(sweep);
      expect(sweep.calls).toHaveLength(1);
      expect(result).toMatchObject({ failed: 1, classified: 0, asks: [] });
      const file = projected();
      expect(file.operatorAsk).toBeUndefined();
      expect(attentionReason(file, NOW / 1000)).toBeNull();
      expect(reportLog().asks).toEqual([]);
      /* Only an error status is known to bill nothing. */
      expect(readOperatorAsks().spend.usd).toBeCloseTo(billed, 12);
      const retry = ports();
      await runAskSweep(retry);
      expect(retry.calls).toHaveLength(0);
    }
  });

  test("a timeout counts its largest possible cost against the cap and raises nothing", async () => {
    const sweep = ports({ classify: async () => { throw new JevError("timeout", "slow"); } });
    await runAskSweep(sweep);
    expect(readOperatorAsks().spend.usd).toBeCloseTo(jevCostCeilingUsd(ASKING), 12);
    expect(attentionReason(projected(), NOW / 1000)).toBeNull();
  });

  test("a billed answer the classifier cannot use still counts, so the cap still stops calls", async () => {
    /* The provider answers 200 and bills, with a probability outside 0..1:
       the answer is unusable and the bill is real. */
    const many = Array.from({ length: 50 }, (_, index) => `conv-${index}`);
    const text = (subject: string) => `${ASKING} (${subject})`;
    const ceiling = jevCostCeilingUsd(text("conv-10"));
    for (const cost of [ceiling * 0.9, undefined]) {
      fs.rmSync(path.join(stateDir, "operator-asks.json"), { force: true });
      writeAsksYouSettings({ capUsd: ceiling * 1.5 }, new Date(NOW));
      let posted = 0;
      const provider = (async () => {
        posted += 1;
        return new Response(JSON.stringify({
          answers: { asks: { type: "noul", noul: 1.2 }, waiting: { type: "noul", noul: 0.1 }, decision: { type: "noul", noul: 0.1 } },
          usage: { input_tokens: 600, output_tokens: 51, ...(cost === undefined ? {} : { cost }) },
        }));
      }) as unknown as typeof fetch;
      const sweep = ports({
        candidates: many.map((subject) => candidate({ subject, conversationId: subject, path: `/transcripts/${subject}.jsonl` })),
        finalMessage: (target) => message(text(target.subject), { id: `claude:${target.subject}` }),
        classify: (body, apiKey) => classifyWithJev(body, { apiKey, fetch: provider }),
      });
      const result = await runAskSweep(sweep);
      expect(posted).toBe(1);
      expect(result).toMatchObject({ failed: 1, capped: 49, asks: [] });
      const spend = readOperatorAsks().spend;
      expect(spend.usd).toBeGreaterThan(0);
      expect(spend.usd).toBeCloseTo(cost ?? jevCostCeilingUsd(text("conv-0")), 12);
      expect(spend.usd).toBeLessThanOrEqual(ceiling * 1.5);
    }
  });
});

describe("a state file that cannot be written", () => {
  const failing = () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };

  test("sends nothing when not even the send can be recorded", async () => {
    const sweep = ports({ write: failing });
    for (let round = 0; round < 3; round += 1) await runAskSweep(sweep).catch(() => undefined);
    expect(sweep.calls).toHaveLength(0);
  });

  test("a failure after the call sends the message once, with its largest possible cost counted", async () => {
    const sweep = ports();
    const record = sweep.write;
    sweep.write = (mutation) => {
      if (sweep.calls.length > 0) failing();
      record(mutation);
    };
    for (let round = 0; round < 5; round += 1) await runAskSweep(sweep).catch(() => undefined);
    expect(sweep.calls).toHaveLength(1);
    const spend = readOperatorAsks().spend;
    expect(spend.calls).toBe(1);
    expect(spend.usd).toBeCloseTo(jevCostCeilingUsd(ASKING), 12);
  });

  test("a file that loses every write still sends each message once in this process", async () => {
    const sent = new Map<string, number>();
    const lost = readOperatorAsks(undefined, new Date(NOW));
    const sweep = ports({ read: () => structuredClone(lost), write: () => {} });
    for (let round = 0; round < 5; round += 1) await runAskSweep(sweep, sent);
    expect(sweep.calls).toHaveLength(1);
  });

  test("a restart during the call reads a spend that already holds the call's ceiling", async () => {
    const ceiling = jevCostCeilingUsd(ASKING);
    writeAsksYouSettings({ capUsd: ceiling * 1.5 }, new Date(NOW));
    let reached!: () => void;
    const calling = new Promise<void>((resolve) => { reached = resolve; });
    /* The process dies mid-call: the answer never comes. */
    void runAskSweep(ports({ classify: () => { reached(); return new Promise<JevVerdict>(() => {}); } }), new Map());
    await calling;
    const spend = readOperatorAsks().spend;
    expect(spend.calls).toBe(1);
    expect(spend.usd).toBeCloseTo(ceiling, 12);

    const restarted = ports({
      candidates: [candidate(), candidate({ subject: "conv-2", conversationId: "conv-2", path: "/transcripts/two.jsonl" })],
      finalMessage: (target) => message(target.subject === CONVERSATION ? ASKING : `${ASKING} (conv-2)`, { id: target.subject === CONVERSATION ? "claude:msg-1" : "claude:conv-2" }),
    });
    const result = await runAskSweep(restarted, new Map());
    expect(restarted.calls).toHaveLength(0);
    expect(result.capped).toBe(1);
  });
});

describe("a state file that cannot be read", () => {
  /* A file that is there but cannot be read or parsed is no first run: its
     month's spend is unknown, so the sweep sends nothing and no write puts an
     empty file over it. */
  const file = () => path.join(stateDir, "operator-asks.json");
  const spoilers: { name: string; spoil: (held: string) => void; restore: (held: string) => void }[] = [
    { name: "truncated", spoil: (held) => fs.writeFileSync(file(), held.slice(0, Math.floor(held.length / 2))), restore: (held) => fs.writeFileSync(file(), held) },
    { name: "of another schema", spoil: (held) => fs.writeFileSync(file(), JSON.stringify({ ...JSON.parse(held), schemaVersion: 99 })), restore: (held) => fs.writeFileSync(file(), held) },
    ...(process.getuid?.() === 0 ? [] : [{ name: "unreadable", spoil: () => fs.chmodSync(file(), 0o000), restore: () => fs.chmodSync(file(), 0o600) }]),
  ];

  for (const { name, spoil, restore } of spoilers) {
    test(`a file ${name} sends nothing and keeps the month's spend for when it reads again`, async () => {
      writeAsksYouSettings({ capUsd: 1 }, new Date(NOW));
      mutateOperatorAsks((held) => { held.spend.usd = 0.95; held.spend.calls = 400; held.seen.push("earlier:claude:msg-0"); }, new Date(NOW));
      const held = fs.readFileSync(file(), "utf8");
      spoil(held);
      try {
        const sweep = ports();
        for (let round = 0; round < 3; round += 1) expect((await runAskSweep(sweep)).unreadable).toBe(true);
        expect(sweep.calls).toHaveLength(0);
        expect(() => loadOperatorAsks()).toThrow(OperatorAsksUnreadable);
        expect(readOperatorAsks().spend.usd).toBe(0);
        expect(() => mutateOperatorAsks((current) => { current.spend.calls += 1; }, new Date(NOW))).toThrow();
      } finally {
        restore(held);
      }
      expect(fs.readFileSync(file(), "utf8")).toBe(held);
      const kept = readOperatorAsks(undefined, new Date(NOW));
      expect(kept.spend).toMatchObject({ usd: 0.95, calls: 400 });
      expect(kept.seen).toContain("earlier:claude:msg-0");
    });
  }

  test("a file that is not there yet is a first run, and the send goes out", async () => {
    const sweep = ports();
    await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
  });
});

describe("the same words asked again", () => {
  const LATER = NOW - 10_000;

  test("after the operator answered, raise a new ask and a new line without a second call", async () => {
    await runAskSweep(ports());
    const again = ports({
      candidates: [candidate({ lastTurnStartedAt: LATER - 20_000 })],
      finalMessage: () => message(ASKING, { id: "claude:msg-2", ts: LATER }),
    });
    const result = await runAskSweep(again);
    expect(again.calls).toHaveLength(0);
    expect(result.asks).toHaveLength(1);

    const file = projected(entry({ lastTurn: { startedAt: LATER - 20_000, endedAt: LATER }, lastAssistantMessageAt: LATER }));
    const reason = attentionReason(file, NOW / 1000)!;
    expect(reason.kind).toBe("ask");
    expect(file.operatorAsk?.messageAt).toBe(LATER);
    expect(reportLog().asks).toHaveLength(2);
    expect(reportLog().asks![0]!.id).toBe(reason.id);
  });

  test("by a second agent, flag both conversations on one call", async () => {
    const two = [candidate(), candidate({ subject: "conv-2", conversationId: "conv-2", path: "/transcripts/two.jsonl" })];
    const sweep = ports({ candidates: two, finalMessage: (target) => message(ASKING, { id: `claude:${target.subject}` }) });
    const result = await runAskSweep(sweep);
    expect(sweep.calls).toHaveLength(1);
    expect(result.asks.map((ask) => ask.subject)).toEqual([CONVERSATION, "conv-2"]);
    expect(projected(entry({ path: "/transcripts/two.jsonl", conversationId: "conv-2" })).operatorAsk?.id).toBe(result.asks[1]!.id);
  });

  test("that did not ask the first time still ask nothing, without a call", async () => {
    await runAskSweep(ports({ text: ROUTINE, classify: async () => verdict(0.12) }));
    const again = ports({
      candidates: [candidate({ lastTurnStartedAt: LATER - 20_000 })],
      finalMessage: () => message(ROUTINE, { id: "claude:msg-2", ts: LATER }),
    });
    const result = await runAskSweep(again);
    expect(again.calls).toHaveLength(0);
    expect(result.asks).toEqual([]);
    expect(reportLog().asks).toEqual([]);
  });

  test("after a failed call are sent again, since nothing was scored", async () => {
    await runAskSweep(ports({ classify: async () => { throw new JevError("http", "answered 503", 503); } }));
    const again = ports({
      candidates: [candidate({ lastTurnStartedAt: LATER - 20_000 })],
      finalMessage: () => message(ASKING, { id: "claude:msg-2", ts: LATER }),
    });
    await runAskSweep(again);
    expect(again.calls).toHaveLength(1);
    expect(readOperatorAsks().asks).toHaveLength(1);
  });
});

describe("the message a turn ends on", () => {
  test("is the last text an agent wrote, named by its record or its turn, with engine errors marked", () => {
    const claude = finalAssistantMessageFromRecords([
      { type: "user", timestamp: "2026-09-26T11:57:00.000Z", message: { content: "go" } },
      { type: "assistant", uuid: "u-1", timestamp: "2026-09-26T11:58:00.000Z", message: { id: "m-1", content: [{ type: "text", text: "Should I merge?" }] } },
      { type: "assistant", uuid: "u-2", timestamp: "2026-09-26T11:58:05.000Z", message: { id: "m-1", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    ], "claude-projects", 0);
    expect(claude).toEqual({ id: "claude:u-1", text: "Should I merge?", ts: Date.parse("2026-09-26T11:58:00.000Z"), engineError: false });

    const codex = finalAssistantMessageFromRecords([
      { type: "event_msg", timestamp: "2026-09-26T11:58:00.000Z", payload: { type: "agent_message", message: "Say go and I merge." } },
      { type: "event_msg", timestamp: "2026-09-26T11:58:01.000Z", payload: { type: "task_complete", turn_id: "turn-7", last_agent_message: "Say go and I merge." } },
    ], "codex-sessions", 0);
    expect(codex).toMatchObject({ id: "codex-turn:turn-7", text: "Say go and I merge.", engineError: false });

    const limited = finalAssistantMessageFromRecords([
      { type: "event_msg", timestamp: "2026-09-26T11:58:01.000Z", payload: { type: "task_complete", turn_id: "turn-8", last_agent_message: "You've hit your usage limit.", error: { message: "limit" } } },
    ], "codex-sessions", 0);
    expect(limited?.engineError).toBe(true);
  });
});
