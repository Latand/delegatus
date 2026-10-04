import { NextRequest, NextResponse } from "next/server";
import { remoteAgents, remoteLanes } from "@/lib/links/agentFeed";
import type { RemoteHost } from "@/components/kanban/remoteFeed";
import { peerRows, grantRows } from "@/lib/links/protocol";
import { linkedContext } from "@/lib/links/linked";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The other machines' agents and pipeline lanes for one linked project, or for
    every linked project when none is named (the cross-project Overview). `self`
    and `hosts` let a card tell a remote task from a local one and name its host. */
export function GET(req: NextRequest) {
  const denied = rejectCrossOrigin(req);
  if (denied) return denied;
  const project = req.nextUrl.searchParams.get("project");
  if (project !== null && !/^repo-[0-9a-f]{32}$/.test(project)) return NextResponse.json({ error: "malformed" }, { status: 400 });
  const context = linkedContext();
  const hosts: Record<string, RemoteHost> = {};
  for (const [install, label] of context.labels) hosts[install] = { label, linked: false };
  const peers = new Map(peerRows().map((peer) => [peer.id, peer]));
  const grants = new Map(grantRows().map((grant) => [grant.id, grant]));
  for (const link of context.links) {
    const peer = link.side === "peer" ? peers.get(link.id) : undefined;
    const grant = link.side === "grant" ? grants.get(link.id) : undefined;
    const previous = hosts[link.install];
    // Both directions may exist: expose any failed exchange and the latest
    // successful exchange. Request counts/lastUsed never prove sync success.
    const failing = previous?.state === "failing" || (peer ? peer.state !== "active" : grant?.state === "failing");
    const lastCall = Math.max(previous?.lastCall ?? 0, peer?.lastCall ?? grant?.lastCall ?? 0) || null;
    hosts[link.install] = { label: link.label, linked: true, state: failing ? "failing" : "active", lastCall };
  }
  const agents = project === null ? [...context.all].flatMap((key) => remoteAgents(key)) : remoteAgents(project);
  return NextResponse.json({ agents, lanes: remoteLanes(project ?? undefined), self: context.self?.id ?? null, hosts }, { headers: { "cache-control": "no-store" } });
}
