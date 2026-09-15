"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { OrchestratorPanel } from "@/components/orchestrator/OrchestratorPanel";
import type { OrchestratorSeatRead } from "@/components/orchestrator/useOrchestratorSeat";

import { clampSeatHeight, SEAT_KEY_STEP, useKanbanSeat } from "./kanbanSeatStore";

/**
 * The project's orchestrator, centred above the kanban columns (#1695 K3,
 * prototype `renderSeat`). Everything it does is `OrchestratorPanel`'s own seat
 * logic — status, create, rotate, the real conversation and its hoisted
 * composer; this component is the prototype's frame around it: a centred panel
 * with a smaller default height, a grip that resizes it and is remembered on
 * this device, and Collapse where the dock had Close.
 */
export function KanbanSeat({ project, projectName, projectCwd, files, boardId, seatRead }: {
  project: string;
  projectName: string;
  projectCwd?: string;
  files: readonly FileEntry[];
  /** The board region `Skip to the board` lands on. */
  boardId: string;
  /** The board's read of this project's seat, shared so the page polls it once. */
  seatRead?: OrchestratorSeatRead | null;
}) {
  const { t } = useLocale();
  const seat = useKanbanSeat(project);
  const sectionRef = useRef<HTMLElement>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const height = dragHeight ?? seat.height;

  const onGripPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const section = sectionRef.current;
    if (event.button !== 0 || !section) return;
    event.preventDefault();
    const grip = event.currentTarget;
    const start = event.clientY;
    const initial = section.getBoundingClientRect().height;
    let latest = initial;
    try { grip.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    const move = (moveEvent: PointerEvent) => {
      latest = clampSeatHeight(initial + moveEvent.clientY - start, window.innerHeight);
      setDragHeight(latest);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (latest !== initial) seat.setHeight(latest);
      setDragHeight(null);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }, [seat]);

  const onGripKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = sectionRef.current?.getBoundingClientRect().height ?? height ?? 0;
    seat.setHeight(current + (event.key === "ArrowDown" ? SEAT_KEY_STEP : -SEAT_KEY_STEP));
  }, [height, seat]);

  const style = height !== null && !seat.collapsed ? ({ "--seat-h": `${height}px` } as CSSProperties) : undefined;
  return (
    <>
      <a
        className="skip-board"
        href={`#${boardId}`}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(boardId)?.focus();
        }}
      >
        {t("kanban.skipToBoard")}
      </a>
      <section
        ref={sectionRef}
        className={`seat${seat.collapsed ? " folded" : ""}`}
        data-kanban-seat={project}
        data-collapsed={seat.collapsed ? "1" : "0"}
        style={style}
      >
        <OrchestratorPanel
          variant="seat"
          collapsed={seat.collapsed}
          onClose={seat.toggle}
          project={project}
          projectName={projectName}
          projectCwd={projectCwd}
          files={files}
          {...(seatRead ? { seatRead } : {})}
        />
        {seat.collapsed ? null : (
          <div
            className="seat-grip"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("kanban.seatResize")}
            title={t("kanban.seatResize")}
            tabIndex={0}
            data-seat-grip=""
            onPointerDown={onGripPointerDown}
            onKeyDown={onGripKey}
          />
        )}
      </section>
    </>
  );
}
