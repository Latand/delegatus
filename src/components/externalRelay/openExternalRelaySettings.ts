export const OPEN_EXTERNAL_RELAY_SETTINGS_EVENT = "delegatus:open-external-relay-settings";

export function openExternalRelaySettings(): void {
  window.dispatchEvent(new Event(OPEN_EXTERNAL_RELAY_SETTINGS_EVENT));
}
