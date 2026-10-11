import type { Pipeline } from "@/lib/pipelines/types";
import type { PrototypeRoundRead } from "@/lib/prototypeReview/types";

import type { DoneFrame } from "./types";

/*
 * The thumbnail of a finished lane (docs/design/done-section.md §4.2), first
 * hit wins:
 *
 *   1. a prototype review round the lane itself published and nobody has
 *      decided yet — its rendered result, newest round, the first frame of its
 *      first variant, the frame's original as the «before»;
 *   2. the newest picture in the task album that the lane's visual critic
 *      looked at, else a rendered evidence file any of its stages named,
 *      whether or not the lane has a visual critic;
 *   3. the chosen variant of the newest decided round on the task, the design
 *      target the lane built.
 *
 * No hit: the item is technical. An album still indexing leaves the answer
 * unsettled, and the projector asks again next time.
 */

export interface DoneFramePorts {
  /** A task's prototype rounds as the review reads them: media URLs only for
      copies this installation holds. */
  rounds(taskId: string): readonly PrototypeRoundRead[];
  /** The album tier for one task of the lane; `settled: false` while the
      album is still indexing. */
  album(taskId: string, pipeline: Pipeline): Promise<{ frame: DoneFrame | null; settled: boolean }>;
}

export interface DoneFrameAnswer {
  frame: DoneFrame | null;
  settled: boolean;
}

type Frame = PrototypeRoundRead["variants"][number]["frames"][number];

function frameOf(frame: Frame | undefined, caption: string): DoneFrame | null {
  if (!frame) return null;
  const image = frame.image.available && frame.image.url ? frame.image.url : null;
  const original = frame.original?.available && frame.original.url ? frame.original.url : null;
  const src = image ?? original;
  if (!src) return null;
  return { src, ...(image && original ? { before: original } : {}), caption: frame.caption || caption };
}

const newestFirst = (left: PrototypeRoundRead, right: PrototypeRoundRead) => Date.parse(right.createdAt) - Date.parse(left.createdAt);

export async function lookupDoneFrame(subject: { pipeline: Pipeline | null; taskIds: readonly string[] }, ports: DoneFramePorts): Promise<DoneFrameAnswer> {
  const rounds = subject.taskIds.flatMap((taskId) => ports.rounds(taskId)).sort(newestFirst);
  const lane = subject.pipeline;
  if (lane) {
    for (const round of rounds) {
      if (round.source.pipelineId !== lane.id || round.decision) continue;
      const frame = frameOf(round.variants[0]?.frames[0], round.title);
      if (frame) return { frame, settled: true };
    }
  }
  let settled = true;
  /* Asked for every lane: the album puts the visual critic's pictures first
     and falls back to evidence any stage of the lane rendered, a builder's
     included. The projector's per-run album budget bounds the indexing. */
  if (lane) {
    for (const taskId of subject.taskIds) {
      const answer = await ports.album(taskId, lane);
      if (answer.frame) return { frame: answer.frame, settled: answer.settled };
      settled &&= answer.settled;
    }
  }
  for (const round of rounds) {
    const chosen = round.decision?.chosen[0];
    if (chosen === undefined) continue;
    const variant = round.variants.find((entry) => entry.number === chosen);
    const frame = frameOf(variant?.frames[0], round.title);
    if (frame) return { frame, settled };
  }
  return { frame: null, settled };
}
