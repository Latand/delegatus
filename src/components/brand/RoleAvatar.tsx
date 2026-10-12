"use client";

import { createContext, useContext } from "react";

import { FRAME_ROLES, type FrameRole } from "@/lib/roleFrames";

import { costumeSvg } from "./roleCostumes";

/* Delegatus in the role's costume (docs/design/role-avatars.md). Each drawing
   is an <img> on a data URI built once, so its clip-path and filter ids stay
   inside it however many rows draw it, and every row of one role shares the
   decoded picture. The role's name is always in the text beside the avatar,
   so it carries an empty alt, as the brand mark does. */
const COSTUME_URI = Object.fromEntries(
  FRAME_ROLES.map((role) => [role, `data:image/svg+xml;utf8,${encodeURIComponent(costumeSvg(role))}`]),
) as Record<FrameRole, string>;

export function roleAvatarUri(role: string): string {
  return Object.hasOwn(COSTUME_URI, role) ? COSTUME_URI[role as FrameRole] : COSTUME_URI.neutral;
}

/** The role's costume at `size` CSS pixels, a fixed square. */
export function RoleAvatar({ role, size, className = "" }: { role: FrameRole; size: number; className?: string }) {
  /* The box is fixed inline: Tailwind's preflight sets `img { height: auto }`,
     and a flex row would otherwise stretch the picture down a long answer. */
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={roleAvatarUri(role)} alt="" aria-hidden width={size} height={size} draggable={false} data-role-avatar={role}
      className={`shrink-0 select-none ${className}`} style={{ width: size, height: size }} />
  );
}

/** The role of the conversation a feed belongs to, set by the surface that
    resolved it (a reader, the seat, the phone's conversation screen). Without
    it a feed draws its answers as before: the engine circle. */
const ConversationRole = createContext<FrameRole | null>(null);
export const ConversationRoleScope = ConversationRole.Provider;
export const useConversationRole = (): FrameRole | null => useContext(ConversationRole);
