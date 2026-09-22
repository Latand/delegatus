/* The installed release: the directory the next start of web or the runtime
   host runs from. An update checks out, installs and builds a new release
   directory beside the running one and moves this pointer only when that build
   is ready, so a running process never has its node_modules or .next rewritten
   underneath it. Until the first update the checkout itself is the release. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Release { sha: string; dir: string }

export function releaseDirFor(releasesDir: string, sha: string): string {
  return join(releasesDir, sha.slice(0, 12));
}

export class ReleasePointer {
  constructor(readonly file: string, private readonly checkout: string) {}

  /* The published release, or the checkout at its HEAD. */
  current(): Release {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Release>;
      if (typeof parsed.sha === "string" && /^[0-9a-f]{40}$/.test(parsed.sha) && typeof parsed.dir === "string") {
        return { sha: parsed.sha, dir: parsed.dir };
      }
    } catch { /* nothing published yet */ }
    return { sha: headOf(this.checkout) ?? "", dir: this.checkout };
  }

  publish(release: Release): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...release, publishedAt: new Date().toISOString() }, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}

function headOf(dir: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}
