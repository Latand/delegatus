"use client";

import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Link2,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  Rocket,
  Send,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  conversationAvailabilitySnapshot,
  subscribeConversationAvailability,
  type ConversationAvailabilitySnapshot,
} from "@/lib/mcp/availability";
import { useLocale } from "@/lib/i18n";
import {
  describeMcpCall,
  mcpLinkLabel,
  type McpCallIcon,
  type McpCallLink,
} from "@/lib/mcp/presentation";

import { ContextTokensCaption } from "../feed/cards/ContextTokensCaption";
import type { ToolEvent } from "../feed/parse";
import { formatDuration, toolDurationMs } from "../feed/toolBlocks";
import { useIsMobile } from "@/hooks/useIsMobile";
import { hhmm } from "../utils";
import { mobileClock } from "../feed/cards/ToolCard";

const ICONS: Record<McpCallIcon, LucideIcon> = {
  bot: Bot,
  message: Send,
  task: ListTodo,
  pipeline: Workflow,
  link: Link2,
  conversation: MessagesSquare,
  deploy: Rocket,
  tool: Wrench,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resultError(result: unknown, fallback: string, failed: string): string {
  const value = record(result);
  const direct = typeof value.error === "string" ? value.error.trim() : "";
  const message = typeof record(value.error).message === "string"
    ? String(record(value.error).message).trim()
    : "";
  return direct || message || fallback.trim() || failed;
}

/* A conversation chip links only an id this Viewer has listed. */
function conversationUnavailable(link: McpCallLink, availability: ConversationAvailabilitySnapshot): boolean {
  return link.kind === "conversation" && (!availability.loaded || !availability.ids.has(link.id));
}

function useConversationAvailability(provided?: ReadonlySet<string>): ConversationAvailabilitySnapshot {
  const [snapshot, setSnapshot] = useState(conversationAvailabilitySnapshot);
  useEffect(() => {
    if (provided) return;
    return subscribeConversationAvailability(setSnapshot);
  }, [provided]);
  return provided ? { loaded: true, ids: provided } : snapshot;
}

function prettyPayload(args: unknown, result: unknown): string {
  try {
    return JSON.stringify({ arguments: args, ...(result === undefined ? {} : { result }) }, null, 2);
  } catch {
    return "Payload could not be serialized.";
  }
}

function navigateToEntity(event: React.MouseEvent<HTMLAnchorElement>, link: McpCallLink): void {
  if (link.kind === "conversation") return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("llv:mcp-navigate", {
    detail: { kind: link.kind, id: link.id },
  }));
}

