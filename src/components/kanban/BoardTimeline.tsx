"use client";

import { ChartGantt, ChevronRight, Minus, Plus } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { BAR_CONTROL, BAR_OUTLINED, BAR_PRESSED } from "@/components/ProjectBar";
import { humanizeDuration } from "@/components/turnDuration";
import { useLocale } from "@/lib/i18n";
import { projectTaskTimelines, type TimelineAttempt, type TimelineMember } from "@/lib/board/taskTimeline";
import { roleNameById } from "@/components/builderCopy";
import type { Pipeline, PipelineRoleId } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import { STAGE_TONES, stageDisplayName, type StageChipState } from "@/components/pipelines/pipelineModel";
import { StageGlyph } from "./StageGlyph";
import { TIMELINE_HOURS, timelineExpanded, type TimelinePreference } from "./boardTimelineStore";

const HOUR = 3_600_000;
const chipState = (attempt: TimelineAttempt): StageChipState => attempt.state === "spawning" || attempt.stopped
  || !attempt.live && ["running", "reviewing", "committing"].includes(attempt.state) ? "pending" : attempt.state;
// Offsets inside a row, from its top, where no text line is cut in two.
function lineCuts(row: HTMLElement, height: number): number[] {
  const top = row.getBoundingClientRect().top;
  const lines: [number, number][] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.height) lines.push([rect.top - top, rect.bottom - top]);
  }
  const edges = new Set(lines.flat());
  return [...edges].filter(edge => edge > 0.5 && edge < height - 0.5 && lines.every(([start, end]) => edge <= start + 0.5 || edge >= end - 0.5)).sort((a, b) => a - b);
}
const ZOOM_BUTTON = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-transparent text-secondary transition-colors hover:border-border hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:text-muted disabled:hover:border-transparent";

export function BoardTimelineToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  return <button type="button" data-board-timeline-toggle="" data-bar-control="" aria-pressed={active} aria-label={t("timeline.title")} title={t("timeline.title")}
    className={`${BAR_CONTROL} ${active ? BAR_PRESSED : BAR_OUTLINED}`} onClick={onToggle}>
    <ChartGantt className="h-[15px] w-[15px] shrink-0" aria-hidden /><span data-fit-label="">{t("timeline.title")}</span>
  </button>;
}

