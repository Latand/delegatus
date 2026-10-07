"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { Pipeline } from "@/lib/pipelines/types";
import type { SeatRefs } from "@/lib/tasks/groupHide";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { orchestratorLinks, seatActions, type BoardRecords, type LinkTone } from "./orchestratorArrows";
import { createOrchestratorWires, type OrchestratorWires as WiresLayer } from "./orchestratorWires";

/** The layers that are mounted now, for the rendered-evidence driver. */
export const orchestratorWireLayers = new Set<WiresLayer>();

/**
 * The orchestrator's wires on a board (docs/design/orchestrator-arrows.md):
 * for about a minute after the seat starts a pipeline, launches a stage, moves
 * a task or creates one, a wire runs from the seat to that card, then fades.
 * At rest this draws nothing and reads nothing. It rides the records the board
 * already holds: each new read is compared with the one before it.
 */
export function SeatActionWires(props: {
  rootRef: RefObject<HTMLElement | null>;
  phone: boolean;
  seatRefs: SeatRefs | null;
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  files: readonly FileEntry[];
}) {
  const { rootRef, phone, seatRefs, tasks, pipelines, files } = props;
  const layer = useRef<WiresLayer | null>(null);
  const seen = useRef<{ records: BoardRecords; seat: SeatRefs | null } | null>(null);

  useEffect(() => () => {
    if (layer.current) orchestratorWireLayers.delete(layer.current);
    layer.current?.destroy();
    layer.current = null;
  }, [rootRef, phone]);

  useEffect(() => {
    const previous = seen.current;
    const records = { tasks, pipelines };
    seen.current = { records, seat: seatRefs };
    const seat = seatRefs?.conversationIds ?? [];
    /* The first read, and the first under another seat, is where the board stands; nothing in it is an action. */
    const actions = previous && previous.seat === seatRefs ? seatActions(previous.records, records, seat, Date.now()) : [];
    const root = rootRef.current;
    if (actions.length && root && !layer.current) {
      layer.current = createOrchestratorWires({ root, phone });
      orchestratorWireLayers.add(layer.current);
    }
    const wires = layer.current;
    if (!wires || (!actions.length && !wires.active)) return;
    const tones = new Map<string, LinkTone>();
    for (const link of orchestratorLinks({ seatConversationIds: seat, pipelines, tasks, files })) tones.set(link.taskId, link.tone);
    wires.setTones(tones);
    wires.act(actions);
  }, [rootRef, phone, seatRefs, tasks, pipelines, files]);

  /* Any render of the board may have moved a card; with no wire shown this is one comparison. */
  useEffect(() => {
    if (layer.current?.active) layer.current.sync();
  });

  return null;
}
