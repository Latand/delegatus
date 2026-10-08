"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { useLocale } from "@/lib/i18n";
import { RoleEmblem, frameRoleName } from "@/components/RoleFrameMark";

import { ChevronRight, CloseGlyph, MaximizeGlyph } from "./kanbanGlyphs";
import type { OpenAgent } from "./openAgents";

/**
 * The agent window (docs/design/agent-window.md, Variant 1): a click on an
 * agent anywhere on the board opens its conversation here, in its normal full
 * view, and the card it came from keeps its geometry. The window holds every
 * agent the operator opened, with their list as its left column: a row brings
 * its agent into the same reader, ‹ › and Alt+J / Alt+K step round the list,
 * a row's × closes that one agent and «Close all» closes every one.
 *
 * With the window closed and agents still open, the list is one pill in the
 * board's header that brings the window back on the agent shown last.
 */

export const OPEN_AGENTS_SHORTCUT = { next: "KeyJ", previous: "KeyK" } as const;

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

/** What Tab can reach in the window: drawn, enabled and in the tab order. The
    agent coming in is laid out and not drawn, so it holds no stop. */
function tabStops(frame: HTMLElement): HTMLElement[] {
  return [...frame.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) =>
    element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]")
    && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible");
}

/** The header's pill. It stands in a slot of its own size whether or not
    anything is open, so its arrival moves nothing in the header, and it names
    the agents it counts at every width. */
export function OpenAgentsPill({ count, open, onOpen }: { count: number; open: boolean; onOpen: () => void }) {
  const { t } = useLocale();
  return (
    <span className="open-agents-slot" data-open-agents-slot="">
      {count ? (
        <button
          type="button"
          className="btn open-agents-pill"
          data-open-agents-pill={count}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("kanban.openAgents.show", { count })}
          aria-keyshortcuts="Alt+J Alt+K"
          title={`${t("kanban.openAgents.show", { count })} · ${t("kanban.openAgents.shortcut")}`}
          onClick={onOpen}
        >
          <span className="num pill-words">{t("kanban.agentWindow.pill", { count })}</span>
          <MaximizeGlyph />
        </button>
      ) : null}
    </span>
  );
}

