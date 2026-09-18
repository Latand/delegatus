import type { Pipeline } from "@/lib/pipelines/types";
import { buildStagePrompt, stagePromptExtra } from "@/components/pipelines/pipelineModel";

import { isAlreadyStarted, isStageChanged, type PipelinePorts, type PipelineRead } from "./pipelinePorts";
import { draftOutcome, pipelineEnded, stageNotStarted, stageWiringIndex } from "./stagesModel";

/**
 * The first message of a stage that has not started, edited in place (#1695
 * K5b, prototype `renderDraftMessage`). One draft per stage, shared by every
 * surface that shows the stage (its panel on the card, its pane in Stages), so
 * the text survives moving between them.
 *
 * The operator edits only the prompt's own words; the wiring tokens the engine
 * substitutes (`{{task}}`, `{{prev.output}}`) are put back by `buildStagePrompt`
 * from the stage as it is stored at save time, exactly as the scheme's stage
 * placeholder does.
 *
 * Saving reads the pipeline and compares the stage's words with the ones the
 * edit began from, which covers the time the operator spent editing. The
 * write carries the digest that read returned (`expectedStageDigest`), and the
 * engine checks it inside the same mutation that writes: a stage another
 * client changed after the read answers 409 `STAGE_CHANGED` and nothing is
 * overwritten. A stage that already started answers the engine's own 409, and
 * what it started with decides whether the edit made it (`draftOutcome`).
 *
 * A write with no answer is `unconfirmed`, never "not saved": Check again
 * reads the stage and settles it only on what the stage holds.
 */

export type StageDraftPhase = "editing" | "saving" | "changed" | "started" | "ended" | "failed" | "unconfirmed";

export interface StageDraft {
  pipelineId: string;
  stageId: string;
  text: string;
  /** The stage's words when the edit began, or when Keep mine last accepted theirs. */
  base: string;
  phase: StageDraftPhase;
  /** `changed`: the words the stage holds now; the same words when only its account, role or runtime changed. */
  theirs: string | null;
  /** `failed`: why, as the server said it, or the kind of read that failed. */
  error: { kind: "read" | "missing" | "write"; message: string } | null;
}

export const stageDraftKey = (pipelineId: string, stageId: string) => `${pipelineId}:${stageId}`;

export class StageDrafts {
  private readonly drafts = new Map<string, StageDraft>();
  private readonly savedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Moves on every change, for a subscriber that reads more than one draft. */
  version = (): number => this.revision;

  get(key: string): StageDraft | null {
    return this.drafts.get(key) ?? null;
  }

  entries(): Array<[string, StageDraft]> {
    return [...this.drafts];
  }

  /** When this page last saved the stage's first message. */
  saved(key: string): number | null {
    return this.savedAt.get(key) ?? null;
  }

