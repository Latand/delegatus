export const OPEN_LINKED_SETTINGS_EVENT = "delegatus:open-linked-settings";

export function openLinkedSettings(): void {
  window.dispatchEvent(new Event(OPEN_LINKED_SETTINGS_EVENT));
}
