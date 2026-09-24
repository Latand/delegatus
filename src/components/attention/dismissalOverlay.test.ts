import { afterEach, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { attentionId } from "../attention";
import { pipelineAsks } from "../mobile/mobileBoardModel";
import { layerDismissal, overlayDismissals, resetDismissalOverlayForTests, unlayerDismissal } from "./dismissalOverlay";

/*
 * The click's side of a dismissal (docs/design/needs-attention.md §5): drawn
 * over the polled rows the moment it is clicked, so every surface stops
 * flagging it in the same frame, and replaced by the server's instant when the
 * request answers. A mark stamped on this device has to cover what the card
 * drew even when this device's clock runs behind the clock that dated it.
 */

afterEach(() => resetDismissalOverlayForTests());

const NOW = 1_800_000_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const asking = (askedAt: number): FileEntry => ({
  path: "/t/a.jsonl",
  conversationId: "conversation_a",
  mtime: askedAt,
  pendingQuestion: { kind: "question", toolUseId: "toolu_a", transcriptPath: "/t/a.jsonl", pid: 1, paneTarget: null, askedAt: iso(askedAt) },
}) as unknown as FileEntry;

const parked = (completedAt: number): Pipeline => ({
  id: "lane-1",
  state: "needs_decision",
  runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", startedAt: iso(completedAt - 60), completedAt: iso(completedAt) }] }],
}) as unknown as Pipeline;

test("nothing layered: the polled rows come back as they are", () => {
  expect(overlayDismissals([asking(NOW - 60)], [parked(NOW - 60)], NOW * 1000)).toBeNull();
});

test("a click covers the drawn reason and the drawn lane at once, even on a clock behind the server's", () => {
  /* The question and the round were dated 90 s after this device's now. */
  const file = asking(NOW + 90);
  const lane = parked(NOW + 90);
  layerDismissal(
    [{ kind: "conversation", conversationId: "conversation_a", path: file.path, reasonId: "toolu_a" }, { kind: "pipeline", pipelineId: "lane-1" }],
    { at: iso(NOW), by: { kind: "operator", surface: "phone" } },
    true,
    NOW * 1000,
  );
  const layered = overlayDismissals([file], [lane], NOW * 1000)!;
  expect(attentionId(layered.files[0]!, NOW + 100)).toBeNull();
  expect(layered.files[0]!.attentionDismissal?.by).toEqual({ kind: "operator", surface: "phone" });
  expect(pipelineAsks(layered.pipelines[0]!)).toBe(false);
  expect(layered.pipelines[0]!.dismissedBy).toEqual({ kind: "operator", surface: "phone" });
});

test("the server's instant is drawn as it is, and a newer reason comes back past it", () => {
  layerDismissal([{ kind: "conversation", conversationId: "conversation_a", reasonId: "toolu_a" }], { at: iso(NOW), by: { kind: "operator" } }, false, NOW * 1000);
  const older = overlayDismissals([asking(NOW - 60)], [], NOW * 1000)!;
  expect(attentionId(older.files[0]!, NOW)).toBeNull();
  const newer = overlayDismissals([{ ...asking(NOW + 30), pendingQuestion: { ...asking(NOW + 30).pendingQuestion!, toolUseId: "toolu_b" } }], [], NOW * 1000)!;
  expect(attentionId(newer.files[0]!, NOW + 60)).toBe("toolu_b");
});

test("an undo takes the polled mark off until the poll agrees, and a refusal takes the layer off", () => {
  const cleared = { ...asking(NOW - 60), attentionDismissal: { at: iso(NOW - 30), by: { kind: "operator" as const } } };
  layerDismissal([{ kind: "conversation", conversationId: "conversation_a" }], null, true, NOW * 1000);
  const undone = overlayDismissals([cleared], [], NOW * 1000)!;
  expect(undone.files[0]!.attentionDismissal).toBeUndefined();
  expect(attentionId(undone.files[0]!, NOW)).toBe("toolu_a");

  unlayerDismissal([{ kind: "conversation", conversationId: "conversation_a" }]);
  expect(overlayDismissals([cleared], [], NOW * 1000)).toBeNull();
});

test("a layer the poll never reflected retires after its bound", () => {
  layerDismissal([{ kind: "pipeline", pipelineId: "lane-1" }], { at: iso(NOW), by: { kind: "operator" } }, false, NOW * 1000);
  expect(overlayDismissals([], [parked(NOW - 60)], NOW * 1000)).not.toBeNull();
  expect(overlayDismissals([], [parked(NOW - 60)], NOW * 1000 + 31_000)).toBeNull();
});
