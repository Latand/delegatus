import { expect, test } from "bun:test";

import { viewerTitleLocale } from "./spawnCommand";

/* docs/design/orchestrator-reports.md §4.2: a Viewer-authored task title (the
   pinned spawn's fallback) follows the interface language the operator chose;
   the browser's Accept-Language decides only while none has been reported. */
test("the interface language decides the fallback title; Accept-Language only while it is unknown", () => {
  expect(viewerTitleLocale("en", "uk-UA,uk;q=0.9")).toBe("en");
  expect(viewerTitleLocale("uk", "en-US")).toBe("uk");
  expect(viewerTitleLocale(null, "uk-UA")).toBe("uk");
  expect(viewerTitleLocale(null, "en-US")).toBe("en");
  expect(viewerTitleLocale(null, null)).toBe("en");
});
