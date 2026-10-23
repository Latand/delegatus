import { expect, test } from "bun:test";
import { stdioContainment } from "./containment";

test("macOS, Windows and other platforms report their reason without searching for Linux tools", async () => {
  for (const [platform, reason] of [["darwin", "MACOS"], ["win32", "WINDOWS"], ["freebsd", "PLATFORM_UNSUPPORTED"]] as const) {
    expect(await stdioContainment(platform, async () => { throw new Error("must not search"); })).toEqual({ reason });
  }
});

test("Linux distinguishes missing bubblewrap, unavailable namespaces and usable containment", async () => {
  expect(await stdioContainment("linux", async () => null)).toEqual({ reason: "BWRAP_MISSING" });
  const calls: string[] = [];
  for (const available of [false, true]) {
    expect(await stdioContainment("linux", async () => "/usr/bin/bwrap", async file => { calls.push(file); return available; }))
      .toEqual(available ? { executable: "/usr/bin/bwrap" } : { reason: "BWRAP_UNAVAILABLE" });
  }
  expect(calls).toEqual(["/usr/bin/bwrap", "/usr/bin/bwrap"]);
});
