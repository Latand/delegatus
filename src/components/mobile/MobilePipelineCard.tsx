"use client";

import { useMemo } from "react";

import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";

import { summarizePipeline } from "../kanban/kanbanModel";
import { pipelineTitle } from "../kanban/PipelineSection";
import { PipelineBlock } from "../pipelines/PipelineBlock";
import { pipelineEnded, pipelineNeedsYou } from "../pipelines/pipelineBlockModel";
import { pipelineStateLabel } from "../pipelines/pipelineModel";

/*
 * One pipeline as a phone card (#2072 slice 3; docs/design/phone-kanban.md
 * §3.4, §3.13): its title, two lines at most, the state badge when it waits
 * on the operator, and the one pipeline block at card density — the stage
 * chain on one line, the age, the PR as passive text and, when it needs the
 * operator, the reason in warning ink. The whole card is one button.
 *
 * Today's Needs you rows and the pipelines list draw it; the phone kanban's
 * columns (slice 4) put the same block on a task's card.
 */

const CARD = "flex w-full min-h-14 items-start gap-2.5 rounded-[12px] bg-card py-2 pl-3 pr-2.5 text-left shadow-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40";
/* The edge is the card's one status hue, the warning of a lane that waits on
   the operator; the badge and the reason line repeat it. */
const NEEDS_EDGE = "shadow-[inset_3px_0_0_var(--color-warning),var(--shadow-1)]";
const QUIET = "bg-quiet shadow-none ring-1 ring-inset ring-border";

const NO_FLOWS: ReadonlyMap<string, Flow> = new Map();

export function MobilePipelineCard({ pipeline, now, flowsById = NO_FLOWS, onOpen, label, quiet = false, dataAttributes }: {
  pipeline: Pipeline;
  /** Epoch seconds; the dashboard's ticking clock keeps the ages honest. */
  now: number;
  flowsById?: ReadonlyMap<string, Flow>;
  /** Absent, the card is a statement rather than a button that does nothing. */
  onOpen?: (pipeline: Pipeline) => void;
  /** The button's accessible name. */
  label: string;
  /** Completed lanes read quieter than live ones. */
  quiet?: boolean;
  dataAttributes?: Record<string, string | undefined>;
}) {
  const { t } = useLocale();
  const summary = useMemo(() => summarizePipeline(pipeline, flowsById), [pipeline, flowsById]);
  const needs = pipelineNeedsYou(pipeline);
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: () => onOpen(pipeline), "aria-label": label } : {})}
      {...dataAttributes}
      data-mobile2-state={pipeline.state}
      className={`${CARD} ${quiet || pipelineEnded(pipeline) ? QUIET : ""} ${needs ? NEEDS_EDGE : ""}`}
    >
      {/* The board's rows keep an 8 px dot column, so a card's title starts on
          the same line as a conversation row's beside it; on a card the chain
          says the state, so the dot itself is never drawn. */}
      <span aria-hidden className="invisible mt-1.5 h-2 w-2 shrink-0 rounded-full" />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 items-start gap-2">
          <span data-mobile2-pipeline-title className={`min-w-0 flex-1 line-clamp-2 text-body font-semibold leading-[1.25] ${quiet ? "text-secondary" : "text-primary"}`}>
            {pipelineTitle(t, pipeline)}
          </span>
          {needs ? <span className="pstate-chip mt-px" data-pstate={pipeline.state}>{pipelineStateLabel(t, pipeline.state)}</span> : null}
        </span>
        <PipelineBlock summary={summary} density="card" nowMs={now * 1000} />
      </span>
    </Tag>
  );
}
