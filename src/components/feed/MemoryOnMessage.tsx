"use client";

import { useId, useState } from "react";

import { openArtifactPreview } from "@/components/preview/previewBus";
import { useLocale } from "@/lib/i18n";

import { Brain, ChevronDown, ChevronRight } from "../icons";
import { BUBBLE_MEASURE } from "./measure";
import type { MessageMemory } from "./messageProvenance";

/**
 * What shared memory did with an operator turn, under its bubble.
 *
 * Memories were added: a chip that says how many. It keeps the bubble's
 * trailing edge and measure, so it reads as a caption of that message and
 * never reaches into the agent's column. Pressing it opens the titles in
 * place, one per row and wrapped in full; a title with a chevron opens the
 * memory's own file in the document preview every file link opens.
 *
 * Candidates were judged and none was chosen: one muted line, with nothing to
 * press. Every other turn draws nothing here.
 *
 * On the phone the chip and each title are 44 px targets. The chip starts
 * below the copy control's own 44 px box and, while it is folded, hands the
 * part of its box past the text back to the gap under the row.
 */
const PHONE_MEASURE = "max-w-[86%]";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export function MemoryOnMessage({ memory, mobile }: { memory: MessageMemory; mobile: boolean }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const measure = mobile ? PHONE_MEASURE : BUBBLE_MEASURE;
  const count = memory.added.length;
  if (!count) {
    return memory.none
      ? <p data-memory-none className={`min-w-0 ${measure} text-right text-ui text-muted ${mobile ? "mt-1.5" : "mt-1"}`}>{t("memory.message.none")}</p>
      : null;
  }
  return (
    <div data-memory-offer className={`flex min-w-0 flex-col items-end ${measure} ${mobile ? `mt-1.5 ${open ? "" : "-mb-3"}` : "mt-1"}`}>
      <button
        type="button"
        data-memory-chip
        aria-expanded={open}
        aria-controls={listId}
        title={t("memory.message.added", { count })}
        onClick={() => setOpen(value => !value)}
        className={`-mr-1 inline-flex items-center gap-1 rounded-control px-1 text-ui font-medium text-secondary hover:bg-sunken hover:text-primary ${FOCUS} ${mobile ? "min-h-11 min-w-11 justify-end" : "py-0.5"}`}
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("memory.message.chip", { n: count })}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <ul id={listId} data-memory-titles className={open ? `inline-flex max-w-full flex-col items-stretch ${mobile ? "" : "mt-0.5 gap-1"}` : "hidden"}>
        {memory.added.map((entry, index) => {
          const row = `flex w-full min-w-0 gap-1.5 text-left text-ui text-secondary ${mobile ? "min-h-11 items-center py-1" : "items-start"}`;
          const title = <span className="min-w-0 flex-1 whitespace-normal break-words">{entry.title}</span>;
          return (
            <li key={index} className="min-w-0">
              {entry.path ? (
                <button
                  type="button"
                  data-memory-title
                  onClick={() => openArtifactPreview(entry.path!)}
                  className={`${row} rounded-control hover:text-primary hover:underline ${FOCUS}`}
                >
                  {title}
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted ${mobile ? "" : "mt-0.5"}`} aria-hidden />
                </button>
              ) : (
                <span data-memory-title className={row}>{title}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
