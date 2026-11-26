import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Linux package assembly", () => {
  test("builds reproducibly, confines root files and rejects maintainer scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "linux-package-"));
    const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    try {
      const icons = join(root, "icons");
      mkdirSync(icons);
      for (const size of [16, 32, 128, 256, 512]) writeFileSync(join(icons, `icon_${size}x${size}.png`), "icon fixture");
      const scale = "@2x";
      writeFileSync(join(icons, `icon_32x32${scale}.png`), "64px fixture");
      const manifest = join(root, "runtime-manifest.json");
      writeFileSync(manifest, JSON.stringify({ mode: "pr", platform: "linux", delegatus: { version } }));
      writeFileSync(join(root, "delegatus.tgz"), "package fixture");
      const build = (output: string, epoch: string, mode = "pr") => spawnSync("python3", ["-I", "scripts/linux-app/build_package.py", mode, join(root, output), manifest, icons], {
        env: { ...process.env, SOURCE_DATE_EPOCH: epoch, GITHUB_REPOSITORY: "fixture/project" }, encoding: "utf8",
      });
      const first = build("one", "1700000000");
      expect(first.status, first.stderr).toBe(0);
      expect(build("two", "1700000000").status).toBe(0);
      expect(build("changed", "1700000001").status).toBe(0);
      const name = `delegatus_${version.replace("-", "~")}_all.deb`;
      expect(readFileSync(join(root, "one", name))).toEqual(readFileSync(join(root, "two", name)));
      expect(readFileSync(join(root, "one", name))).not.toEqual(readFileSync(join(root, "changed", name)));
      const info = execFileSync("dpkg-deb", ["--field", join(root, "one", name)], { encoding: "utf8" });
      expect(info).toContain("Architecture: all");
      expect(info).toContain("gir1.2-webkit2-4.1");
      expect(info).toContain("python3 (>= 3.11)");
      const extracted = join(root, "extracted");
      execFileSync("dpkg-deb", ["--raw-extract", join(root, "one", name), extracted]);
      expect(execFileSync("python3", ["-I", "scripts/linux-app/package_checks.py", extracted, "pr"], { encoding: "utf8" })).toContain("root footprint: pass");
      writeFileSync(join(extracted, "DEBIAN", "postinst"), "#!/bin/sh\nexit 0\n");
      expect(spawnSync("python3", ["-I", "scripts/linux-app/package_checks.py", extracted, "pr"]).status).not.toBe(0);
      expect(build("release", "1700000000", "release").status).not.toBe(0);
      writeFileSync(manifest, JSON.stringify({ mode: "release", platform: "linux", delegatus: { version } }));
      expect(build("release", "1700000000", "release").status).toBe(0);
      const releaseRoot = join(root, "release-root");
      execFileSync("dpkg-deb", ["--raw-extract", join(root, "release", name), releaseRoot]);
      expect(execFileSync("python3", ["-I", "scripts/linux-app/package_checks.py", releaseRoot, "release"], { encoding: "utf8" })).toContain("pass");
      writeFileSync(join(releaseRoot, "usr/lib/delegatus-app/delegatus.tgz"), "unwanted bundle");
      expect(spawnSync("python3", ["-I", "scripts/linux-app/package_checks.py", releaseRoot, "release"]).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test.each(["invalid", "", "../release"])("refuses an invalid build mode %s before network", mode => {
    expect(spawnSync("bash", ["scripts/linux-app/build.sh", mode, "/unused"]).status).not.toBe(0);
  });
});
