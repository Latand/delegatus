/* Opens the Update surface (#2007) from anywhere: the rail menu and the
   phone's menus dispatch one window event; the surface is mounted once, in
   the Viewer. Kept apart from the surface so a menu row pulls in nothing. */
export const OPEN_SELF_UPDATE_EVENT = "llv:open-self-update";

export function openSelfUpdate(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_SELF_UPDATE_EVENT));
}
