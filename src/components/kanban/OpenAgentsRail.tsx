"use client";

import { useLayoutEffect, useRef } from "react";

import { useLocale } from "@/lib/i18n";
import { RoleEmblem, frameRoleName } from "@/components/RoleFrameMark";

import { CloseGlyph } from "./kanbanGlyphs";
import { OPEN_RAIL_WIDTH, type OpenRailTier } from "./kanbanLayout";
import type { OpenAgent } from "./openAgents";

/**
 * The agents open on the board, at its side: a chip split into one segment
 * per open agent, each with its role's emblem and colour (the reader's ribbon
 * reads the same role), a short name and the reader's live dot. A segment
 * takes the board to that agent's conversation and focuses it; its × closes
 * the one reader, and «Close all» closes every one. Alt+J and Alt+K walk them.
 *
 * It stands in its own strip beside the columns, so it covers nothing on the
 * board. Where that strip would cost the columns their layout it is the count
 * alone, and the count opens the same list over the board on request.
 */

export const OPEN_AGENTS_SHORTCUT = { next: "KeyJ", previous: "KeyK" } as const;

export function OpenAgentsRail({ agents, tier, current, listOpen, onJump, onClose, onCloseAll, onShowList }: {
  agents: readonly OpenAgent[];
  tier: OpenRailTier;
  current: string | null;
  /** The compact tier's list is open over the board. */
  listOpen: boolean;
  onJump: (key: string) => void;
  onClose: (key: string) => void;
  onCloseAll: () => void;
  onShowList: (anchor: HTMLElement) => void;
}) {
  const { t } = useLocale();
  const count = agents.length;
  return (
    <nav
      className="open-rail"
      data-open-rail={tier}
      aria-label={t("kanban.openAgents.aria", { count })}
      style={{ width: OPEN_RAIL_WIDTH[tier] }}
    >
      {tier === "full" ? (
        <div className="or-chip">
          <div className="or-head" title={t("kanban.openAgents.shortcut")}>
            <span className="num" data-open-rail-count="">{t("kanban.openAgents.head", { count })}</span>
          </div>
          <OpenAgentsList agents={agents} current={current} onJump={onJump} onClose={onClose} onCloseAll={onCloseAll} />
        </div>
      ) : (
        <button
          type="button"
          className="or-count"
          data-open-rail-count=""
          aria-haspopup="dialog"
          aria-expanded={listOpen}
          aria-label={t("kanban.openAgents.show", { count })}
          aria-keyshortcuts="Alt+J Alt+K"
          title={`${t("kanban.openAgents.show", { count })} · ${t("kanban.openAgents.shortcut")}`}
          onClick={(event) => onShowList(event.currentTarget)}
        >
          <span className="num">{count}</span>
        </button>
      )}
    </nav>
  );
}

/** The segments, in the order the agents were opened. The rail's full tier
    and the compact tier's popover draw the same list. */
export function OpenAgentsList({ agents, current, onJump, onClose, onCloseAll }: {
  agents: readonly OpenAgent[];
  current: string | null;
  onJump: (key: string) => void;
  onClose: (key: string) => void;
  onCloseAll: () => void;
}) {
  const { t } = useLocale();
  const listRef = useRef<HTMLOListElement>(null);
  /* A segment closed from its × hands focus to the segment that takes its
     place, so the keyboard stays in the list. */
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const jumps = listRef.current?.querySelectorAll<HTMLElement>("[data-open-agent-jump]");
    if (jumps?.length) jumps[Math.min(at, jumps.length - 1)]!.focus();
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
