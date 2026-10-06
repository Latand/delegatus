"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useLocale } from "@/lib/i18n";
import { splitRelayMessageText } from "@/lib/orchestrator/relayText";

/** A message this long is taken as clamped until the browser has measured it. */
const LONG_MESSAGE_CHARS = 160;

/**
 * One delivery whose fate nobody can establish yet, as the operator reads it
 * in the composer's delivery details: the message itself on two lines, one
 * sentence on what Retry and Discard do, and the two controls at the size the
 * settled chips use. The notice line above says the status of the delivery it
 * speaks for, so that card keeps the word for assistive technology only
 * (`statusShown` false); any other delivery shows its own.
 *
 * An orchestrator relay opens with a fixed preamble. Here it is a short label
 * naming the source project, and the handoff's own words are the message.
 */
export function DeliveryCheckCard({ operationId, text, status, statusShown, detail, pending = false, children }: {
  operationId: string;
  text: string | null;
  status: string;
  statusShown: boolean;
  detail: string;
  /** The operation has not settled, which a message row publishes. */
  pending?: boolean;
  /** The delivery's own controls, drawn by the caller that owns their rules. */
  children: ReactNode;
}) {
  const { t } = useLocale();
  const relay = text ? splitRelayMessageText(text) : null;
  const body = relay ? relay.body : text;
  const [expanded, setExpanded] = useState(false);
  const message = useRef<HTMLParagraphElement>(null);
  /* Collapsed, a line break reads as a space, so a multi-line message always
     has more to show whatever its height. */
  const multiline = Boolean(body?.includes("\n"));
  const [clamped, setClamped] = useState(() => Boolean(body) && body!.length > LONG_MESSAGE_CHARS);
  /* The disclosure is closed at mount, so the message has no box to measure
     until the operator opens it; the observer reads it then and at every
     width after. Without layout (a test DOM) the length estimate stands. */
  useEffect(() => {
    const element = message.current;
    if (!element || expanded || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (element.clientHeight > 0) setClamped(element.scrollHeight > element.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [body, expanded]);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-control bg-card/70 px-2 py-1 text-left"
      data-delivery-check-card
      data-operation={operationId}
      {...(body ? {} : { "data-receipt-standalone-row": "" })}
      {...(pending && body ? { "data-optimistic-message": "true" } : {})}
    >
      {relay ? (
        <span
          className="min-w-0 truncate text-[11px] font-semibold text-muted"
          data-receipt-relay-label
          title={t("composer.relayLabelTitle", { project: relay.project })}
        >
          {t("composer.relayLabel", { project: relay.project })}
        </span>
      ) : null}
      {body ? (
        <p
          ref={message}
          /* Collapsed, paragraphs run together: a blank line between them
             would otherwise be the whole second line. Expanded, a long
             handoff scrolls in its own box so the two controls stay in view. */
          className={`min-w-0 break-words text-secondary ${expanded ? "max-h-24 overflow-y-auto overscroll-contain whitespace-pre-wrap" : "line-clamp-2"}`}
          data-receipt-message
        >
          {body}
        </p>
      ) : null}
      <span role="status" className={statusShown ? "text-caption font-semibold text-warning" : "sr-only"}>{status}</span>
      <p className="min-w-0 break-words text-caption text-muted" data-receipt-uncertain-why>{detail}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-semibold">
        {children}
        {body && (multiline || clamped || expanded) ? (
          <button
            type="button"
            data-receipt-message-toggle
            aria-expanded={expanded}
            className="ml-auto min-h-11 rounded-control px-1 font-normal text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
            onClick={() => setExpanded((open) => !open)}
          >
            {t(expanded ? "composer.messageCollapse" : "composer.messageExpand")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
