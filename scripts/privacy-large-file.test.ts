import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = join(import.meta.dir, "privacy-publication-gate.ts");
// Under 8% of the failed push's 839-second budget, with CI headroom over the
// measured local run. Each real child is bounded separately from the test.
const budgetMs = 60_000;

test("a synthetic two-megabyte changed file gets the full privacy verdict within budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "llv-privacy-large-"));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_") || name.startsWith("LLV_PRIVACY_")) delete env[name];
  }
  Object.assign(env, {
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"), CLAUDE_CODE_TMPDIR: join(root, "tmp"),
    LLV_STATE_DIR: join(root, "state"), NO_COLOR: "1",
  });
  for (const name of ["home", "config", "tmp", "state"]) mkdirSync(join(root, name));
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync({
      cmd: ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Synthetic", "-c", "user.email=noreply@fixture.invalid", ...args],
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--quiet");
    writeFileSync(join(root, ".gitignore"), "home/\nconfig/\ntmp/\nstate/\ncatalog.json\n");
    writeFileSync(join(root, "changed.txt"), "synthetic baseline\n");
    git("add", ".gitignore", "changed.txt");
    git("commit", "--quiet", "-m", "Synthetic baseline");
    const base = git("rev-parse", "HEAD");
    // Vary letters, avoiding live values and identifier-shaped fixture data.
    // Decoding changes offsets throughout a full-size, non-ASCII input.
    const content = Array.from({ length: 48_000 }, (_, index) => {
      let number = index;
      let letters = "";
      for (let place = 0; place < 5; place += 1) {
        letters += String.fromCharCode(97 + number % 26);
        number = Math.floor(number / 26);
      }
      return `synthetic row ${letters} %41 &amp; 💡 \\u0062\n`;
    }).join("");
    expect(Buffer.byteLength(content)).toBeGreaterThan(2_000_000);
    expect(Buffer.byteLength(content)).toBeLessThan(2_300_000);
    const fingerprints = [8, 12, 13, 14, 16, 17].map((length) => ({
      length, exactOnly: false, sha256: createHash("sha256").update("z".repeat(length)).digest("hex"),
    }));
    fingerprints.push({ length: 10, exactOnly: true, sha256: createHash("sha256").update("z".repeat(10)).digest("hex") });
    const catalog = join(root, "catalog.json");
    writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, normalization: "nfkc-lower-alnum-v1", fingerprints }));
    Object.assign(env, { LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: catalog, LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr" });
    const run = async () => {
      const started = performance.now();
      const child = Bun.spawn({
        cmd: [process.execPath, gate, "--repository", root, "--base", base, "--require-known-values", "--check-commits"],
        cwd: root, env, stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), budgetMs);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        const elapsedMs = performance.now() - started;
        console.info(`Synthetic privacy gate: bytes=${Buffer.byteLength(content)} elapsed=${(elapsedMs / 1000).toFixed(2)}s bound=${budgetMs / 1000}s`);
        expect(elapsedMs).toBeLessThan(budgetMs);
        expect(stderr).toBe("");
        return { stdout, exitCode };
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      }
    };
    writeFileSync(join(root, "changed.txt"), content);
    git("add", "changed.txt");
    git("commit", "--quiet", "-m", "Synthetic large change");
    expect(await run()).toEqual({ stdout: "PRIVACY GATE: PASS\n", exitCode: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, budgetMs + 10_000);
