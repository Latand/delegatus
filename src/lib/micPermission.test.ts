import { afterEach, describe, expect, test } from "bun:test";

import {
  markMicHintSeen,
  micGrantedBefore,
  micHintPlatform,
  micHintSeen,
  queryMicPermission,
  rememberMicGrant,
  shouldShowMicHint,
} from "./micPermission";

const answers = (state: string) => ({ query: async () => ({ state }) });

describe("the microphone permission as the browser reports it", () => {
  test("granted, prompt and denied pass through", async () => {
    expect(await queryMicPermission(answers("granted"))).toBe("granted");
    expect(await queryMicPermission(answers("prompt"))).toBe("prompt");
    expect(await queryMicPermission(answers("denied"))).toBe("denied");
  });

  test("the query names the microphone", async () => {
    const asked: unknown[] = [];
    await queryMicPermission({ query: async (descriptor) => { asked.push(descriptor); return { state: "prompt" }; } });
    expect(asked).toEqual([{ name: "microphone" }]);
  });

  test("no Permissions API, as on iOS before 16, is unavailable", async () => {
    expect(await queryMicPermission(undefined)).toBe("unavailable");
    expect(await queryMicPermission(null)).toBe("unavailable");
    expect(await queryMicPermission({} as never)).toBe("unavailable");
  });

  test("a browser that rejects the microphone name is unavailable", async () => {
    expect(await queryMicPermission({ query: async () => { throw new TypeError("not a valid PermissionName"); } })).toBe("unavailable");
  });

  test("a state this code does not know is unavailable", async () => {
    expect(await queryMicPermission(answers("ask-later"))).toBe("unavailable");
  });
});

describe("when the hint is owed", () => {
  test("prompt after a prior grant shows it", () => {
    expect(shouldShowMicHint({ state: "prompt", grantedBefore: true, seen: false })).toBe(true);
  });

  test("a first-ever press shows nothing", () => {
    expect(shouldShowMicHint({ state: "prompt", grantedBefore: false, seen: false })).toBe(false);
  });

  test("a standing grant shows nothing", () => {
    expect(shouldShowMicHint({ state: "granted", grantedBefore: true, seen: false })).toBe(false);
  });

  test("a refusal shows nothing", () => {
    expect(shouldShowMicHint({ state: "denied", grantedBefore: true, seen: false })).toBe(false);
  });

  test("an unavailable Permissions API shows nothing", () => {
    expect(shouldShowMicHint({ state: "unavailable", grantedBefore: true, seen: false })).toBe(false);
  });

  test("once seen on this device it stays away", () => {
    expect(shouldShowMicHint({ state: "prompt", grantedBefore: true, seen: true })).toBe(false);
  });
});

describe("which browser's setting the hint names", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
  const IPHONE_EDGE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/138.0.0.0 Mobile/15E148 Safari/604.1";
  const IPHONE_FIREFOX = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15";
  const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1";
  const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
  const ANDROID_SAMSUNG = "Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36";
  const ANDROID_FIREFOX = "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";
  const DESKTOP_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

  test("Safari on an iPhone", () => {
    expect(micHintPlatform({ userAgent: IPHONE, standalone: false, maxTouchPoints: 5 })).toBe("iosSafari");
  });

  test("a Home Screen web app on an iPhone", () => {
    expect(micHintPlatform({ userAgent: IPHONE, standalone: true, maxTouchPoints: 5 })).toBe("iosWebApp");
  });

  test("an iPad that presents a Mac user agent", () => {
    expect(micHintPlatform({ userAgent: IPAD_AS_MAC, standalone: false, maxTouchPoints: 5 })).toBe("iosSafari");
    expect(micHintPlatform({ userAgent: IPAD_AS_MAC, standalone: false, maxTouchPoints: 0 })).toBe("other");
  });

  test("Edge, Chrome and Firefox on an iPhone are sent to Safari: their shells have no per-site setting", () => {
    for (const userAgent of [IPHONE_EDGE, IPHONE_CHROME, IPHONE_FIREFOX]) {
      expect(micHintPlatform({ userAgent, standalone: false, maxTouchPoints: 5 })).toBe("iosOtherBrowser");
    }
  });

  test("Chrome on Android, and the Android browsers that are not Chrome", () => {
    expect(micHintPlatform({ userAgent: ANDROID_CHROME, standalone: false, maxTouchPoints: 5 })).toBe("androidChrome");
    expect(micHintPlatform({ userAgent: ANDROID_SAMSUNG, standalone: false, maxTouchPoints: 5 })).toBe("other");
    expect(micHintPlatform({ userAgent: ANDROID_FIREFOX, standalone: false, maxTouchPoints: 5 })).toBe("other");
  });

  test("a desktop browser", () => {
    expect(micHintPlatform({ userAgent: DESKTOP_CHROME, standalone: false, maxTouchPoints: 0 })).toBe("other");
  });
});

describe("what the device remembers", () => {
  const G = globalThis as Record<string, unknown>;
  const had = "window" in G;
  const saved = G.window;
  afterEach(() => {
    if (had) G.window = saved;
    else delete G.window;
  });
  const store = () => {
    const values = new Map<string, string>();
    G.window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } };
    return values;
  };

  test("a grant and a seen hint are kept apart", () => {
    const values = store();
    expect(micGrantedBefore()).toBe(false);
    expect(micHintSeen()).toBe(false);
    rememberMicGrant();
    expect(micGrantedBefore()).toBe(true);
    expect(micHintSeen()).toBe(false);
    markMicHintSeen();
    expect(micHintSeen()).toBe(true);
    expect([...values.keys()].sort()).toEqual(["llv_mic_granted", "llv_mic_hint_seen"]);
  });

  test("a store that throws, as in private mode, reads as nothing remembered and never throws", () => {
    G.window = { localStorage: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } } };
    expect(() => rememberMicGrant()).not.toThrow();
    expect(micGrantedBefore()).toBe(false);
    expect(micHintSeen()).toBe(false);
  });
});
