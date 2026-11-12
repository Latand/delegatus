import { describe, expect, test } from "bun:test";
import { digest, validatePackage, verifiedBun } from "./manifest";
import { intelIsTranslated, smokeUserArguments } from "./smoke-platform.mjs";

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

describe("Fresh Mac smoke account context", () => {
  const account = { uid: 502, user: "smoke-fixture", home: "/fixture/home" };
  test.each([
    ["/fixture/Delegatus.app/Contents/MacOS/Delegatus", ["--evidence-dir", "/fixture/frames with spaces"]],
    ["/fixture/private bun", ["/fixture/private cli", "--no-open"]],
    ["/bin/launchctl", ["manageruid"]],
  ])("joins the account context before dropping credentials for %s", (command, args) => {
    const invocation = smokeUserArguments(account, command, args);
    expect(invocation.slice(0, 9)).toEqual(["-n", "/bin/launchctl", "asuser", "502", "/usr/bin/sudo", "-n", "-u", account.user, "-H"]);
    const env = invocation.indexOf("/usr/bin/env");
    expect(invocation[env + 1]).toBe("-i");
    expect(invocation).toContain(`HOME=${account.home}`);
    expect(invocation).toContain("PATH=/usr/bin:/bin:/usr/sbin:/sbin");
    expect(invocation.slice(-args.length - 1)).toEqual([command, ...args]);
  });
  test("retains server settings while account isolation wins over copied defaults", () => {
    const invocation = smokeUserArguments(account, "/fixture/bun", [], { LLV_LANG: "uk", HOME: "/foreign", PATH: "/foreign/bin" });
    const env = Object.fromEntries(invocation.slice(invocation.indexOf("-i") + 1, -1).map(entry => entry.split(/=(.*)/s).slice(0, 2)));
    expect(env).toMatchObject({ HOME: account.home, USER: account.user, LOGNAME: account.user, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LLV_LANG: "uk" });
  });
  test.each([0, -1, 1.5, NaN, undefined])("refuses an invalid or privileged account UID: %s", uid => {
    expect(() => smokeUserArguments({ ...account, uid }, "/usr/bin/true")).toThrow("Invalid smoke account context");
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
