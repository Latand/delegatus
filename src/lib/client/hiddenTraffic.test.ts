import { afterEach, expect, test } from "bun:test";

import { hiddenTrafficSuspended, phoneClassDevice } from "./hiddenTraffic";

/* #1994: a hidden phone fetches nothing; a hidden desktop keeps its feed for
   the agent chimes and the title count. */

const globals = globalThis as unknown as Record<string, unknown>;
const saved = { window: globals.window, navigator: globals.navigator, document: globals.document };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function device(options: { coarse: boolean; anyFine: boolean; mobileHint?: boolean; hidden?: boolean }): void {
  globals.window = {
    matchMedia: (query: string) => ({
      matches: query === "(pointer: coarse)" ? options.coarse : query === "(any-pointer: fine)" ? options.anyFine : false,
    }),
  };
  globals.navigator = options.mobileHint === undefined ? {} : { userAgentData: { mobile: options.mobileHint } };
  globals.document = { visibilityState: options.hidden ? "hidden" : "visible" };
}

test("a touch-only device is a phone", () => {
  device({ coarse: true, anyFine: false });
  expect(phoneClassDevice()).toBe(true);
});

test("a mouse or trackpad desktop is not, whatever its window width", () => {
  device({ coarse: false, anyFine: true });
  expect(phoneClassDevice()).toBe(false);
});

test("a touchscreen laptop with a trackpad is a desktop", () => {
  device({ coarse: true, anyFine: true });
  expect(phoneClassDevice()).toBe(false);
});

test("a browser that reports itself mobile is a phone", () => {
  device({ coarse: false, anyFine: true, mobileHint: true });
  expect(phoneClassDevice()).toBe(true);
});

test("only a hidden phone suspends its traffic", () => {
  device({ coarse: true, anyFine: false, hidden: true });
  expect(hiddenTrafficSuspended()).toBe(true);
  device({ coarse: true, anyFine: false, hidden: false });
  expect(hiddenTrafficSuspended()).toBe(false);
  device({ coarse: false, anyFine: true, hidden: true });
  expect(hiddenTrafficSuspended()).toBe(false);
});

test("no window means a server render, never a suspension", () => {
  delete globals.window;
  expect(phoneClassDevice()).toBe(false);
});
