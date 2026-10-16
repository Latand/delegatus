import { FRAME_ROLES } from "@/lib/roleFrames";

import { costumeSvg } from "./roleCostumes";

/*
 * The dark theme's role avatars (docs/design/role-avatars.md, "Dark theme"). A
 * RoleAvatar is an <img> on the light drawing's data URI, so theme CSS cannot
 * reach inside it. This stylesheet, emitted once by the root layout, swaps the
 * picture for the same costume without the keyline (`content: var(--ra-<role>)`)
 * in the dark scopes of src/styles/tokens.css: the OS asks for dark and the app
 * is not pinned light, or `data-theme="dark"`. The light theme matches nothing
 * here. One URI per role lives in a custom property, so a row costs no markup.
 */

/** `url("data:…")` on one line: `"` becomes `'` and the three characters a URL cannot hold raw are escaped. */
function svgUrl(svg: string): string {
  return `url("data:image/svg+xml;utf8,${svg.replaceAll('"', "'").replaceAll("%", "%25").replaceAll("#", "%23").replaceAll("<", "%3C").replaceAll(">", "%3E")}")`;
}

export function roleAvatarDarkCss(): string {
  const variables = FRAME_ROLES.map((role) => `--ra-${role}:${svgUrl(costumeSvg(role, "dark"))};`).join("");
  const rules = (scope: string) => FRAME_ROLES.map((role) => `${scope} img[data-role-avatar="${role}"]{content:var(--ra-${role})}`).join("");
  return `:root{${variables}}@media (prefers-color-scheme:dark){${rules(':root:not([data-theme="light"])')}}${rules('[data-theme="dark"]')}`;
}
