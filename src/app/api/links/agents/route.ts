import { NextRequest, NextResponse } from "next/server";
import { remoteAgents, remoteLanes } from "@/lib/links/agentFeed";
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
  const hosts: Record<string, { label: string; linked: boolean }> = {};
  for (const [install, label] of context.labels) hosts[install] = { label, linked: false };
  for (const link of context.links) hosts[link.install] = { label: link.label, linked: true };
  const agents = project === null ? [...context.all].flatMap((key) => remoteAgents(key)) : remoteAgents(project);
  return NextResponse.json({ agents, lanes: remoteLanes(project ?? undefined), self: context.self?.id ?? null, hosts }, { headers: { "cache-control": "no-store" } });
}
