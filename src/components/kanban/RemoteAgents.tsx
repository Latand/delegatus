"use client";

import { useLocale } from "@/lib/i18n";
import type { AgentRow } from "@/lib/links/agentFeed";

export type RemoteAgentView = AgentRow & { peer: string; stale: boolean; asOf: number };

export function RemoteAgents({ rows, nowMs }: { rows: readonly RemoteAgentView[]; nowMs: number }) {
  const { t, locale } = useLocale();
  const groups = new Map<string, RemoteAgentView[]>();
  for (const row of rows) groups.set(row.peer, [...(groups.get(row.peer) ?? []), { ...row, stale: !Number.isFinite(row.asOf) || nowMs - row.asOf > 900_000 }]);
  return <>{[...groups].map(([peer, agents]) => (
    <details className="remote-agents" data-remote-agents="" key={peer}>
      <summary>{t(agents.length === 1 ? "kanban.remoteAgentOne" : "kanban.remoteAgents", { peer, count: agents.length, working: agents.filter((agent) => agent.st === "working").length })}</summary>
      <div className="remote-agent-list">
        {agents.map((agent) => <div className="remote-agent" data-remote-agent={agent.st} data-stale={agent.stale ? "true" : undefined} key={agent.k}>
          <span className="remote-agent-dot" aria-hidden="true" />
          <span className="remote-agent-title">{agent.t}</span>
          <span className="remote-agent-meta">{agent.e} · {agent.m}{agent.pl ? ` · ${agent.pl.stage} (${agent.pl.stageState})` : ""}</span>
          <time dateTime={new Date(agent.at).toISOString()}>{t("kanban.remoteAgo", { minutes: Math.max(0, Math.floor((nowMs - agent.at) / 60_000)) })}</time>
          {agent.stale ? <span className="remote-agent-asof">{t("kanban.remoteAsOf", { time: new Date(agent.asOf).toLocaleTimeString(locale === "uk" ? "uk-UA" : "en-US", { hour: "2-digit", minute: "2-digit" }) })}</span> : null}
        </div>)}
      </div>
    </details>
  ))}</>;
}
