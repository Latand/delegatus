"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { OrchestratorPanel, type SeatSignal } from "@/components/orchestrator/OrchestratorPanel";
import type { OrchestratorSeatRead } from "@/components/orchestrator/useOrchestratorSeat";

import { clampSeatHeight, clampSeatWidth, publishSeatSignal, SEAT_KEY_STEP, useKanbanSeat } from "./kanbanSeatStore";

/**
 * The project's orchestrator, centred above the kanban columns (#1695 K3,
 * prototype `renderSeat`). Everything it does is `OrchestratorPanel`'s own seat
 * logic — status, create, rotate, the real conversation and its hoisted
 * composer; this component is the prototype's frame around it: a centred panel
 * with a smaller default height, a grip that resizes it and is remembered on
 * this device, and Collapse where the dock had Close.
 *
 * Two placements (#1841): on top, centred above the columns, or at the side,
 * a full-height column left of them with a grip on its right edge. Collapsed,
 * the top frame is a 40 px strip and the side frame a 44 px rail.
 */
export function KanbanSeat({ project, projectName, projectCwd, files, tasks, boardId, seatRead }: {
  project: string;
  projectName: string;
  projectCwd?: string;
  files: readonly FileEntry[];
  /** The project's tasks, for the seats' titles and notes. */
  tasks?: readonly BoardTask[];
  /** The board region `Skip to the board` lands on. */
  boardId: string;
  /** The board's read of this project's seat, shared so the page polls it once. */
  seatRead?: OrchestratorSeatRead | null;
}) {
  const { t } = useLocale();
  const seat = useKanbanSeat(project);
  const sectionRef = useRef<HTMLElement>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const height = dragHeight ?? seat.height;
  const width = dragWidth ?? seat.width;
  const side = seat.placement === "side";

  /* The header toggle's dot reads the seat's state from here. */
  const onSeatSignal = useCallback((signal: SeatSignal) => publishSeatSignal(project, signal), [project]);
  useEffect(() => () => publishSeatSignal(project, null), [project]);

  /* Expanding hands focus to the composer; collapsing takes it out of the
     hidden conversation to the control that expands it again. */
  const wasCollapsed = useRef(seat.collapsed);
  useEffect(() => {
    if (wasCollapsed.current === seat.collapsed) return;
    wasCollapsed.current = seat.collapsed;
    const section = sectionRef.current;
    if (!section) return;
    if (!seat.collapsed) {
      requestAnimationFrame(() => section.querySelector<HTMLElement>("[data-orchestrator-conversation] textarea")?.focus({ preventScroll: true }));
    } else if (section.contains(document.activeElement)) {
      section.querySelector<HTMLElement>("[data-seat-collapse]")?.focus({ preventScroll: true });
    }
  }, [seat.collapsed]);

  const onWidthPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const section = sectionRef.current;
    if (event.button !== 0 || !section) return;
    event.preventDefault();
    const grip = event.currentTarget;
    const start = event.clientX;
    const initial = section.getBoundingClientRect().width;
    let latest = initial;
    try { grip.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    const move = (moveEvent: PointerEvent) => {
      latest = clampSeatWidth(initial + moveEvent.clientX - start);
      setDragWidth(latest);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (latest !== initial) seat.setWidth(latest);
      setDragWidth(null);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }, [seat]);

  const onWidthKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    seat.setWidth(width + (event.key === "ArrowRight" ? SEAT_KEY_STEP : -SEAT_KEY_STEP));
  }, [seat, width]);

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

  const style = side
    ? (seat.collapsed ? undefined : ({ "--seat-w": `${width}px` } as CSSProperties))
    : height !== null && !seat.collapsed ? ({ "--seat-h": `${height}px` } as CSSProperties) : undefined;
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
        className={`seat${side ? " side" : ""}${seat.collapsed ? " folded" : ""}`}
        data-kanban-seat={project}
        data-collapsed={seat.collapsed ? "1" : "0"}
        data-placement={seat.placement}
        style={style}
      >
        <OrchestratorPanel
          variant="seat"
          collapsed={seat.collapsed}
          placement={seat.placement}
          onTogglePlacement={seat.togglePlacement}
          onSeatSignal={onSeatSignal}
          onClose={seat.toggle}
          project={project}
          projectName={projectName}
          projectCwd={projectCwd}
          files={files}
          seatTasks={tasks}
          {...(seatRead ? { seatRead } : {})}
        />
        {seat.collapsed ? null : side ? (
          <div
            className="seat-grip vertical"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("orchPanel.seatResizeWidth")}
            title={t("orchPanel.seatResizeWidth")}
            aria-valuemin={320}
            aria-valuemax={560}
            aria-valuenow={width}
            tabIndex={0}
            data-seat-grip="width"
            onPointerDown={onWidthPointerDown}
            onKeyDown={onWidthKey}
          />
        ) : (
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
