"use client";

import {
  Bot,
  CheckCircle2,
  CircleAlert,
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
import { useMemo, useSyncExternalStore } from "react";

import type { RuntimeLiveTurnItem, RuntimeLiveTurnTool } from "@/lib/runtime/liveTurn";
import { useLocale } from "@/lib/i18n";
import {
  conversationAvailabilitySnapshot,
  subscribeConversationAvailability,
  type ConversationAvailabilitySnapshot,
} from "@/lib/mcp/availability";
import {
  describeMcpCall,
  isViewerMcpServer,
  type McpCallIcon,
  type McpCallLink,
} from "@/lib/mcp/presentation";
import { GlyphIcon } from "@/components/icons";
import { StatusIcon } from "@/components/feed/cards/shared";
import { StreamingMd } from "@/components/feed/markdown";
import { summarizeTool } from "@/components/feed/tools";

/**
 * How many live rows the overlay may paint at once.
 *
 * The overlay is the in-flight tail of the turn, never a second copy of what
 * the canonical feed carries — every row it shows is a row that feed is about
 * to carry anyway. Its only bound used to be the canonical claim, which is a condition
 * OUTSIDE this component — the transcript window has to be current for a row to
 * be claimed or to fall behind the #674 fence. A pane whose tail is paused
 * (`BranchPane`: dormant or offscreen) keeps its transcript window frozen while
 * the runtime store keeps projecting items into the same turn, and then every
 * unclaimed item — up to 544 of them, 32 active plus 512 overflow — reaches the
 * renderer at once. That is the reported wall.
 *
 * Eight is the tail an operator can actually read: at 390 px a quiet row is
 * ~20 px, so eight rows are the ~160 px that fit between the last transcript
 * card and the composer without scrolling, and one Claude message issues at
 * most a handful of parallel calls, so the whole in-flight batch still fits.
 * Everything older collapses into one counted line; the transcript is the
 * authority on it.
 */
export const LIVE_TURN_VISIBLE_ROWS = 8;

const MCP_ICONS: Record<McpCallIcon, LucideIcon> = {
  bot: Bot,
  message: Send,
  task: ListTodo,
  pipeline: Workflow,
  link: Link2,
  conversation: MessagesSquare,
  deploy: Rocket,
  tool: Wrench,
};

/* A Codex file change arrives on the event stream as a header-only patch (the
   file list, no hunks): the shared summarizer counts changed lines and has none
   to show, so the row names the touched files instead of a bare "Edit". */
const PATCH_FILE_RE = /^\*{0,3}\s*(?:Add|Update|Delete) File:\s*(.+)$/;
function patchFileNames(input: unknown): string {
  if (typeof input !== "string") return "";
  const names = input.split("\n").flatMap((line) => {
    const match = line.match(PATCH_FILE_RE);
    if (!match) return [];
    const filePath = match[1]!.trim().replace(/[/\\]+$/, "");
    return [filePath.split(/[/\\]/).pop() || filePath];
  });
  return names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "");
}

/** The Viewer MCP call a live tool name denotes, or null for anything else.
    Mirrors the parser's own split of `mcp__<server>__<tool>`: the canonical row
    for such a call is an `McpCallCard`, not a `ToolLine`, so the live row has to
    recognise it to read the same way. */
function viewerMcpIdentity(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const identity = name.slice("mcp__".length);
  const separator = identity.indexOf("__");
  if (separator <= 0 || separator === identity.length - 2) return null;
  const serverName = identity.slice(0, separator);
  const toolName = identity.slice(separator + 2);
  return isViewerMcpServer(serverName) ? { serverName, toolName } : null;
}

/** A row the list can actually say something with. A call whose arguments the
    window's bound shed has nothing left but its own name, and a wall of
    "<tool> · arguments omitted" is the defect itself — such a row belongs in
    the collapsed count, never in the list. */
function listable(item: RuntimeLiveTurnItem): boolean {
  if (item.tool) return !item.tool.argsOmitted;
  return item.text.trim().length > 0;
}

