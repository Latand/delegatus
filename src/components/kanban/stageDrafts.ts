import { buildStagePrompt, stagePromptExtra } from "@/components/pipelines/pipelineModel";

import { isAlreadyStarted, type PipelinePorts } from "./pipelinePorts";
import { stageNotStarted, stageWiringIndex } from "./stagesModel";

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
 * Saving reads the pipeline first and compares the stage's words with the ones
 * the edit began from. That check narrows the window for overwriting a prompt
 * another client saved; it does not close it, because the read and the write
 * are two requests. The server's own guard for an unchanged stage (C7:
 * `expectedStageDigest`, 409 `STAGE_CHANGED`) does not exist yet. The engine's
 * guard for a stage that already started does, and it is the one this relies
 * on: a 409 "stage has already started" keeps the text and says it was not
 * delivered.
 */

export type StageDraftPhase = "editing" | "saving" | "changed" | "started" | "failed";

export interface StageDraft {
  pipelineId: string;
  stageId: string;
  text: string;
  /** The stage's words when the edit began, or when Keep mine last accepted theirs. */
  base: string;
  phase: StageDraftPhase;
  /** `changed`: the words the stage holds now. */
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
    const text = draft.text.trim();
    if (!text) return;
    const base = options.keepMine && draft.theirs !== null ? draft.theirs : draft.base;
    this.set(key, { ...draft, base, phase: "saving", theirs: null, error: null });
    const settle = (next: Partial<StageDraft>) => {
      const current = this.drafts.get(key);
      if (current) this.set(key, { ...current, ...next });
    };

    const record = await ports.read(draft.pipelineId);
    if (!record) return settle({ phase: "failed", error: { kind: "read", message: "" } });
    const stage = record.stages.find((candidate) => candidate.id === draft.stageId);
    /* A check that finds the board behind the store asks it to catch up. */
    if (!stage) {
      ports.refresh();
      return settle({ phase: "failed", error: { kind: "missing", message: "" } });
    }
    if (!stageNotStarted(record, stage.id)) {
      ports.refresh();
      return settle({ phase: "started" });
    }
    const stored = stagePromptExtra(stage.prompt);
    if (stored === text) {
      /* The stage already holds these words: nothing to write. */
      ports.refresh();
      this.set(key, null);
      return;
    }
    if (stored !== base) {
      ports.refresh();
      return settle({ phase: "changed", theirs: stored });
    }

    const result = await ports.patch(draft.pipelineId, {
      action: "override-stage",
      stageId: stage.id,
      "prompt": buildStagePrompt(stage.prompt, text, stageWiringIndex(record, stage.id)),
    });
    if (result.ok) {
      this.savedAt.set(key, this.clock());
      this.set(key, null);
      return;
    }
    if (isAlreadyStarted(result)) {
      ports.refresh();
      return settle({ phase: "started" });
    }
    settle({ phase: "failed", error: { kind: "write", message: result.error } });
  }
}
