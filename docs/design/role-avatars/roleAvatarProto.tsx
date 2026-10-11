"use client";

/*
 * Prototype only (docs/design/role-avatars.md). render-frames.ts copies this
 * file into a `git archive` export under src/components/feed/,
 * patches FeedItem to call it, and renders the conversation fixture's
 * `role-avatars` case. Nothing here is product code.
 *
 * It draws variant 1, the one the operator chose on 2026-10-11: the Delegatus
 * mark wearing the role's costume.
 */

import { createContext, useContext } from "react";

import { AVATAR_ROLES, costumeSvg, type AvatarRole } from "./roleAvatarCostumes";

export function isAvatarRole(value: string | null | undefined): value is AvatarRole {
  return value === "neutral" || (AVATAR_ROLES as readonly string[]).includes(value ?? "");
}

const uri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const COSTUME_URI = Object.fromEntries([...AVATAR_ROLES, "neutral" as const].map((role) => [role, uri(costumeSvg(role))])) as Record<AvatarRole, string>;

/** Whose rows a feed holds; without a scope every row is today's. */
export const RoleAvatarScope = createContext<{ role?: AvatarRole } | null>(null);
export const useRoleAvatarScope = () => useContext(RoleAvatarScope);

export function RoleAvatar({ role, size, className = "" }: { role: AvatarRole; size: number; className?: string }) {
  /* The box is fixed inline: Tailwind's preflight sets `img { height: auto }`,
     and a flex row would otherwise stretch the image down a long answer. */
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={COSTUME_URI[role]} alt="" aria-hidden width={size} height={size} draggable={false} data-role-avatar={role} className={`shrink-0 self-start select-none ${className}`} style={{ width: size, height: size }} />;
}