/** How many steps of the turn one item stands for: the items an explicit
    omission descriptor already folded, plus itself when it carries a call or a
    written line. An empty streaming placeholder stands for nothing yet. */
function steps(item: RuntimeLiveTurnItem): number {
  return (item.omittedItems ?? 0) + (item.tool || item.text.trim() ? 1 : 0);
}

export interface LiveTurnTail {
  /** The newest listable rows, in response order. */
  rows: RuntimeLiveTurnItem[];
  /** Steps of this turn the overlay is not showing. */
  earlier: number;
}

/**
 * The in-flight tail of a live turn: at most `limit` rows, the newest ones.
 *
 * The window is taken from the end FIRST and filtered afterwards, never the
 * other way round: pulling an older listable row forward to fill a slot would
 * paint an old step under fresher ones, which is the ordering defect #674 fixed
 * in the claim path. Everything outside the window, and everything inside it
 * with nothing left to say, is counted instead.
 */
export function liveTurnTail(
  items: readonly RuntimeLiveTurnItem[],
  limit: number = LIVE_TURN_VISIBLE_ROWS,
): LiveTurnTail {
  const start = Math.max(0, items.length - Math.max(0, limit));
  const rows: RuntimeLiveTurnItem[] = [];
  let earlier = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const shown = index >= start && listable(item);
    if (shown) rows.push(item);
    /* A shown row still hides whatever its own descriptor folded away. */
    earlier += shown ? item.omittedItems ?? 0 : steps(item);
  }
  return { rows, earlier };
}

function useConversationAvailability(): ConversationAvailabilitySnapshot {
  return useSyncExternalStore(
    subscribeConversationAvailability,
    conversationAvailabilitySnapshot,
    conversationAvailabilitySnapshot,
  );
}

/* The canonical card's own entity chip, on the live row. A conversation the
   scanner has not attributed yet is not navigable there and is not here
   either — the chip says so and waits, exactly as the card's does. */
function LiveMcpLinkChip({
  link,
  availability,
}: {
  link: McpCallLink;
  availability: ConversationAvailabilitySnapshot;
}) {
  const shared = "inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition-colors [@media(pointer:coarse)]:min-h-8";
  if (link.kind === "conversation" && (!availability.loaded || !availability.ids.has(link.id))) {
    return (
      <span
        data-live-mcp-link={link.kind}
        aria-disabled="true"
        className={`${shared} cursor-wait border-border bg-sunken text-muted opacity-60`}
      >
        <MessageCircle className="h-3 w-3" aria-hidden />
        {link.label}
      </span>
    );
  }
  return (
    <a
      data-live-mcp-link={link.kind}
      href={link.href}
      onClick={(event) => {
        if (link.kind === "conversation") return;
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("llv:mcp-navigate", { detail: { kind: link.kind, id: link.id } }));
      }}
      className={`${shared} border-accent/35 bg-accent-soft text-accent hover:border-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45`}
    >
      {link.kind === "conversation" ? <MessageCircle className="h-3 w-3" aria-hidden /> : <ExternalLink className="h-3 w-3" aria-hidden />}
      {link.label}
    </a>
  );
}

/**
 * What a live call's status says about its outcome.
 *
 * `unknown` is its own state, never `success`: the runtime journal's bound
 * dropped that call's result, so what happened to it is not known and may have
 * been a failure. Painting a green check there would assert something the
 * Viewer does not know — and the generic row has always kept the distinction,
 * so the MCP row has to as well.
 */
type LiveCallState = "pending" | "error" | "success" | "outcome-omitted";

function liveCallState(status: RuntimeLiveTurnTool["status"]): LiveCallState {
  return status === "run"
    ? "pending"
    : status === "err"
      ? "error"
      : status === "unknown"
        ? "outcome-omitted"
        : "success";
}

/** The tone of the row's own glyph. An outcome nobody knows is quiet. */
function liveStateTone(state: LiveCallState): string {
  return state === "error"
    ? "text-danger"
    : state === "success"
      ? "text-success"
      : state === "pending"
        ? "text-accent"
        : "text-muted";
}

