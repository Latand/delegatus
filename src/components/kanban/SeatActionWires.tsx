"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { HINT_BUBBLE_CLASS, SHOW_DELAY_MS } from "@/components/Hint";
import { TooltipBubble } from "@/components/TooltipBubble";
import { taskTitle } from "@/components/tasks/taskModel";
import { useLocale } from "@/lib/i18n";
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
  /** Go to a task's card the way the board goes to a card elsewhere. The phone's board has no such
      path: there the wire scrolls the card into view, focuses it and rings it. */
  onJump?: (taskId: string) => void;
}) {
  const { rootRef, phone, seatRefs, tasks, pipelines, files } = props;
  const { t } = useLocale();
  const layer = useRef<WiresLayer | null>(null);
  const seen = useRef<{ records: BoardRecords; seat: SeatRefs | null } | null>(null);
  /* What the layer's callbacks read: they are handed over once, when it mounts. */
  const live = useRef({ tasks, t, onJump: props.onJump });
  useEffect(() => { live.current = { tasks, t, onJump: props.onJump }; });
  /* The task a wire under the pointer or the keyboard leads to, and where its name shows. */
  const [named, setNamed] = useState<{ title: string; anchor: { current: Element | null } } | null>(null);
  const naming = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (layer.current) orchestratorWireLayers.delete(layer.current);
    layer.current?.destroy();
    layer.current = null;
    if (naming.current) clearTimeout(naming.current);
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
      const title = (taskId: string) => {
        const task = live.current.tasks.find((candidate) => candidate.id === taskId);
        return task ? taskTitle(task.text) || live.current.t("tasks.untitled") : null;
      };
      const created: WiresLayer = createOrchestratorWires({
        root, phone,
        label: (taskId) => live.current.t("kanban.wire.goTo", { title: title(taskId) ?? taskId }),
        /* The board's own hint: after the pointer rests, at once for the keyboard. */
        onHover: (taskId, anchor) => {
          if (naming.current) clearTimeout(naming.current);
          naming.current = null;
          const name = taskId ? title(taskId) : null;
          if (!name || !anchor) return setNamed(null);
          const show = () => setNamed({ title: name, anchor: { current: anchor } });
          if (anchor.closest("[data-oa-marks]")) naming.current = setTimeout(show, SHOW_DELAY_MS);
          else show();
        },
        onJump: (taskId) => {
          setNamed(null);
          if (live.current.onJump) return live.current.onJump(taskId);
          const card = root.querySelector<HTMLElement>(`[data-phone-card="task:${CSS.escape(taskId)}"]`);
          if (!card) return;
          card.scrollIntoView({ block: "nearest" });
          card.focus({ preventScroll: true });
          created.ring(taskId);
        },
      });
      layer.current = created;
      orchestratorWireLayers.add(created);
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

  return named ? <TooltipBubble anchorRef={named.anchor} className={HINT_BUBBLE_CLASS}>{named.title}</TooltipBubble> : null;
}