  private set(key: string, draft: StageDraft | null): void {
    if (draft) this.drafts.set(key, draft);
    else this.drafts.delete(key);
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  /** Open the editor on the stage's current words; an open draft keeps its text. */
  begin(pipelineId: string, stageId: string, stored: string): void {
    const key = stageDraftKey(pipelineId, stageId);
    if (this.drafts.has(key)) return;
    this.set(key, { pipelineId, stageId, text: stored, base: stored, phase: "editing", theirs: null, error: null });
  }

  edit(key: string, text: string): void {
    const draft = this.drafts.get(key);
    if (!draft || draft.phase === "saving") return;
    this.set(key, { ...draft, text });
  }

  /** Cancel, Discard, and Use theirs: the stage keeps what it holds. */
  drop(key: string): void {
    if (this.drafts.get(key)?.phase === "saving") return;
    if (this.drafts.has(key)) this.set(key, null);
  }

  /**
   * Save the draft's words as the stage's first message. Resolves once the
   * draft has settled: saved (and gone), or kept with the reason it was not.
   * `keepMine` saves over the words the last check found.
   */
  async save(key: string, ports: PipelinePorts, options: { keepMine?: boolean } = {}): Promise<void> {
    const draft = this.drafts.get(key);
    if (!draft || draft.phase === "saving") return;
    /* Empty words are a real edit: the stage keeps only its wiring. */
    const text = draft.text.trim();
    const base = options.keepMine && draft.theirs !== null ? draft.theirs : draft.base;
    this.set(key, { ...draft, base, phase: "saving", theirs: null, error: null });
    const settle = (next: Partial<StageDraft>) => {
      const current = this.drafts.get(key);
      if (current) this.set(key, { ...current, ...next });
    };

    const read = await ports.read(draft.pipelineId);
    const decided = this.decide(key, read, ports, text, base);
    if (decided.kind === "settled") return settle(decided.next);
    if (decided.kind === "done") return;

    const result = await ports.patch(draft.pipelineId, {
      action: "override-stage",
      stageId: decided.stageId,
      "prompt": decided.prompt,
      expectedStageDigest: decided.digest,
    });
    if (result.ok) {
      this.savedAt.set(key, this.clock());
      this.set(key, null);
      return;
    }
    if (result.unknown) return settle({ phase: "unconfirmed" });
    if (isStageChanged(result)) {
      /* Another client wrote the stage after the read: read it again and say what it holds now. */
      const again = this.decide(key, await ports.read(draft.pipelineId), ports, text, base);
      if (again.kind === "settled") return settle(again.next);
      if (again.kind === "done") return;
      return settle({ phase: "changed", theirs: again.stored });
    }
    if (isAlreadyStarted(result)) {
      ports.refresh();
      return settle({ phase: "started" });
    }
    settle({ phase: "failed", error: { kind: "write", message: result.error } });
  }

  /** What a read of the pipeline decides for a save: settle the draft, or write with this digest. */
  private decide(key: string, read: PipelineRead | null, ports: PipelinePorts, text: string, base: string):
    | { kind: "settled"; next: Partial<StageDraft> }
    | { kind: "done" }
    | { kind: "write"; stageId: string; prompt: string; digest: string; stored: string } {
    if (!read) return { kind: "settled", next: { phase: "failed", error: { kind: "read", message: "" } } };
    const record = read.pipeline;
    const stage = record.stages.find((candidate) => candidate.id === this.drafts.get(key)?.stageId);
    /* A check that finds the board behind the store asks it to catch up. */
    if (!stage) {
      ports.refresh();
      return { kind: "settled", next: { phase: "failed", error: { kind: "missing", message: "" } } };
    }
    if (!stageNotStarted(record, stage.id) || pipelineEnded(record)) {
      ports.refresh();
      if (this.settleFromStage(key, record, { text, base }, true)) return { kind: "done" };
      return { kind: "settled", next: { phase: draftOutcome(record, stage.id, { text, base }) === "ended-before-start" ? "ended" : "started" } };
    }
    const stored = stagePromptExtra(stage.prompt);
    if (stored === stagePromptExtra(text)) {
      /* The stage already holds these words: nothing to write. */
      ports.refresh();
      this.set(key, null);
      return { kind: "done" };
    }
    if (stored !== stagePromptExtra(base)) {
      ports.refresh();
      return { kind: "settled", next: { phase: "changed", theirs: stored } };
    }
    /* Without the stage's digest the write could not be guarded: nothing is sent. */
    const digest = read.stageDigests[stage.id];
    if (!digest) return { kind: "settled", next: { phase: "failed", error: { kind: "read", message: "" } } };
    return { kind: "write", stageId: stage.id, prompt: buildStagePrompt(stage.prompt, text, stageWiringIndex(record, stage.id)), digest, stored };
  }

  /**
   * Check a write that got no answer, by reading the stage. It settles only
   * on what the stage holds: these words (saved), a start that froze them in
   * or out, or an end before the start. Anything else stays unconfirmed; the
   * read cannot prove the write never ran.
   */
  async check(key: string, ports: PipelinePorts): Promise<void> {
    const draft = this.drafts.get(key);
    if (!draft || draft.phase !== "unconfirmed") return;
    const record = (await ports.read(draft.pipelineId))?.pipeline;
    const current = this.drafts.get(key);
    if (!record || current !== draft) return;
    const stage = record.stages.find((candidate) => candidate.id === draft.stageId);
    if (!stage) return this.set(key, { ...draft, phase: "failed", error: { kind: "missing", message: "" } });
    ports.refresh();
    if (!stageNotStarted(record, stage.id) || pipelineEnded(record)) {
      if (this.settleFromStage(key, record, draft)) return;
      return this.set(key, { ...draft, phase: draftOutcome(record, stage.id, draft) === "ended-before-start" ? "ended" : "started" });
    }
    if (stagePromptExtra(stage.prompt) === stagePromptExtra(draft.text)) {
      this.savedAt.set(key, this.clock());
      this.set(key, null);
    }
  }

  /** A draft the stage's record makes moot goes: its words are in, or were
      never changed. A draft mid-save is its save's to settle. */
  settleFromStage(key: string, record: Pipeline, draft: { text: string; base: string } | null = null, duringSave = false): boolean {
    const current = this.drafts.get(key);
    if (!current || (current.phase === "saving" && !duringSave)) return false;
    const outcome = draftOutcome(record, current.stageId, draft ?? current);
    if (outcome !== "included" && outcome !== "untouched") return false;
    this.set(key, null);
    return true;
  }
}
