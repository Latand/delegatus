"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { OrchestratorPanel, type SeatSignal } from "@/components/orchestrator/OrchestratorPanel";
import type { OrchestratorSeatRead } from "@/components/orchestrator/useOrchestratorSeat";

import {
  clampSeatHeight, clampSeatTopWidth, clampSeatWidth, publishSeatSignal, SEAT_KEY_STEP, SEAT_SIDE_MAX_WIDTH, SEAT_SIDE_MIN_WIDTH,
  SEAT_TOP_MIN_WIDTH, useKanbanSeat,
} from "./kanbanSeatStore";

/** The board's room for the seat on top: its container less the board's edge on each side (`--kb-edge`). */
function seatRoom(section: HTMLElement | null): number {
  const parent = section?.parentElement;
  if (!parent) return Number.POSITIVE_INFINITY;
  const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
  return parent.clientWidth - (parseFloat(style?.paddingLeft ?? "") || 0) - (parseFloat(style?.paddingRight ?? "") || 0) - 2 * (parseFloat(style?.getPropertyValue("--kb-edge") ?? "") || 20);
}

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
 *
 * On top, the right edge is a width grip too (#2179): the seat stays centred,
 * so both edges move and the one under the pointer follows it. The width is
 * the project's, and a double-click puts the default back.
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
  const [dragTopWidth, setDragTopWidth] = useState<number | null>(null);
  const height = dragHeight ?? seat.height;
  const width = dragWidth ?? seat.width;
  const topWidth = dragTopWidth ?? seat.topWidth;
  const side = seat.placement === "side";
  /* What the width grip on top reports: the drawn width and the board's room. */
  const [topSpan, setTopSpan] = useState<{ now: number; max: number } | null>(null);
  useEffect(() => {
    const section = sectionRef.current;
    if (side || seat.collapsed || !section || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const now = Math.round(section.getBoundingClientRect().width);
      const max = Math.max(SEAT_TOP_MIN_WIDTH, Math.round(seatRoom(section)));
      setTopSpan((previous) => (previous?.now === now && previous.max === max ? previous : { now, max }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    if (section.parentElement) observer.observe(section.parentElement);
    return () => observer.disconnect();
  }, [side, seat.collapsed]);

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
      section.querySelector<HTMLElement>("[data-orchestrator-conversation] textarea")?.focus({ preventScroll: true });
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

  const onTopWidthPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const section = sectionRef.current;
    if (event.button !== 0 || !section) return;
    event.preventDefault();
    const grip = event.currentTarget;
    const start = event.clientX;
    const initial = section.getBoundingClientRect().width;
    const room = seatRoom(section);
    let latest = initial;
    try { grip.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    /* Centred: the right edge moves by half the change, so twice the pointer's
       travel keeps that edge under the pointer. */
    const move = (moveEvent: PointerEvent) => {
      latest = clampSeatTopWidth(initial + 2 * (moveEvent.clientX - start), room);
      setDragTopWidth(latest);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (latest !== initial) seat.setTopWidth(latest, room);
      setDragTopWidth(null);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }, [seat]);

  const onTopWidthKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const section = sectionRef.current;
    const current = section?.getBoundingClientRect().width ?? topWidth ?? SEAT_TOP_MIN_WIDTH;
    seat.setTopWidth(current + (event.key === "ArrowRight" ? SEAT_KEY_STEP : -SEAT_KEY_STEP), seatRoom(section));
  }, [seat, topWidth]);

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

  const sized = !side && !seat.collapsed && topWidth !== null;
  const style = side
    ? (seat.collapsed ? undefined : ({ "--seat-w": `${width}px` } as CSSProperties))
    : seat.collapsed ? undefined : ({
      ...(height !== null ? { "--seat-h": `${height}px` } : {}),
      ...(topWidth !== null ? { "--seat-top-w": `${topWidth}px` } : {}),
    } as CSSProperties);
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
        className={`seat${side ? " side" : ""}${seat.collapsed ? " folded" : ""}${sized ? " sized" : ""}`}
        data-kanban-seat={project}
        data-collapsed={seat.collapsed ? "1" : "0"}
        data-placement={seat.placement}
        data-role-host="seat"
        data-role="orchestrator"
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
            aria-valuemin={SEAT_SIDE_MIN_WIDTH}
            aria-valuemax={SEAT_SIDE_MAX_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            data-seat-grip="width"
            onPointerDown={onWidthPointerDown}
            onKeyDown={onWidthKey}
          />
        ) : (
          <>
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
            <div
              className="seat-grip vertical top-width"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("kanban.seatResizeWidth")}
              title={`${t("kanban.seatResizeWidth")}. ${t("kanban.seatResizeWidthHint")}`}
              aria-valuemin={SEAT_TOP_MIN_WIDTH}
              {...(topSpan ? { "aria-valuemax": topSpan.max, "aria-valuenow": topSpan.now } : {})}
              tabIndex={0}
              data-seat-grip="top-width"
              onPointerDown={onTopWidthPointerDown}
              onKeyDown={onTopWidthKey}
              onDoubleClick={() => seat.setTopWidth(null)}
            />
          </>
        )}
      </section>
    </>
  );
}