/* A Viewer MCP call whose canonical row is an McpCallCard, so the live row
   reads through the SAME `describeMcpCall` the card does and wears the same
   summary grammar: the MCP · <server> mark, the call's meaning, and the entity
   chips. The card is passed no result here because the live row has none —
   which is exactly the card's own state while the call is still out, so the
   line does not change when the transcript row replaces it. The card's
   disclosure (ids, the whole payload) stays on the card: the live row is one
   line, and what the call returned is not known yet.

   The title is what the operator reads, so it is what gets the width. Badge,
   chips and outcome are all intrinsically sized, and on one flex line the
   title was the only thing left able to shrink — at 390 px with two entity
   chips it collapsed to about a pixel of its own row. Giving it a flex basis
   makes it the item that claims the line instead: a chip that no longer fits
   beside it wraps to the next line of the same block, where it stays a full,
   tappable chip. */
function LiveMcpRow({
  item,
  tool,
  identity,
}: {
  item: RuntimeLiveTurnItem;
  tool: RuntimeLiveTurnTool;
  identity: { serverName: string; toolName: string };
}) {
  const { t } = useLocale();
  const availability = useConversationAvailability();
  const description = useMemo(
    () => describeMcpCall(identity.toolName, tool.args),
    [identity.toolName, tool.args],
  );
  const state = liveCallState(tool.status);
  const tone = liveStateTone(state);
  const Icon = MCP_ICONS[description.icon];
  return (
    <div
      data-live-turn
      data-live-turn-item-id={item.itemId ?? undefined}
      data-live-tool={tool.name}
      data-live-tool-status={tool.status}
      data-live-mcp={identity.toolName}
      data-live-mcp-state={state}
      className="ml-9 flex min-w-0 items-start gap-x-2 rounded-control py-0.5 text-ui"
    >
      <Icon
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone} ${state === "pending" ? "animate-pulse" : ""}`}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted">
          MCP · {identity.serverName}
        </span>
        <span
          data-live-mcp-title
          className="min-w-0 grow basis-[10rem] truncate font-semibold text-secondary"
          title={description.title}
        >
          {description.title}
        </span>
        {description.links.map((link) => (
          <LiveMcpLinkChip key={`${link.kind}:${link.id}`} link={link} availability={availability} />
        ))}
        {/* The only outcome that is a word rather than a mark, so it wraps
            with the chips instead of reserving a column of its own — holding
            one would cost the title the line a second time. */}
        {state === "outcome-omitted" ? (
          <span data-live-mcp-outcome="omitted" className="shrink-0 text-caption font-semibold text-muted">
            {t("feed.liveToolOutcomeOmitted")}
          </span>
        ) : null}
      </div>
      {state === "outcome-omitted" ? null : (
        <span
          className={`mt-0.5 inline-flex shrink-0 items-center ${tone}`}
          role={state === "pending" ? "status" : undefined}
          aria-label={state === "pending" ? `${description.verb}…` : state}
        >
          {state === "pending"
            ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            : state === "success"
              ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
        </span>
      )}
    </div>
  );
}

/* A live tool row is the same call its transcript echo will carry a moment
   later, so it reads through the same summarizer and the same quiet ToolLine
   grammar (glyph · summary · non-ok status) — the row must not change
   appearance when the canonical card replaces it. It has no body: the call's
   output lives in the transcript, and this row only says the call happened,
   is running, or failed. */
function LiveToolRow({ item, tool }: { item: RuntimeLiveTurnItem; tool: RuntimeLiveTurnTool }) {
  const { t } = useLocale();
  const summary = useMemo(() => summarizeTool(tool.name, tool.args, tool.engine), [tool.name, tool.args, tool.engine]);
  const state = liveCallState(tool.status);
  const isErr = state === "error";
  /* `unknown` is a finished call whose result the journal's bound could not
     retain: no spinner (it is not running), no check (its outcome is not
     known), just the word for what happened to it. */
  const label = state === "pending"
    ? t("render.executing")
    : state === "error"
      ? t("render.error")
      : state === "outcome-omitted"
        ? t("feed.liveToolOutcomeOmitted")
        : "";
  const files = tool.name === "apply_patch" && !summary.chips.length ? patchFileNames(tool.args.input) : "";
  const detail = files ? `${summary.summary} · ${files}` : summary.summary;
  return (
    <div
      data-live-turn
      data-live-turn-item-id={item.itemId ?? undefined}
      data-live-tool={tool.name}
      data-live-tool-status={tool.status}
      className={`ml-9 flex items-center gap-2 rounded-control py-0.5 text-ui ${
        isErr ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1 text-danger" : "text-muted"
      }`}
    >
      <GlyphIcon name={summary.icon} className="h-3.5 w-3.5 shrink-0" />
      <span className={`min-w-0 flex-1 truncate ${isErr ? "font-semibold" : "text-secondary"}`} title={detail}>
        {detail}
      </span>
      {state !== "success" ? (
        <span className={`inline-flex shrink-0 items-center gap-1 text-caption font-semibold ${isErr ? "text-danger" : "text-muted"}`}>
          {state !== "outcome-omitted" ? <StatusIcon status={tool.status} className="h-3 w-3" /> : null}
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** One live tool row, in the grammar of the canonical row that will replace
    it: an McpCallCard line for a Viewer MCP call, a quiet ToolLine otherwise. */
function LiveCallRow({ item, tool }: { item: RuntimeLiveTurnItem; tool: RuntimeLiveTurnTool }) {
  const identity = viewerMcpIdentity(tool.name);
  return identity
    ? <LiveMcpRow item={item} tool={tool} identity={identity} />
    : <LiveToolRow item={item} tool={tool} />;
}

/* A live prose row is the same message its transcript echo will carry a moment
   later, so it goes through the same markdown grammar — otherwise the text
   visibly changes appearance when the echo lands. While the item is still
   streaming, StreamingMd holds the unfinished tail as plain text instead of
   guessing at a construct whose closer has not arrived. Tool rows interleave
   with prose in response order (issue #1100), each rendered by LiveCallRow.
   What reaches this component is the whole unclaimed overlay; what it paints is
   `liveTurnTail` of it. */
export function LiveTurnRows({ items }: { items: readonly RuntimeLiveTurnItem[] }) {
  const { t } = useLocale();
  const { rows, earlier } = useMemo(() => liveTurnTail(items), [items]);
  if (!rows.length && !earlier) return null;
  const last = rows.at(-1);
  return (
    <div data-live-turn-group>
      {/* One quiet line for the steps the overlay is not showing. It sits above
          the tail because that is where those steps happened, and it carries no
          `data-live-turn`: it is the absence of rows, not a row. */}
      {earlier ? (
        <div
          data-live-turn-earlier={earlier}
          className="ml-9 truncate py-0.5 text-caption text-muted"
          title={t("feed.liveEarlierSteps", { count: earlier })}
        >
          {t("feed.liveEarlierSteps", { count: earlier })}
        </div>
      ) : null}
      {rows.map((item, index) => {
        const key = item.itemId ?? `${item.startedAt ?? "live"}:${index}`;
        if (item.tool) return <LiveCallRow key={key} item={item} tool={item.tool} />;
        return (
          <div
            key={key}
            data-live-turn
            data-live-turn-item-id={item.itemId ?? undefined}
            className="my-2 ml-9 whitespace-pre-wrap [overflow-wrap:anywhere] text-ui text-primary"
          >
            {item.omittedChars ? (
              <span data-live-turn-omitted-chars className="text-muted">
                {`${t("feed.liveOmittedChars", { chars: item.omittedChars })}\n`}
              </span>
            ) : null}
            <StreamingMd text={item.text} streaming={item.phase === "streaming"} />
            {item.phase === "streaming" && item === last ? (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[2px] bg-accent align-text-bottom" aria-hidden />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
