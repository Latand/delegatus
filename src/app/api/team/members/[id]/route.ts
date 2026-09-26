import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { memberSummary, recolorMember, renameMember, restoreMember, revokeMember } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ name }`, `{ color }` or `{ status: "revoked" | "active" }`. A member
 * renames and recolours themselves; the owner does it for anyone, and only the
 * owner revokes or restores.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    const { store, live } = authed;
    let target = store.member(id);
    if (!target) return teamJson({ error: "no such member", code: "member_gone" }, 404);
    const owner = live.member.role === "owner";
    const self = target.id === live.member.id;
    const body = await readJson(req);
    if ((Object.hasOwn(body, "name") || Object.hasOwn(body, "color")) && !owner && !self) {
      return teamJson({ error: "only the owner can change another member", code: "owner_required" }, 403);
    }
    if (Object.hasOwn(body, "status") && !owner) {
      return teamJson({ error: "only the owner can revoke or restore a member", code: "owner_required" }, 403);
    }
    if (Object.hasOwn(body, "name")) target = renameMember(store, live.member, target, body.name);
    if (Object.hasOwn(body, "color")) target = recolorMember(store, live.member, target, body.color);
    if (body.status === "revoked") target = revokeMember(store, live.member, target);
    if (body.status === "active") target = restoreMember(store, live.member, target);
    return teamJson({ ok: true, member: memberSummary(target) });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