function LinkChip({
  link,
  conversationAvailability,
  starting,
}: {
  link: McpCallLink;
  conversationAvailability: ConversationAvailabilitySnapshot;
  /** The call created this conversation and the scanner has not listed it yet. */
  starting: boolean;
}) {
  const { t } = useLocale();
  const label = mcpLinkLabel(t, link);
  const disabled = conversationUnavailable(link, conversationAvailability);
  const chip = "inline-flex min-h-6 items-center justify-center gap-1 max-[480px]:min-w-8 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition-colors [@media(pointer:coarse)]:min-h-8";
  const shared = `${chip} min-w-0 shrink`;
  if (disabled && starting) {
    /* The agent was accepted and does not exist yet: a word says so at every
       width, and nothing here links an id this Viewer has not listed. */
    return (
      <span
        data-testid={`mcp-link-${link.kind}`}
        data-link-pending
        aria-disabled="true"
        title={t("mcp.link.pendingHint")}
        className={`${chip} shrink-0 cursor-wait border-border bg-sunken text-muted`}
      >
        <Clock3 className="h-3 w-3 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">{t("mcp.link.pending")}</span>
      </span>
    );
  }
  if (disabled) {
    return (
      <span
        data-testid={`mcp-link-${link.kind}`}
        aria-disabled="true"
        title={t("mcp.link.pendingHint")}
        className={`${shared} cursor-wait border-border bg-sunken text-muted opacity-60`}
      >
        <MessageCircle className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate max-[480px]:sr-only">{label}</span>
      </span>
    );
  }
  return (
    <a
      data-testid={`mcp-link-${link.kind}`}
      href={link.href}
      title={label}
      onClick={(event) => navigateToEntity(event, link)}
      className={`${shared} border-accent/35 bg-accent-soft text-accent hover:border-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45`}
    >
      {link.kind === "conversation" ? <MessageCircle className="h-3 w-3 shrink-0" aria-hidden /> : <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="truncate max-[480px]:sr-only">{label}</span>
    </a>
  );
}

export function McpCallCard({
  event,
  availableConversationIds,
  grouped = false,
}: {
  event: ToolEvent;
  availableConversationIds?: ReadonlySet<string>;
  /** A member of an opened group, which already carries the indent. */
  grouped?: boolean;
}) {
  const { t } = useLocale();
  const mcp = event.mcp;
  const result = mcp?.result;
  const description = useMemo(
    () => describeMcpCall(mcp?.toolName ?? event.tool, mcp?.args ?? {}, result, t),
    [event.tool, mcp?.args, mcp?.toolName, result, t],
  );
  const conversationAvailability = useConversationAvailability(availableConversationIds);
  const state = event.status === "run" ? "pending" : event.status === "err" ? "error" : "success";
  const Icon = ICONS[description.icon];
  const replayed = record(result).replayed === true || record(result).replay === true;
  const retryable = record(result).retryable === true;
  const error = state === "error" ? resultError(result, event.outputPreview, t("mcp.call.failed")) : "";
  /* A spawn the call accepted whose conversation is not listed yet: the call
     succeeded, the agent does not exist, so the row claims no success. */
  const starting = state === "success" && description.links.some((link) => link.creates && conversationUnavailable(link, conversationAvailability));
  const tone = state === "error" ? "text-danger" : state === "success" && !starting ? "text-success" : "text-accent";
  const payload = useMemo(() => prettyPayload(mcp?.args ?? {}, result), [mcp?.args, result]);
  const durationMs = toolDurationMs(event);
  const duration = durationMs === undefined ? "" : formatDuration(durationMs);
  /* The phone's row runs out of width first: like every tool row there, its
     time is HH:MM, so the token caption never pushes the clock off the edge. */
  const isMobile = useIsMobile();
  const time = isMobile ? mobileClock(event.ts) : hhmm(event.ts);

  /* Compact contract: one dense row — action meaning first, chrome last.
     The title (which already carries the useful payload, e.g. the message text
     of a send_message call) truncates inline; state lives in the icon color and
     a small glyph instead of a separate "Completed" row; ids/paths/payload sit
     behind the quiet Details disclosure. An error is never quiet: its text gets
     its own visible line under the row. */
  return (
    <article data-testid="mcp-call-card" data-state={state} className={`group/mcp relative ${grouped ? "" : "my-1 ml-9"}`}>
      {state === "pending" ? (
        <div data-testid="mcp-call-progress" className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-gradient-to-r from-transparent via-accent to-transparent" />
      ) : null}
      <details className="min-w-0">
        <summary className="@container flex min-w-0 cursor-pointer list-none flex-nowrap items-center gap-x-2 max-[480px]:gap-x-1.5 overflow-hidden rounded-control py-0.5 text-ui hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
          <Icon
            className={`h-3.5 w-3.5 shrink-0 ${tone} ${state === "pending" ? "animate-pulse" : ""}`}
            aria-hidden
          />
          {/* One line, never wrapped (operator decision, docs/design/seat-panel-noise.md
              b2). The row gives way in a fixed order: the trailing metadata leaves
              first (its shrink outweighs every other part's), then the server
              label, then the title cuts with an ellipsis down to a floor of its
              own (#1955), and the entity chips cut their label last. The whole
              text stays in the title tooltip and the Details disclosure.
              The label and the title share a one-line box that wraps: the title
              is placed first, so a label that no longer fits beside the whole
              title moves to the hidden second line and leaves no gap, and only
              then does the title shrink. */}
          <span data-mcp-heading className="flex h-[1lh] min-w-[6rem] flex-auto flex-row-reverse flex-wrap items-center gap-x-2 overflow-hidden max-[480px]:gap-x-1.5">
            <span data-mcp-title className="min-w-[6rem] flex-auto truncate font-semibold text-secondary" title={description.tooltip ?? description.title}>
              {description.title}
            </span>
            {/* Every card here is a Viewer call, so a narrow row also hides this
                label outright. */}
            <span data-mcp-server className="shrink-0 whitespace-nowrap font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted @max-[26rem]:hidden">
              MCP · {mcp?.serverName ?? "viewer"}
            </span>
          </span>
          {replayed ? <span data-testid="mcp-replay" className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent">{t("mcp.call.replay")}</span> : null}
          {retryable ? <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-0.5 text-[10px] font-bold text-danger">{t("mcp.call.retryable")}</span> : null}
          {description.links.map((link) => (
            <LinkChip
              key={`${link.kind}:${link.id}`}
              link={link}
              conversationAvailability={conversationAvailability}
              starting={state === "success" && link.creates === true}
            />
          ))}
          {/* A starting spawn's chip already reads "starting" with its clock,
              so the row shows no second outcome glyph for the same fact. */}
          {starting ? null : (
            <span
              data-mcp-outcome={state}
              className={`inline-flex shrink-0 items-center ${tone}`}
              role={state === "pending" ? "status" : undefined}
              aria-label={state === "pending" ? `${description.verb}…` : state}
            >
              {state === "pending" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                : state === "success" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
            </span>
          )}
          {/* Duration, tokens and time are the row's least needed facts: when the
              line is short they leave whole, duration with its tokens first, then
              the time. Each one that does not fit wraps onto a second line this
              one-line box never shows, so none is ever cut part way; the empty
              first item lets even the time wrap away, and its full line height
              keeps the first line tall, so the wrapped line starts below the box. */}
          {duration || event.contextTokens || time ? (
            <span data-mcp-meta className="flex h-4 min-w-0 shrink-[1000000] flex-row-reverse flex-wrap items-center overflow-hidden leading-4">
              <span data-mcp-meta-floor className="h-4 w-0 shrink-0" aria-hidden />
              {time ? <span className="shrink-0 text-caption tabular-nums text-muted">{time}</span> : null}
              {duration || event.contextTokens ? (
                <span className={`flex shrink-0 items-center whitespace-nowrap ${time ? "mr-2 max-[480px]:mr-1.5" : ""}`}>
                  {duration ? <span className="text-caption tabular-nums text-muted">{duration}</span> : null}
                  <ContextTokensCaption value={event.contextTokens} lead={Boolean(duration)} />
                </span>
              ) : null}
            </span>
          ) : null}
        </summary>
        <div className="ml-5 mt-1 text-[10.5px] text-muted">
          {description.subtitle ? (
            <div className="mb-1 truncate font-mono" title={description.subtitle}>{description.subtitle}</div>
          ) : null}
          <pre className="max-h-[320px] max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-t border-border pt-1.5 font-mono text-[10.5px] text-secondary">{payload}</pre>
        </div>
      </details>
      {state === "error" ? (
        <div className="ml-5 border-l-2 border-danger pl-2 text-[11px] font-semibold text-danger">{error}</div>
      ) : null}
    </article>
  );
}
