import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { digest, validatePackage, verifiedBun } from "./manifest";
import { appSessionData, intelIsTranslated, smokeEnvironment, smokeStdio } from "./smoke-platform.mjs";

describe("Mac runtime manifest", () => {
  const bytes = new TextEncoder().encode("archive fixture");
  const name = "bun-darwin-aarch64.zip";
  const hash = digest(bytes, "sha256");
  test("accepts the exact named Bun checksum", () => {
    expect(verifiedBun(bytes, `${hash}  ${name}\n`, name)).toBe(hash);
    expect(verifiedBun(bytes, `${hash} *${name}\n`, name)).toBe(hash);
  });
  test.each([`${"0".repeat(64)}  ${name}`, `${hash}  different.zip`, "bad checksum", `${hash}  ../${name}`])("rejects a mismatched archive or checksum: %s", sums => {
    expect(() => verifiedBun(bytes, sums, name)).toThrow();
  });
  const revision = "a".repeat(40);
  const integrity = `sha512-${digest(bytes, "sha512")}`;
  const valid = { name: "delegatus-cli", version: "2.0.0", gitHead: revision, dist: { tarball: "https://registry.npmjs.org/delegatus-cli/-/delegatus-cli-2.0.0.tgz", integrity } };
  test("pins package version, revision, URL and publisher integrity", () => {
    expect(validatePackage(valid, "2.0.0", revision, integrity)).toEqual({ version: "2.0.0", gitHead: revision, tarball: valid.dist.tarball, integrity });
  });
  test.each([
    { ...valid, name: "other" }, { ...valid, version: "1.0.0" }, { ...valid, gitHead: "b".repeat(40) },
    { ...valid, dist: { ...valid.dist, tarball: "http://registry.npmjs.org/delegatus-cli/-/archive.tgz" } },
    { ...valid, dist: { ...valid.dist, tarball: "https://registry.npmjs.org.evil.invalid/delegatus-cli/-/archive.tgz" } },
    { ...valid, dist: { ...valid.dist, integrity: "sha256-invalid" } },
  ])("refuses changed registry identity %#", value => {
    expect(() => validatePackage(value, "2.0.0", revision, integrity)).toThrow();
  });
  test("refuses integrity different from the publisher", () => {
    expect(() => validatePackage(valid, "2.0.0", revision, "sha512-different")).toThrow();
  });
});

describe("Mac smoke fixture input", () => {
  test.each([undefined, "", "fixture input\n"])("preserves supplied stdin and closes absent stdin %#", input => {
    const result = execFileSync("/bin/cat", [], { encoding: "utf8", stdio: smokeStdio(input), input, timeout: 10_000 });
    expect(result).toBe(input ?? "");
  });
});

describe("Mac smoke session environment", () => {
  const session = { user: "runner-fixture", home: "/fixture/cases/h3" };
  test("keeps server settings while the case home and fixed session values win", () => {
    const environment = smokeEnvironment(session, { LLV_LANG: "uk", LLV_TOKEN: "fixture", HOME: "/foreign", PATH: "/foreign/bin", DELEGATUS_TELEMETRY: "1" });
    expect(environment).toEqual({
      LLV_LANG: "uk", LLV_TOKEN: "fixture",
      HOME: session.home, USER: session.user, LOGNAME: session.user,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", DELEGATUS_TELEMETRY: "0",
    });
  });
  test("inherits nothing from the driver's own environment", () => {
    expect(Object.keys(smokeEnvironment(session)).sort()).toEqual(["DELEGATUS_TELEMETRY", "HOME", "LOGNAME", "PATH", "USER"]);
  });
  test.each([
    { user: "", home: "/fixture/home" },
    { user: "runner-fixture", home: "relative/home" },
    { user: "runner-fixture", home: undefined },
  ])("refuses a session without a user or an absolute home %#", context => {
    expect(() => smokeEnvironment(context)).toThrow("Invalid smoke session context");
  });
});

describe("Mac smoke app session data", () => {
  test("names only the bundle's own preferences, restored windows and web data under the runner home", () => {
    const paths = appSessionData("/fixture/runner", "org.delegatus.app");
    expect(paths).toEqual([
      "/fixture/runner/Library/Preferences/org.delegatus.app.plist",
      "/fixture/runner/Library/Saved Application State/org.delegatus.app.savedState",
      "/fixture/runner/Library/WebKit/org.delegatus.app",
      "/fixture/runner/Library/Caches/org.delegatus.app",
      "/fixture/runner/Library/HTTPStorages/org.delegatus.app",
      "/fixture/runner/Library/HTTPStorages/org.delegatus.app.binarycookies",
    ]);
  });
  test.each([
    ["relative", "org.delegatus.app"],
    ["/fixture/runner", ""],
    ["/fixture/runner", "../Library"],
    ["/fixture/runner", "org/delegatus"],
    ["/fixture/runner", "single"],
  ])("refuses an owner that could reach beyond the bundle's data %#", (runnerHome, bundle) => {
    expect(() => appSessionData(runnerHome, bundle)).toThrow("Invalid app session data owner");
  });
});

describe("Intel smoke architecture guard", () => {
  test.each([
    { status: 0, stdout: "0\n", stderr: "", translated: false },
    { status: 1, stdout: "", stderr: "sysctl: unknown oid 'sysctl.proc_translated'\n", translated: false },
    { status: 0, stdout: "1\n", stderr: "", translated: true },
  ])("classifies documented translation probe result %#", ({ status, stdout, stderr, translated }) => {
    expect(intelIsTranslated({ status, stdout, stderr })).toBe(translated);
  });
  test.each([
    { status: 2, stdout: "", stderr: "permission denied" },
    { status: 1, stdout: "", stderr: "sysctl: permission denied for sysctl.proc_translated" },
    { status: 0, stdout: "unexpected\n", stderr: "" },
  ])("refuses a genuine or malformed translation probe failure %#", result => {
    expect(() => intelIsTranslated(result)).toThrow();
  });
});
