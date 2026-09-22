import { ROLE_IDS, type RoleId } from "@/lib/roles/types";

/*
 * Role frames on agent conversations (prototype).
 *
 * An expanded conversation — the orchestrator seat, a reader opened inside a
 * task card, the phone's conversation screen — carries a frame that says what
 * the agent IS. This module answers two questions, both pure:
 *
 *  - which role a conversation plays (`conversationFrameRole`), from the
 *    authorities the Viewer already keeps: the orchestrator seat designation,
 *    the pipeline stage's `role.roleId`, the review-loop membership, and the
 *    durable spawn lineage's role. Everything else is `neutral`.
 *  - which frame variant draws it (`resolveRoleFrameVariant`), from a
 *    `?roleFrame=<variant>` query or this browser's stored choice.
 *
 * The variant is ONE attribute on `<html>` (`data-role-frame`), set before the
 * first paint by `ROLE_FRAME_BOOT_SCRIPT`. Components render the same markup
 * for every variant; `src/styles/roleFrames.css` draws the chosen one. So a
 * switch never re-renders React, never mismatches hydration and never moves
 * the layout after load.
 */

export type FrameRole = RoleId | "neutral";

export const FRAME_ROLES: readonly FrameRole[] = [...ROLE_IDS, "neutral"];

export const ROLE_FRAME_VARIANTS = ["rail", "ribbon", "halo", "bracket"] as const;
export type RoleFrameVariant = (typeof ROLE_FRAME_VARIANTS)[number];

/** `off` draws no frame: today's product. */
export type RoleFrameChoice = RoleFrameVariant | "off";

/** What an unconfigured browser draws; `?roleFrame=off` turns it off on a device. Choosing another variant is this one line. */
export const DEFAULT_ROLE_FRAME: RoleFrameChoice = "ribbon";

export const ROLE_FRAME_QUERY = "roleFrame";
export const ROLE_FRAME_STORAGE_KEY = "llv:role-frame:v1";

export function parseRoleFrameChoice(raw: string | null | undefined): RoleFrameChoice | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "off" || value === "none") return "off";
  return (ROLE_FRAME_VARIANTS as readonly string[]).includes(value) ? value as RoleFrameVariant : null;
}

/**
 * The query wins and is remembered; without one, the stored choice; without
 * that, the default. `?roleFrame=off` is remembered too, so the operator can
 * turn a variant back off on this device.
 */
export function resolveRoleFrameVariant(search: string, stored: string | null): { choice: RoleFrameChoice; remember: RoleFrameChoice | null } {
  const queried = parseRoleFrameChoice(new URLSearchParams(search).get(ROLE_FRAME_QUERY));
  if (queried) return { choice: queried, remember: queried };
  return { choice: parseRoleFrameChoice(stored) ?? DEFAULT_ROLE_FRAME, remember: null };
}

/**
 * Inline, before hydration: the same resolution as `resolveRoleFrameVariant`,
 * written without imports because it runs as a plain `<script>` in `<head>`.
 * `roleFrames.test.ts` runs it against the function above so the two cannot
 * drift.
 */
export const ROLE_FRAME_BOOT_SCRIPT = `(function(){try{
var V=${JSON.stringify(ROLE_FRAME_VARIANTS)},K=${JSON.stringify(ROLE_FRAME_STORAGE_KEY)},D=${JSON.stringify(DEFAULT_ROLE_FRAME)};
function p(r){if(!r)return null;r=String(r).trim().toLowerCase();if(r==="off"||r==="none")return "off";return V.indexOf(r)>=0?r:null;}
var q=p(new URLSearchParams(location.search).get(${JSON.stringify(ROLE_FRAME_QUERY)}));
var s=null;try{s=localStorage.getItem(K);}catch(e){}
var c=q||p(s)||D;
if(q){try{localStorage.setItem(K,q);}catch(e){}}
if(c!=="off")document.documentElement.setAttribute("data-role-frame",c);
}catch(e){}})();`;

const KNOWN = new Set<string>(ROLE_IDS);

/** A review loop's two sides, and the older spawn words for the same jobs. */
function roleFromWord(word: string | null | undefined): RoleId | null {
  const value = word?.trim().toLowerCase();
  if (!value) return null;
  if (KNOWN.has(value)) return value as RoleId;
  if (value === "implementer" || value === "worker") return "builder";
  return null;
}

export interface FrameRoleInput {
  /** The conversation holds the project's orchestrator seat. */
  seat?: boolean;
  /** The pipeline stage the conversation is an attempt of, when it is one. */
  stage?: { kind?: string; role?: { roleId?: string | null } | null } | null;
  file?: {
    seat?: boolean | null;
    flow?: { flowRole?: string | null } | null;
    durableLineage?: {
      role?: string | null;
      memberships?: ReadonlyArray<{ kind: string; role: string }>;
    } | null;
  } | null;
}

/**
 * Which role's frame a conversation wears. In order:
 *
 *  1. the orchestrator seat designation (the panel, or a file the registry
 *     marks as a live seat host);
 *  2. a review-loop side: the reviewer rounds of a loop are reviewers and its
 *     implementer is the builder, whatever the stage's role preset says —
 *     one review-loop stage holds both;
 *  3. the pipeline stage's `role.roleId`;
 *  4. a review-loop stage with no membership in hand is a review;
 *  5. the durable spawn lineage's role, then a durable membership's role;
 *  6. otherwise `neutral` — a conversation the operator started by hand, an
 *     unknown role word, a subagent.
 */
export function conversationFrameRole(input: FrameRoleInput): FrameRole {
  if (input.seat || input.file?.seat) return "orchestrator";
  const lineage = input.file?.durableLineage ?? null;
  const memberships = lineage?.memberships ?? [];
  if (memberships.some((membership) => membership.kind === "orchestrator")) return "orchestrator";
  const loopSide = roleFromWord(input.file?.flow?.flowRole)
    ?? roleFromWord(memberships.find((membership) => membership.kind === "flow")?.role);
  if (loopSide) return loopSide;
  const staged = roleFromWord(input.stage?.role?.roleId);
  if (staged) return staged;
  if (input.stage?.kind === "review-loop") return "reviewer";
  const spawned = roleFromWord(lineage?.role);
  if (spawned) return spawned;
  for (const membership of memberships) {
    const role = roleFromWord(membership.role);
    if (role) return role;
  }
  return "neutral";
}
