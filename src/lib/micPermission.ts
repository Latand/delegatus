/* The microphone grant as the browser reports it, and the one hint Delegatus
   owes the operator when the browser forgets a grant between page loads.

   A site cannot make a grant permanent: the browser decides, from a setting
   the operator owns. Safari on iOS keeps a grant for the life of one document
   while its per-site Microphone setting reads "Ask"; every other browser on
   iOS is an app around a WebKit view, asks on its own account and has no
   per-site setting at all; a Home Screen web app on iOS keeps none between
   launches; Chrome on Android forgets an "Allow this time" answer when the
   page closes. What a site can do is notice that it is
   being asked again on a device where it was already allowed, and name the
   setting that ends the question. */

/** `unavailable`: the Permissions API is missing or does not know the
    microphone (iOS before 16), so nothing can be said about the next press. */
export type MicPermissionState = "granted" | "prompt" | "denied" | "unavailable";

/** Which browser's setting the hint names. */
export type MicHintPlatform = "iosSafari" | "iosOtherBrowser" | "iosWebApp" | "androidChrome" | "other";

const GRANTED_KEY = "llv_mic_granted";
const HINT_SEEN_KEY = "llv_mic_hint_seen";

/** The one call this code makes; `Navigator.permissions` narrows the name to
    a union, so the browser's object is passed through this shape. */
export interface PermissionsLike {
  query: (descriptor: { name: string }) => Promise<{ state: string }>;
}

/** Asks the browser without prompting. Every failure reads as `unavailable`:
    a missing API, a browser that rejects the `microphone` name, a state this
    code does not know. */
export async function queryMicPermission(permissions: PermissionsLike | undefined | null): Promise<MicPermissionState> {
  if (!permissions || typeof permissions.query !== "function") return "unavailable";
  try {
    const { state } = await permissions.query({ name: "microphone" });
    return state === "granted" || state === "prompt" || state === "denied" ? state : "unavailable";
  } catch {
    return "unavailable";
  }
}

export interface MicHintInput {
  state: MicPermissionState;
  /** A recording started on this device before, so the question was answered. */
  grantedBefore: boolean;
  /** The hint was already dismissed, or a recording started under it. */
  seen: boolean;
}

/** The hint is for one case only: the browser will ask, and it was already
    told yes on this device. A first-ever press, a standing grant, a refusal
    (the recording's own error covers it) and an unknown state show nothing. */
export function shouldShowMicHint({ state, grantedBefore, seen }: MicHintInput): boolean {
  return state === "prompt" && grantedBefore && !seen;
}

export interface MicPlatformInput {
  userAgent: string;
  /** Launched from the Home Screen (`display-mode: standalone`, or Safari's
      own `navigator.standalone`). */
  standalone: boolean;
  /** iPadOS presents a desktop Mac user agent; touch points tell it apart. */
  maxTouchPoints: number;
}

export function micHintPlatform({ userAgent, standalone, maxTouchPoints }: MicPlatformInput): MicHintPlatform {
  const ua = userAgent.toLowerCase();
  const ios = /iphone|ipad|ipod/.test(ua) || (ua.includes("macintosh") && maxTouchPoints > 1);
  if (ios) {
    if (standalone) return "iosWebApp";
    /* Edge, Chrome, Firefox and the rest on iOS are WebKit behind the app's
       own shell. Only Safari has the per-site Microphone setting, so their
       hint sends the operator there. */
    return /crios|fxios|edgios|opios|opt\/|duckduckgo|yabrowser/.test(ua) ? "iosOtherBrowser" : "iosSafari";
  }
  if (ua.includes("android") && ua.includes("chrome") && !/edga|opr\/|firefox|samsungbrowser/.test(ua)) return "androidChrome";
  return "other";
}

const read = (key: string): boolean => {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const write = (key: string): void => {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    /* Private mode or a full store: the hint then never shows, which costs
       nothing the recording needs. */
  }
};

export const micGrantedBefore = (): boolean => read(GRANTED_KEY);
/** Called once a microphone stream was handed over, by dictation and by a
    voice call alike. */
export const rememberMicGrant = (): void => write(GRANTED_KEY);
export const micHintSeen = (): boolean => read(HINT_SEEN_KEY);
export const markMicHintSeen = (): void => write(HINT_SEEN_KEY);
