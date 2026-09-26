"use client";

import { useLocale } from "@/lib/i18n";
import type { SeatDeputyView } from "@/lib/orchestrator/deputyView";

import { DeputyMark } from "../conversation/deputyInk";

/* The seat head and the seat card point at the running parallel self
   (docs/design/ghost-seat.md §6.5); the feed is its home. When it ends, both
   go and the block's collapsed line is the trace. */

/** The ask, cut for a chip. */
export function deputyAskLabel(deputy: Pick<SeatDeputyView, "ask">, limit = 40): string {
  const flat = deputy.ask.text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/** The running deputy of a seat, if any: the newest one not ended. */
export function liveSeatDeputy(deputies: readonly SeatDeputyView[] | null | undefined): SeatDeputyView | null {
  return deputies?.find((deputy) => deputy.state !== "ended") ?? null;
}

/** Brings the block into view in whichever feed shows it. */
export function scrollToDeputyBlock(askId: string): void {
  if (typeof document === "undefined") return;
  const block = [...document.querySelectorAll<HTMLElement>("[data-deputy-block]")].find((candidate) => candidate.dataset.deputyBlock === askId);
  if (!block) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  block.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
}

/** The outline twin at the seat avatar's lower right: 70 % of its size, 60 %
    overlapping it. */
export function DeputyTwin({ engine, avatarPx }: { engine: string; avatarPx: number }) {
  const { t } = useLocale();
  const size = Math.round(avatarPx * 0.7);
  const offset = Math.round(size * 0.4);
  return (
    <span
      data-deputy-twin
      role="img"
      aria-label={t("deputy.twin")}
      className="pointer-events-none absolute"
      style={{ width: size, height: size, right: -offset, bottom: -offset }}
    >
      <DeputyMark engine={engine} className="!h-full !w-full" />
    </span>
  );
}

/** «parallel · <ask>», beside the state badge; a click scrolls to the block. */
export function SeatDeputyChip({ deputy }: { deputy: SeatDeputyView }) {
  const { t } = useLocale();
  const ask = deputyAskLabel(deputy);
  return (
    <button
      type="button"
      data-seat-deputy-chip={deputy.askId}
      onClick={() => scrollToDeputyBlock(deputy.askId)}
      aria-label={t("deputy.chipAria", { ask })}
      title={deputy.ask.text}
      className="inline-flex min-h-6 min-w-0 max-w-[18rem] items-center gap-1.5 rounded-full border border-accent/35 bg-accent-soft px-2 py-0.5 text-label font-semibold text-accent hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 [@media(pointer:coarse)]:min-h-11"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
      <span className="min-w-0 truncate">{t("deputy.chip", { ask })}</span>
    </button>
  );
}
