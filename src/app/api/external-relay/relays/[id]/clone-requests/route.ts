import { NextRequest, NextResponse } from "next/server";
import {
  guardRelayRoute,
  refusedHere,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import { createCloneRequest, type ClonePhotoInput } from "@/lib/externalRelay/cloneCreate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function photoInput(value: unknown): ClonePhotoInput | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const photo = value as Record<string, unknown>;
  if (photo.kind === "upload" && typeof photo.data === "string" && Object.keys(photo).length === 2)
    return { kind: "upload", data: photo.data };
  if (photo.kind === "candidate" && typeof photo.storage_key === "string" && Object.keys(photo).length === 2)
    return { kind: "candidate", storage_key: photo.storage_key };
  return undefined;
}
/** «Створити в Telegram»: asks the relay for the `t.me/newbot` link (cloneCreate.ts). */
export async function POST(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const photo = photoInput(body?.photo);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["name", "username", "photo"].includes(key)) ||
      typeof body.name !== "string" ||
      typeof body.username !== "string" ||
      photo === undefined
    )
      return refusedHere();
    const request = await createCloneRequest((await context.params).id, { name: body.name, username: body.username, photo });
    return NextResponse.json({ request }, { status: 201 });
  } catch (error) {
    return relayRouteError(error);
  }
}