export function AgentWindow({ agents, current, pending, onJump, onStep, onClose, onCloseAll, onLeave, children }: {
  agents: readonly OpenAgent[];
  current: string | null;
  /** A first open whose agent is not ready yet: the window is laid out and
      not drawn, so it appears with its conversation. */
  pending: boolean;
  onJump: (key: string) => void;
  onStep: (step: 1 | -1) => void;
  onClose: (key: string) => void;
  onCloseAll: () => void;
  onLeave: () => void;
  /** The reader's slot, and the incoming agent's while it reads. */
  children: ReactNode;
}) {
  const { t } = useLocale();
  const count = agents.length;
  const frameRef = useRef<HTMLElement>(null);
  /* The window is modal: Tab and Shift+Tab go round it and never reach the
     board, the header or the sidebar under its scrim. Listened for on the
     document, because the reader is a portal whose key events never pass
     through the window in React's tree. A menu or another dialog over the
     window keeps its own keys. */
  useEffect(() => {
    if (pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const frame = frameRef.current;
      const owner = (event.target as HTMLElement | null)?.closest?.("[role='dialog'], [role='menu'], [role='listbox']");
      if (!frame || (owner && owner !== frame)) return;
      const stops = tabStops(frame);
      if (!stops.length) return;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && frame.contains(active);
      const follows = (element: HTMLElement) => !!(active!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
      const wrap = !inside || (event.shiftKey ? !stops.some((element) => element !== active && !follows(element)) : !stops.some(follows));
      if (!wrap) return;
      event.preventDefault();
      (event.shiftKey ? stops[stops.length - 1]! : stops[0]!).focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending]);
  return (
    <div className="agent-window-layer" {...(pending ? { "data-agent-window-pending": "" } : { "data-agent-window": current ?? "" })}>
      {/* The board under the window's margins is a flat field, so no card's
          text shows between the window and the screen's edge. */}
      <div className="aw-field" aria-hidden="true" />
      <div className="aw-scrim" data-agent-window-scrim="" aria-hidden="true" onClick={onLeave} />
      <section ref={frameRef} className="agent-window" role="dialog" aria-modal="true" aria-label={t("kanban.openAgents.aria", { count })} data-agent-window-frame="">
        <nav className="aw-list" aria-label={t("kanban.openAgents.aria", { count })}>
          <div className="aw-head" title={t("kanban.openAgents.shortcut")}>
            <span className="num" data-open-agents-count="">{t("kanban.openAgents.head", { count })}</span>
            {/* Stepping needs a second agent; with one open the head is its count alone. */}
            {count > 1 ? (
              <span className="aw-steps">
                <button type="button" className="icon-btn sm" data-agent-window-step="previous" aria-label={t("kanban.agentWindow.previous")} title={t("kanban.agentWindow.previous")} onClick={() => onStep(-1)}>
                  <ChevronRight flip />
                </button>
                <button type="button" className="icon-btn sm" data-agent-window-step="next" aria-label={t("kanban.agentWindow.next")} title={t("kanban.agentWindow.next")} onClick={() => onStep(1)}>
                  <ChevronRight />
                </button>
              </span>
            ) : null}
          </div>
          <OpenAgentsList agents={agents} current={current} onJump={onJump} onClose={onClose} onCloseAll={onCloseAll} />
        </nav>
        <div className="aw-reader">{children}</div>
      </section>
    </div>
  );
}

/** The rows, in the order the agents were opened. */
export function OpenAgentsList({ agents, current, onJump, onClose, onCloseAll }: {
  agents: readonly OpenAgent[];
  current: string | null;
  onJump: (key: string) => void;
  onClose: (key: string) => void;
  onCloseAll: () => void;
}) {
  const { t } = useLocale();
  const listRef = useRef<HTMLOListElement>(null);
  /* A row closed from its × hands focus to the row that takes its place, so
     the keyboard stays in the list. */
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const jumps = listRef.current?.querySelectorAll<HTMLElement>("[data-open-agent-jump]");
    if (jumps?.length) jumps[Math.min(at, jumps.length - 1)]!.focus({ preventScroll: true });
  }, [agents]);
  return (
    <>
      <ol ref={listRef} className="or-list">
        {agents.map((agent, index) => {
          const role = frameRoleName(t, agent.role);
          const state = t(`kanban.memberState.${agent.state}`);
          const label = agent.card ? `${agent.name} · ${agent.card}` : agent.name;
          return (
            <li key={agent.key} className="or-seg" data-role={agent.role} data-open-agent={agent.key} data-current={current === agent.key ? "" : undefined}>
              <button
                type="button"
                className="or-jump"
                data-open-agent-jump={agent.key}
                aria-current={current === agent.key ? "true" : undefined}
                aria-label={t("kanban.openAgents.jump", { name: label, role, state })}
                title={t("kanban.openAgents.jump", { name: label, role, state })}
                onClick={() => onJump(agent.key)}
              >
                <span className="or-emblem" aria-hidden="true">
                  <RoleEmblem role={agent.role} />
                  <i className={`or-dot tone-${agent.tone}${agent.live ? " live" : ""}`} data-open-agent-dot={agent.live ? "live" : "idle"} />
                </span>
                <span className="or-names">
                  <span className="or-name">{agent.name}</span>
                  {agent.card ? <span className="or-card">{agent.card}</span> : null}
                </span>
              </button>
              <button
                type="button"
                className="or-x"
                data-open-agent-close={agent.key}
                aria-label={t("kanban.openAgents.close", { name: label })}
                title={t("kanban.openAgents.close", { name: label })}
                onClick={() => {
                  refocus.current = index;
                  onClose(agent.key);
                }}
              >
                <CloseGlyph />
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="or-close-all" data-open-rail-close-all="" onClick={onCloseAll}>
        {t("kanban.openAgents.closeAll")}
      </button>
    </>
  );
}
