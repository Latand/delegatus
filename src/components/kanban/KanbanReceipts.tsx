"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

/* Receipts: the board's one place for Undo, Retry and the outcome of a write
   (prototype `showReceipt`). Bottom-centre, at most three, a countdown bar that
   pauses while the pointer or focus is inside. */

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

export function KanbanReceipts({ receipts, onDismiss }: { receipts: readonly Receipt[]; onDismiss: (id: number) => void }) {
  return (
    <div className="receipts" aria-live="polite" role="status">
      {receipts.map((receipt) => <ReceiptView key={receipt.id} receipt={receipt} onDismiss={onDismiss} />)}
    </div>
  );
}
