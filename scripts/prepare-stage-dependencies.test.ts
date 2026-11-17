import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

test.each([undefined, 0, 7])("unmanaged dependency subject preserves frozen-install fallback: %s", exit => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-dependencies-"));
  try {
    const bin = path.join(root, "bin"), marker = path.join(root, "args"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$DEPENDENCY_ARGS"\nexit ${exit ?? 99}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "prepare-stage-dependencies.ts"), ...(exit === undefined ? [] : ["--install-if-unmanaged"])], {
      cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DEPENDENCY_ARGS: marker }, encoding: "utf8",
    });
    expect(result.status).toBe(exit === 7 ? 1 : 0);
    if (exit === undefined) expect(fs.existsSync(marker)).toBeFalse();
    else expect(fs.readFileSync(marker, "utf8")).toBe("install\n--frozen-lockfile\n");
    if (exit === 7) expect(result.stderr).toContain("dependency installation failed (7)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
