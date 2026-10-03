/* The installed release (#2007, checkout mode): the directory the next start
   of web or the runtime host runs from. An update checks out, installs and
   builds a new release directory beside the running one and moves this
   pointer only when that build is ready, so a running process never has its
   node_modules or .next rewritten underneath it. Until the first update the
   checkout itself is the release.

   `bin/self-update-supervisor.mjs` (`installedRelease`) reads the same file
   at every start and restart and applies the same rule: the pointer counts
   only while its directory holds a build of the named commit and the
   checkout's own HEAD has not moved since it was published (a checkout that
   moved was updated by hand, and that newer choice wins). */
import { realExec } from "@/lib/workflows/provision";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Release { sha: string; dir: string }

export function releaseDirFor(releasesDir: string, sha: string): string {
  return join(releasesDir, sha.slice(0, 12));
}

export async function headOf(dir: string): Promise<string | null> {
  const result = await realExec("git", ["rev-parse", "HEAD"], dir, undefined, { timeoutMs: 2_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

export class ReleasePointer {
  constructor(readonly file: string, private readonly checkout: string) {}

  /** The published release, or the checkout at its HEAD. */
  async current(): Promise<Release> {
    const checkoutHead = await headOf(this.checkout);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Release> & { checkoutHead?: unknown };
      const unmoved = typeof parsed.checkoutHead !== "string" || parsed.checkoutHead === checkoutHead;
      if (typeof parsed.sha === "string" && /^[0-9a-f]{40}$/.test(parsed.sha) && typeof parsed.dir === "string"
        && unmoved && existsSync(join(parsed.dir, ".next", "BUILD_ID")) && await headOf(parsed.dir) === parsed.sha) {
        return { sha: parsed.sha, dir: parsed.dir };
      }
    } catch { /* nothing published yet */ }
    return { sha: checkoutHead ?? "", dir: this.checkout };
  }

  async publish(release: Release): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = { ...release, checkoutHead: await headOf(this.checkout), publishedAt: new Date().toISOString() };
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}
