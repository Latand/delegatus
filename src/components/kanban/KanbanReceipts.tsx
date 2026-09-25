"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";

/* Receipts: the board's one place for Undo, Retry and the outcome of a write
   (prototype `showReceipt`). Bottom-centre of the board's pane, over the
   columns, at most three, a countdown bar that pauses while the pointer or
   focus is inside. */

export interface ReceiptAction {
  label: string;
  run: () => void;
}

export interface Receipt {
  id: number;
  text: string;
  action?: ReceiptAction;
  error?: boolean;
  ttl: number;
}

const MAX_RECEIPTS = 3;

export function useReceipts() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const nextId = useRef(1);
  const show = useCallback((text: string, action?: ReceiptAction, options: { error?: boolean; ttl?: number } = {}) => {
    const id = nextId.current++;
    setReceipts((current) => [...current, { id, text, action, error: options.error, ttl: options.ttl ?? (options.error ? 12_000 : 7_000) }].slice(-MAX_RECEIPTS));
    return id;
  }, []);
  const dismiss = useCallback((id: number) => {
    setReceipts((current) => current.filter((receipt) => receipt.id !== id));
  }, []);
  return { receipts, show, dismiss };
}

function ReceiptView({ receipt, onDismiss }: { receipt: Receipt; onDismiss: (id: number) => void }) {
  const { t } = useLocale();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draining, setDraining] = useState(false);
  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onDismiss(receipt.id), receipt.ttl);
  }, [onDismiss, receipt.id, receipt.ttl]);
  const pause = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => {
    arm();
    const frame = requestAnimationFrame(() => setDraining(true));
    return () => {
      cancelAnimationFrame(frame);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [arm]);
  return (
    <div
      className={`receipt${receipt.error ? " error" : ""}`}
      data-kanban-receipt=""
      onPointerEnter={pause}
      onPointerLeave={arm}
      onFocus={pause}
      onBlur={arm}
    >
      <span className="msg">{receipt.text}</span>
      {receipt.action ? (
        <button
          type="button"
          className="act"
          onClick={() => {
            onDismiss(receipt.id);
            receipt.action!.run();
          }}
        >
          {receipt.action.label}
        </button>
      ) : null}
      <button type="button" className="close" aria-label={t("kanban.dismiss")} onClick={() => onDismiss(receipt.id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      <span
        className="bar-t"
        style={{ transition: `transform ${receipt.ttl}ms linear`, transform: draining ? "scaleX(0)" : "scaleX(1)" }}
      />
    </div>
  );
}

/* The stack stands over the columns and moves none of them. While it shows,
   its height is the pane's `--kb-receipts-inset`, which every column's card
   list adds to its bottom padding, so a list scrolled to its end brings its
   last card above the stack. When the stack shrinks, a list scrolled into the
   inset it loses keeps that padding until the reader scrolls back out of it,
   so no card jumps when a receipt leaves. */
function useColumnInset(stackRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const stack = stackRef.current;
    const pane = stack?.parentElement;
    if (!stack || !pane || typeof ResizeObserver === "undefined") return;
    let inset = 0;
    /* Each held list, with the inset its padding was held at. */
    const held = new Map<HTMLElement, { from: number; stop: () => void }>();
    const release = (list: HTMLElement) => {
      held.get(list)?.stop();
      held.delete(list);
      list.style.paddingBottom = "";
    };
    const hold = (list: HTMLElement, from: number, to: number) => {
      if (held.has(list) || list.scrollTop + list.clientHeight <= list.scrollHeight - (from - to) + 0.5) return;
      list.style.paddingBottom = getComputedStyle(list).paddingBottom;
      const onScroll = () => {
        if (list.scrollTop + list.clientHeight <= list.scrollHeight - Math.max(0, from - inset) + 0.5) release(list);
      };
      list.addEventListener("scroll", onScroll, { passive: true });
      held.set(list, { from, stop: () => list.removeEventListener("scroll", onScroll) });
    };
    const measure = () => {
      const next = stack.childElementCount ? Math.ceil(stack.getBoundingClientRect().height) : 0;
      if (next === inset) return;
      if (next < inset) pane.querySelectorAll<HTMLElement>(".col-body").forEach((list) => hold(list, inset, next));
      else [...held].forEach(([list, { from }]) => { if (from <= next) release(list); });
      inset = next;
      if (next) pane.style.setProperty("--kb-receipts-inset", `${next}px`);
      else pane.style.removeProperty("--kb-receipts-inset");
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stack);
    measure();
    return () => {
      observer.disconnect();
      [...held.keys()].forEach(release);
      pane.style.removeProperty("--kb-receipts-inset");
    };
  }, [stackRef]);
}

export function KanbanReceipts({ receipts, onDismiss }: { receipts: readonly Receipt[]; onDismiss: (id: number) => void }) {
  const stackRef = useRef<HTMLDivElement>(null);
  useColumnInset(stackRef);
  return (
    <div ref={stackRef} className="receipts" aria-live="polite" role="status">
      {receipts.map((receipt) => <ReceiptView key={receipt.id} receipt={receipt} onDismiss={onDismiss} />)}
    </div>
  );
}