export function BoardTimeline({ project, tasks, pipelines, members, nowMs, preference, onPreference, phone = false }: {
  project: string; tasks: readonly BoardTask[]; pipelines: readonly Pipeline[]; nowMs: number;
  members?: readonly TimelineMember[];
  preference: TimelinePreference; onPreference: (patch: Partial<TimelinePreference>) => void; phone?: boolean;
}) {
  const { t, locale } = useLocale();
  const projection = useMemo(() => projectTaskTimelines({ project, tasks, pipelines, members, nowMs }), [project, tasks, pipelines, members, nowMs]);
  const tasksById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const pipelinesById = useMemo(() => new Map(pipelines.map(pipeline => [pipeline.id, pipeline])), [pipelines]);
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const positioned = useRef("");
  const previousTop = useRef(0);
  // A finger, wheel, key or scrollbar drag is moving the chart. While it is, the
  // component writes neither the viewport height nor scrollTop; what a layout
  // change asked for meanwhile waits in `pending` until the movement is over.
  const gesture = useRef({ active: false, held: false, moved: false, placed: false, pending: "" as "" | "soft" | "force", timer: 0 as ReturnType<typeof setTimeout> | 0 });
  const [width, setWidth] = useState(0);
  const [viewLeft, setViewLeft] = useState(0);
  const labelWidth = phone ? 0 : Math.min(380, Math.max(120, Math.round(width * 0.45)));
  // Whole-row stops of the chart: where a row (or, for a row taller than the
  // viewport, a text line) starts, measured from the bottom of the pinned axis.
  const measureRows = useCallback(() => {
    const element = scroll.current, container = root.current;
    if (!element || !container) return null;
    const rows = [...element.querySelectorAll<HTMLElement>(".bt-row")];
    if (!rows.length) return null;
    const axis = element.querySelector<HTMLElement>(".bt-axis")!.offsetHeight;
    const scrollbar = element.offsetHeight - element.clientHeight;
    const available = container.clientHeight - container.querySelector<HTMLElement>(".bt-head")!.offsetHeight - axis - scrollbar;
    // A row that fits is one snap unit. A row taller than the viewport is cut
    // only between its text lines, so no line is clipped at either scroll edge.
    const heights: number[] = [];
    for (const row of rows) {
      const height = row.getBoundingClientRect().height;
      if (height <= available) { heights.push(height); continue; }
      let previous = 0;
      for (const cut of lineCuts(row, height)) { heights.push(cut - previous); previous = cut; }
      heights.push(height - previous);
    }
    const offsets: number[] = [];
    let total = 0;
    for (const height of heights) { offsets.push(total); total += height; }
    return { element, axis, scrollbar, available, heights, offsets };
  }, []);
  // Size the scrolling viewport to complete rows, without changing a row's
  // text or height, and put the chart on a row edge. It runs when the layout
  // changes (open, resize, expand, scale) and when the chart is moved from
  // script; never while a person is scrolling (see `fit`).
  const fitRows = useCallback(() => {
    const measured = measureRows();
    if (!measured) return;
    const { element, axis, scrollbar, available, heights, offsets } = measured;
    gesture.current.placed = false;
    const atEnd = element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    let first = offsets.findIndex(offset => offset >= element.scrollTop - 1);
    if (first < 0) first = heights.length - 1;
    if (element.scrollTop < previousTop.current && offsets[first]! > element.scrollTop + 1) first = Math.max(0, first - 1);
    let used = 0;
    if (atEnd) {
      first = heights.length;
      while (first > 0 && used + heights[first - 1]! <= available) used += heights[--first]!;
    } else {
      for (let index = first; index < heights.length && used + heights[index]! <= available; index++) used += heights[index]!;
    }
    if (!used || first >= heights.length) {
      element.style.flex = "";
      element.style.height = "";
      previousTop.current = element.scrollTop;
      return;
    }
    element.style.flex = "0 0 auto";
    element.style.height = `${axis + used + scrollbar}px`;
    element.scrollTop = offsets[first]!;
    previousTop.current = element.scrollTop;
  }, [measureRows]);
  // `force` is a layout change that owes whole rows even over a scrolled
  // position; without it a data refresh or a horizontal pan leaves a position
  // the person chose alone. During a gesture either one waits.
  const fit = useCallback((force: boolean) => {
    const state = gesture.current;
    if (state.active) { if (force || !state.pending) state.pending = force ? "force" : "soft"; return; }
    if (!force && state.placed) return;
    fitRows();
  }, [fitRows]);
  const endGesture = useCallback(() => {
    const state = gesture.current;
    if (state.timer) clearTimeout(state.timer);
    state.active = false; state.held = false; state.timer = 0;
    const pending = state.pending; state.pending = "";
    if (pending === "force" || pending === "soft" && !state.placed) fitRows();
  }, [fitRows]);
  // The movement is over 200 ms after the last scroll or input event with
  // nothing held down; a held finger or button keeps it going, up to 8 s of silence.
  const keepGesture = useCallback(() => {
    const state = gesture.current;
    state.active = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(endGesture, state.held ? 8000 : 200);
  }, [endGesture]);
  const press = useCallback(() => { gesture.current.held = true; gesture.current.moved = false; keepGesture(); }, [keepGesture]);
  const keyStep = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const down = event.key === "ArrowDown";
    if (!down && event.key !== "ArrowUp" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) { if (event.key.startsWith("Arrow") || event.key.startsWith("Page") || event.key === "Home" || event.key === "End" || event.key === " ") keepGesture(); return; }
    // Arrow keys move one row (or one text line of a very tall row) at a time.
    const measured = measureRows();
    if (!measured) return;
    event.preventDefault();
    const { element, offsets } = measured;
    const target = down ? offsets.find(offset => offset > element.scrollTop + 1) : offsets.findLast(offset => offset < element.scrollTop - 1);
    keepGesture();
    element.scrollTop = Math.max(0, Math.min(target ?? (down ? element.scrollHeight : 0), element.scrollHeight - element.clientHeight));
  }, [keepGesture, measureRows]);
  useEffect(() => {
    const state = gesture.current;
    const release = (event: Event) => {
      if (!state.active) return;
      // The browser cancels a touch pointer once it takes over the scrolling; the finger is still down until `touchend`.
      if (event.type === "pointercancel") { state.moved = true; return; }
      if (event.type === "touchend" && (event as TouchEvent).touches.length) return;
      state.held = false;
      if (state.moved) keepGesture(); else endGesture();
    };
    const events = ["pointerup", "pointercancel", "touchend", "touchcancel", "mouseup", "blur"] as const;
    for (const type of events) window.addEventListener(type, release, { passive: true });
    return () => {
      for (const type of events) window.removeEventListener(type, release);
      if (state.timer) clearTimeout(state.timer);
    };
  }, [keepGesture, endGesture]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => { setWidth(element.clientWidth); fit(true); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  useLayoutEffect(() => fit(true), [fit, preference.expanded, preference.hours, width, locale]);
  // A data refresh re-fits a chart nobody has scrolled, and leaves a scrolled one where it is.
  useLayoutEffect(() => fit(false), [fit, tasks, pipelines]);
  const laneWidth = Math.max(120, width - labelWidth - (phone ? 0 : 17));
  const pxPerMs = laneWidth / (preference.hours * HOUR);
  const earliest = projection.tasks.reduce((start, task) => Math.min(start, task.startedAtMs ?? start), nowMs - preference.hours * HOUR);
  const from = Math.floor(earliest / HOUR) * HOUR;
  const to = Math.ceil((nowMs + preference.hours * HOUR * 0.22) / HOUR) * HOUR;
  const canvas = Math.max(laneWidth, (to - from) * pxPerMs);
  const nowX = (nowMs - from) * pxPerMs;
  useLayoutEffect(() => {
    if (!scroll.current) { positioned.current = ""; return; }
    const key = `${project}:${preference.hours}:${laneWidth}:${from}`;
    if (positioned.current !== key) {
      scroll.current.scrollLeft = Math.max(0, nowX - laneWidth * 0.78);
      positioned.current = key;
    }
  }, [project, preference.hours, laneWidth, nowX, from, projection.tasks.length]);
  const intl = locale === "uk" ? "uk-UA" : "en-GB";
  const time = (ms: number) => new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
  const date = (ms: number) => new Intl.DateTimeFormat(intl, { day: "numeric", month: "short" }).format(ms);
  const duration = (start: number | null, end: number | null) => start === null || end === null ? t("timeline.unknownTime") : humanizeDuration((end - start) / 1000, locale);
  const name = (attempt: TimelineAttempt) => {
    const stage = attempt.pipelineId ? pipelinesById.get(attempt.pipelineId)?.stages.find(stage => stage.id === attempt.stageId) : null;
    const title = stage ? stageDisplayName(t, { ...stage, role: attempt.roleId ? { roleId: attempt.roleId as PipelineRoleId } : stage.role })
      : attempt.roleId ? roleNameById(t, attempt.roleId) : attempt.pipelineId ? attempt.stageId : t("dash.agent");
    return `${title}${attempt.attempt > 1 ? ` ${attempt.attempt}` : ""}`;
  };
  const stateWord = (attempt: TimelineAttempt) => attempt.stopped ? t("timeline.stopped")
    : !attempt.live && ["running", "reviewing", "committing"].includes(attempt.state)
      ? t(attempt.activity === "idle" ? "timeline.idle" : "timeline.activityUnknown")
      : attempt.state === "reviewing" ? t("timeline.reviewing") : t(`kanban.graphState.${chipState(attempt)}`);
  const elapsed = (start: number | null, end: number | null) => t("timeline.elapsed", { duration: duration(start, end) });
  const turnDuration = (attempt: TimelineAttempt) => attempt.observedTurn
    ? t("timeline.lastTurn", { duration: duration(attempt.observedTurn.startedAtMs, attempt.observedTurn.endAtMs) })
    : t("timeline.workUnknown");
  const tone = (attempt: TimelineAttempt) => STAGE_TONES[chipState(attempt)];
  // Engine identity stays constant when an attempt's outcome changes.
  const agentColor = (attempt: TimelineAttempt) => attempt.engine === "claude" ? "var(--color-claude)"
    : attempt.engine === "codex" ? "var(--color-codex)" : attempt.engine === "openclaw" ? "var(--color-openclaw)" : "var(--color-secondary)";
  const x = (ms: number) => (ms - from) * pxPerMs;
  const bar = (start: number | null, end: number | null): CSSProperties | null => {
    if (start === null || end === null || end < start || start > nowMs) return null;
    const right = x(Math.min(end, nowMs));
    const left = Math.max(0, Math.min(x(start), right - 3));
    return { left, width: Math.max(0, right - left) };
  };
  // A history control above the visible range grows a phone stage row, so the fitted viewport is measured again when the count changes.
  const hiddenBefore = (attempt: TimelineAttempt) => attempt.startedAtMs !== null && attempt.endAtMs !== null && bar(attempt.startedAtMs, attempt.endAtMs) !== null && x(attempt.endAtMs) < viewLeft;
  const earlierCount = projection.tasks.reduce((count, task) => timelineExpanded(preference, task.taskId, task.live)
    ? count + [...task.pipelines.flatMap(pipeline => pipeline.attempts), ...task.agents].filter(hiddenBefore).length : count, 0);
  useLayoutEffect(() => fit(false), [fit, earlierCount]);
  const nowLine = <i className="bt-now" style={{ left: nowX }} aria-hidden />;
  const stepHours = [1, 3, 6, 12, 24, 48, 72, 168].find(hours => hours * HOUR * pxPerMs >= 44) ?? 168;
  const visibleFrom = from + viewLeft / pxPerMs;
  const visibleTo = Math.min(to, visibleFrom + laneWidth / pxPerMs);
  const ticks = [];
  for (let ms = Math.ceil(visibleFrom / (stepHours * HOUR)) * stepHours * HOUR; ms <= visibleTo; ms += stepHours * HOUR) ticks.push(ms);
  const days: { start: number; end: number }[] = [];
  const day = new Date(visibleFrom); day.setHours(0, 0, 0, 0);
  while (day.getTime() < visibleTo) {
    const start = day.getTime(); day.setDate(day.getDate() + 1);
    days.push({ start, end: day.getTime() });
  }
  const nowLabelLeft = nowX >= viewLeft && nowX <= viewLeft + laneWidth ? Math.max(viewLeft + 52, Math.min(nowX, viewLeft + laneWidth - 52)) : null;
  const scaleIndex = TIMELINE_HOURS.indexOf(preference.hours as typeof TIMELINE_HOURS[number]);
  const scaleWord = preference.hours === 168 ? t("timeline.week") : preference.hours >= 24 ? t("timeline.days", { count: preference.hours / 24 }) : t("timeline.hours", { count: preference.hours });
  const lane = (children: ReactNode) => <div className="bt-lane" style={{ width: canvas, backgroundSize: `${stepHours * HOUR * pxPerMs}px 100%`,
    backgroundPosition: `${(Math.ceil(from / (stepHours * HOUR)) * stepHours * HOUR - from) * pxPerMs}px 0` }}>{children}{nowLine}</div>;

  return <section ref={root} className="board-timeline" data-board-timeline="" data-phone={phone ? "1" : "0"} aria-label={t("timeline.title")}>
    <header className="bt-head">
      <div><span className="text-ui font-semibold text-secondary" data-timeline-count="">{t("timeline.tasks", { count: projection.tasks.length })}</span>
        <p className="bt-legend text-caption text-secondary">{t("timeline.legend")}</p></div>
      <div className="bt-zoom bar-slot" role="group" aria-label={t("timeline.scale")}>
        <button type="button" className={ZOOM_BUTTON} aria-label={t("timeline.zoomOut")} disabled={scaleIndex === TIMELINE_HOURS.length - 1} onClick={() => onPreference({ hours: TIMELINE_HOURS[scaleIndex + 1] })}><Minus size={15} aria-hidden /></button>
        <span className="min-w-[72px] whitespace-nowrap text-center text-ui font-semibold tabular-nums text-primary" data-timeline-scale="" aria-live="polite">{scaleWord}</span>
        <button type="button" className={ZOOM_BUTTON} aria-label={t("timeline.zoomIn")} disabled={scaleIndex === 0} onClick={() => onPreference({ hours: TIMELINE_HOURS[scaleIndex - 1] })}><Plus size={15} aria-hidden /></button>
      </div>
    </header>
    {!projection.tasks.length ? <div className="bt-empty"><strong>{t("timeline.empty")}</strong><p>{t("timeline.emptyHint")}</p></div> : <div ref={scroll} className="bt-scroll" data-timeline-scroll="" tabIndex={0} aria-label={t("timeline.chart")}
      onPointerDown={press} onTouchStart={press} onWheel={keepGesture} onKeyDown={keyStep}
      onScroll={event => {
        const element = event.currentTarget, state = gesture.current;
        setViewLeft(element.scrollLeft);
        if (state.active) { state.moved = true; keepGesture(); }
        if (element.scrollTop === previousTop.current) return;
        // A person's scrolling is never corrected; only a script-driven move is fitted to a row edge.
        if (state.active) { previousTop.current = element.scrollTop; state.placed = true; return; }
        fitRows();
      }}>
      <div style={{ width: canvas + labelWidth, "--bt-label": `${labelWidth}px`, "--bt-phone-width": `${width - (phone ? 0 : 17)}px` } as CSSProperties}>
        <div className="bt-axis">
          {phone ? null : <div className="bt-axis-label text-label text-secondary">{t("timeline.task")}</div>}
          <div className="bt-axis-lane" style={{ width: canvas }}>
            {days.map(day => {
              const left = Math.max(x(day.start), viewLeft);
              const right = Math.min(x(day.end), viewLeft + laneWidth);
              return right - left >= 52 ? <span className="bt-day text-caption text-secondary" key={day.start} style={{ left: left + 5 }}>{date(day.start)}</span> : null;
            })}
            {ticks.filter(ms => x(ms) >= viewLeft && x(ms) + 40 <= viewLeft + laneWidth && (nowLabelLeft === null || x(ms) + 40 <= nowLabelLeft - 46 || x(ms) >= nowLabelLeft + 46)).map(ms => <span className="bt-tick text-caption text-muted" key={ms} style={{ left: x(ms) }}>{time(ms)}</span>)}
            {nowLabelLeft !== null ? <span data-timeline-now-label="" className="bt-now-label text-caption font-semibold text-accent"
              style={{ left: nowLabelLeft }}>{t("timeline.now")} {time(nowMs)}</span> : null}{nowLine}
          </div>
        </div>
        {projection.tasks.map(task => {
          const title = tasksById.get(task.taskId)?.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
          const stages = task.pipelines.flatMap(pipeline => pipeline.attempts);
          const attempts = [...stages, ...task.agents];
          const current = attempts.findLast(attempt => attempt.live) ?? attempts.at(-1);
          const open = timelineExpanded(preference, task.taskId, task.live);
          const summaryBar = bar(task.startedAtMs, task.endAtMs);
          return <Fragment key={task.taskId}>
            <div className="bt-row bt-task" data-timeline-task={task.taskId} data-expanded={open ? "1" : "0"}>
              <div className="bt-label">
                <button type="button" className="bt-disclosure" data-timeline-expand="" aria-expanded={open} aria-label={t(open ? "timeline.collapse" : "timeline.expand", { title })}
                  onClick={() => onPreference({ expanded: { ...preference.expanded, [task.taskId]: !open } })}>
                  <ChevronRight size={14} className={open ? "rotate-90" : ""} aria-hidden />
                  <span className="bt-text"><span className="bt-title">{title}</span>{" "}
                    <span className="bt-meta">
                      <span>{elapsed(task.startedAtMs, task.endAtMs)}</span>{" "}
                      {stages.length || !task.agents.length ? <><span>{t("timeline.stages", { count: stages.length })}</span>{" "}</> : null}
                      {task.agents.length ? <><span>{t("mobile2.kanban.agents", { count: task.agents.length })}</span>{" "}</> : null}
                      {open ? null : current ? <span>{name(current)} · {stateWord(current)}</span> : <span>{t("timeline.waiting")}</span>}
                    </span>
                  </span>
                </button>
              </div>
              {lane(summaryBar ? <div className="bt-summary-bar" style={{ ...summaryBar, background: current ? tone(current).soft : "var(--color-sunken)" }} title={`${title}: ${elapsed(task.startedAtMs, task.endAtMs)}`}>
                <span className="bt-bracket" />
                {attempts.map(attempt => {
                  const bounds = attempt.observedTurn ? bar(attempt.observedTurn.startedAtMs, attempt.observedTurn.endAtMs) : null;
                  if (!bounds) return null;
                  return <span key={attempt.key} data-timeline-strip="" className="bt-strip" title={`${name(attempt)} · ${attempt.model ?? attempt.engine ?? ""} · ${stateWord(attempt)} · ${turnDuration(attempt)}`}
                    style={{ ...bounds, left: Number(bounds.left) - Number(summaryBar.left), background: agentColor(attempt) }} />;
                })}
              </div> : null)}
            </div>
            {open ? attempts.map(attempt => {
              const bounds = bar(attempt.startedAtMs, attempt.endAtMs);
              const work = attempt.observedTurn ? bar(attempt.observedTurn.startedAtMs, attempt.observedTurn.endAtMs) : null;
              const model = attempt.engine && attempt.model ? { engine: attempt.engine, model: attempt.model } : null;
              const earlier = hiddenBefore(attempt);
              return <div className="bt-row bt-stage" key={attempt.key} data-timeline-attempt={attempt.key} data-live={attempt.live ? "1" : "0"} data-earlier={earlier ? "1" : "0"}>
                <div className="bt-label">
                  <div className="bt-stage-name text-body font-semibold text-primary"><StageGlyph state={chipState(attempt)} model={model} fallback="mark" badge={false} live={attempt.live} /><span>{name(attempt)}</span></div>
                  <div className="bt-meta text-label text-secondary"><span>{stateWord(attempt)}</span><span>{elapsed(attempt.startedAtMs, attempt.endAtMs)}</span><span>{turnDuration(attempt)}</span></div>
                  <div className="bt-runtime text-caption text-secondary">{[attempt.engine, attempt.model].filter(Boolean).join(" · ")}</div>
                </div>
                {lane(bounds ? <>
                  <span className="bt-stage-bar" data-timeline-bar="" style={{ ...bounds, background: "transparent", borderColor: `color-mix(in srgb, ${tone(attempt).color} 60%, transparent)` }} title={`${name(attempt)} · ${elapsed(attempt.startedAtMs, attempt.endAtMs)} · ${turnDuration(attempt)}`} />
                  {work ? <span className="bt-stage-work" data-timeline-work="" style={{ ...work, background: agentColor(attempt) }} title={turnDuration(attempt)} /> : null}
                  {earlier ? <button type="button" className="bt-earlier text-label text-secondary" style={{ left: viewLeft + 6 }}
                    aria-label={t("timeline.reveal", { stage: name(attempt) })} onClick={() => { if (scroll.current) scroll.current.scrollLeft = Math.max(0, x(attempt.startedAtMs!) - 12); }}>‹ {date(attempt.startedAtMs!)} {time(attempt.startedAtMs!)}</button> : null}
                </> : null)}
              </div>;
            }) : null}
          </Fragment>;
        })}
      </div>
    </div>}
  </section>;
}
