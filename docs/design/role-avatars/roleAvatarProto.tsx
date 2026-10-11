"use client";

/*
 * Prototype only (docs/design/role-avatars.md). render-frames.ts copies this
 * file into a `git archive` export under src/components/feed/,
 * patches FeedItem to call it, and renders the conversation fixture's
 * `role-avatars` case. Nothing here is product code.
 *
 *   1  costume  the Delegatus mark wearing the role's accessory
 *   2  badge    the plain Delegatus mark with the role's emblem in a corner disc
 *   3  tile     the role's emblem tile the open-agents rail already draws
 */

import { createContext, useContext } from "react";

import { RoleEmblem } from "@/components/RoleFrameMark";
import type { FrameRole } from "@/lib/roleFrames";

import { AVATAR_ROLES, costumeSvg, ROLE_FILL, type AvatarRole } from "./roleAvatarCostumes";

export type AvatarVariant = 1 | 2 | 3;

export function isAvatarRole(value: string | null | undefined): value is AvatarRole {
  return value === "neutral" || (AVATAR_ROLES as readonly string[]).includes(value ?? "");
}

const uri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const COSTUME_URI = Object.fromEntries([...AVATAR_ROLES, "neutral" as const].map((role) => [role, uri(costumeSvg(role))])) as Record<AvatarRole, string>;

/** Which variant a fixture draws, and whose rows a feed holds. */
export const RoleAvatarScope = createContext<{ variant: AvatarVariant; role?: AvatarRole } | null>(null);
export const useRoleAvatarScope = () => useContext(RoleAvatarScope);

export function RoleAvatar({ variant, role, size, className = "" }: { variant: AvatarVariant; role: AvatarRole; size: number; className?: string }) {
  const box = { width: size, height: size };
  if (variant === 1) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={COSTUME_URI[role]} alt="" aria-hidden width={size} height={size} draggable={false} data-role-avatar={role} className={`shrink-0 select-none ${className}`} />;
  }
  if (variant === 2) {
    /* Under 20 px the disc is too small for a glyph: it carries the role's colour only. */
    const disc = Math.round(size * 0.56);
    return (
      <span data-role-avatar={role} className={`relative inline-block shrink-0 ${className}`} style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={COSTUME_URI.neutral} alt="" aria-hidden width={size} height={size} draggable={false} className="select-none" />
        {role === "neutral" ? null : (
          <span className="absolute flex items-center justify-center rounded-full text-white"
            style={{ width: disc, height: disc, right: -Math.round(size * 0.12), bottom: -Math.round(size * 0.1), background: ROLE_FILL[role],
              boxShadow: "0 0 0 1.5px var(--avatar-ring, var(--surface-canvas))" }}>
            {size >= 20 ? <span className="flex [&>svg]:h-full [&>svg]:w-full" style={{ width: Math.round(disc * 0.66), height: Math.round(disc * 0.66) }}><RoleEmblem role={role as FrameRole} strokeWidth={2.75} /></span> : null}
          </span>
        )}
      </span>
    );
  }
  return (
    <span data-role-avatar={role} className={`inline-flex shrink-0 items-center justify-center text-white ${className}`}
      style={{ ...box, borderRadius: Math.round(size * 0.28), background: ROLE_FILL[role], boxShadow: "inset 0 0 0 1px color-mix(in srgb, #fff 18%, transparent)" }}>
      <span className="flex [&>svg]:h-full [&>svg]:w-full" style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6) }}><RoleEmblem role={role as FrameRole} strokeWidth={size < 20 ? 2.5 : 2.25} /></span>
    </span>
  );
}
