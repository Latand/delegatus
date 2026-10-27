"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { ReaderPlacement } from "./KanbanReaders";

/**
 * Where the agent window stands (docs/design/agent-window.md, Variant 1).
 *
 * From `AGENT_WINDOW_BESIDE` px wide the window covers the board below its
 * header row, with even margins, so the header and the sidebar are dimmed
 * whole and no text row is sliced; narrower, it covers the viewport. The list
 * is its left column. The reader's park is laid out at the reader's size, so
 * every open agent waits with the layout it will be shown in.
 *
 * The geometry is written onto the board as custom properties, measured on
 * every resize whether or not the window is open: the park needs it too.
 */

export const AGENT_WINDOW_BESIDE = 1100;
export const AGENT_WINDOW_MARGIN = 8;
/** The list's column: 248 px on a large screen, 220 px below 1200 px. */
export const agentWindowListWidth = (viewport: number): number => (viewport >= 1200 ? 248 : 220);
/** A new agent's first read past this shows the reader as it is. */
export const READER_READY_LIMIT_MS = 1200;

export interface AgentWindowBox {
  region: { top: number; left: number; width: number; height: number };
  window: { top: number; left: number; width: number; height: number };
  list: number;
}

export function agentWindowBox(viewport: { width: number; height: number }, board: { top: number; left: number; right: number; bottom: number } | null): AgentWindowBox {
  const beside = board !== null && viewport.width >= AGENT_WINDOW_BESIDE;
  const region = beside
    ? { top: board.top, left: board.left, width: Math.max(0, board.right - board.left), height: Math.max(0, board.bottom - board.top) }
    : { top: 0, left: 0, width: viewport.width, height: viewport.height };
  const margin = AGENT_WINDOW_MARGIN;
  return {
    region,
    window: { top: region.top + margin, left: region.left + margin, width: Math.max(0, region.width - 2 * margin), height: Math.max(0, region.height - 2 * margin) },
    list: agentWindowListWidth(viewport.width),
  };
}

/** Measures the board below its header rows and writes the window's box
    onto `rootRef`'s element. */
export function useAgentWindowGeometry(rootRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const apply = () => {
      const rect = root.getBoundingClientRect();
      /* The header row. */
      const rows = root.querySelectorAll<HTMLElement>(":scope > .bar");
      let top = rect.top;
      for (const row of rows) top = Math.max(top, row.getBoundingClientRect().bottom);
      const box = agentWindowBox(
        { width: window.innerWidth, height: window.innerHeight },
        { top, left: rect.left, right: rect.right, bottom: rect.bottom },
      );
      const set = (name: string, value: number) => root.style.setProperty(name, `${Math.round(value)}px`);
      set("--aw-region-top", box.region.top);
      set("--aw-region-left", box.region.left);
      set("--aw-region-width", box.region.width);
      set("--aw-region-height", box.region.height);
      set("--aw-top", box.window.top);
      set("--aw-left", box.window.left);
      set("--aw-width", box.window.width);
      set("--aw-height", box.window.height);
      set("--aw-list-w", box.list);
    };
    apply();
    window.addEventListener("resize", apply);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(root);
    const bar = root.querySelector<HTMLElement>(":scope > .bar");
    if (bar) observer?.observe(bar);
    /* The reason filters come and go under the header with its width. Only a header row counts: the dragged card's
       ghost and hint are added and removed here too, and a forced layout for each is what the drag pays at its start. */
    const isRow = (node: Node) => node instanceof HTMLElement && node.matches(".bar");
    const rows = typeof MutationObserver === "function"
      ? new MutationObserver((records) => { if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(isRow))) apply(); })
      : null;
    rows?.observe(root, { childList: true });
    return () => {
      window.removeEventListener("resize", apply);
      observer?.disconnect();
      rows?.disconnect();
    };
  }, [rootRef]);
}

/** A reader is ready once its feed has said what it holds. */
export function readerReady(container: HTMLElement | null): boolean {
  const state = container?.querySelector<HTMLElement>("[data-feed-state]")?.dataset.feedState;
  return state === "items" || state === "empty" || state === "error";
}

/**
 * Calls `onReady(key)` once the reader for `key` is ready to be shown: in the
 * same commit for one that already is (it waited laid out in the park, at the
 * reader's size), else once its feed has held one box and one scroll position
 * for two frames after it became ready, or after `READER_READY_LIMIT_MS`
 * whatever it holds. A first read becomes ready before the feed has followed
 * its tail or restored its place, and the reader must not be shown between.
 */
export function useReaderReady(placement: ReaderPlacement, key: string | null, onReady: (key: string) => void): void {
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  useLayoutEffect(() => {
    if (!key) return;
    if (readerReady(placement.containerOf(key))) {
      ready.current(key);
      return;
    }
    const started = performance.now();
    let frames = 0;
    let previous: string | null = null;
    let frame = requestAnimationFrame(function tick() {
      const container = placement.containerOf(key);
      const feed = container?.querySelector<HTMLElement>("[data-log-feed-scroller]");
      const sample = !readerReady(container) ? null : feed ? `${feed.clientWidth}:${feed.clientHeight}:${feed.scrollHeight}:${feed.scrollTop}` : "ready";
      frames = sample !== null && sample === previous ? frames + 1 : 0;
      previous = sample;
      if (frames >= 2 || performance.now() - started >= READER_READY_LIMIT_MS) {
        ready.current(key);
        return;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [placement, key]);
}
