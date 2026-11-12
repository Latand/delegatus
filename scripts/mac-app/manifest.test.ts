import { describe, expect, test } from "bun:test";
import { digest, validatePackage, verifiedBun } from "./manifest";

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
