export const OPEN_VOICE_COMPANION_SETTINGS_EVENT = "delegatus:open-voice-companion-settings";
/** Opens the voice companion's settings: the companion's own failure notice, answered by the Settings window. */
export const openVoiceCompanionSettings = () => window.dispatchEvent(new Event(OPEN_VOICE_COMPANION_SETTINGS_EVENT));
