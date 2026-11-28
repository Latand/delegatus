import fs from "node:fs";
import path from "node:path";

export async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("journal fixture handshake timed out");
    await Bun.sleep(5);
  }
}

export function journalTickets(directory: string): number {
  const queue = `${directory}.pending.jsonl.write-locks`;
  return fs.existsSync(queue) ? fs.readdirSync(queue).length : 0;
}

export function journalClaims(directory: string): string[] {
  return fs.readdirSync(path.dirname(directory)).filter(name => name.startsWith(`${path.basename(directory)}.pending.jsonl.claim-`)).sort();
}

export function startJournalPeer(directory: string, marker: string, options: {
  append?: string;
  triggered?: boolean;
  withdraw?: string;
  maxHoldMs?: number;
} = {}) {
  const child = Bun.spawn([process.execPath, "-e", `
    import fs from "node:fs";
    import { withFileTransactionAsync } from ${JSON.stringify(new URL("../state/fileTransaction.ts", import.meta.url).pathname)};
    import { interruptionObligationStore } from ${JSON.stringify(new URL("./interruptionObligations.ts", import.meta.url).pathname)};
    const [directory, marker, raw] = process.argv.slice(1);
    const options = JSON.parse(raw);
    async function waitFor(file, ms) {
      const end = performance.now() + ms;
      while (!fs.existsSync(file) && performance.now() < end) await Bun.sleep(5);
      return fs.existsSync(file);
    }
    if (options.triggered && !await waitFor(marker + ".start", 60_000)) throw new Error("missing trigger");
    if (options.withdraw && !interruptionObligationStore(directory).withdraw(options.withdraw)) throw new Error("missing withdrawal");
    const journal = directory + ".pending.jsonl";
    await withFileTransactionAsync(journal, "fixture journal writer", async () => {
      if (options.append) fs.appendFileSync(journal, options.append);
      fs.writeFileSync(marker + ".held", "");
      await waitFor(marker + ".release", options.maxHoldMs ?? 7_000);
    }, { waitMs: 8_000 });
  `, directory, marker, JSON.stringify(options)], { stdout: "ignore", stderr: "inherit" });
  const release = () => fs.writeFileSync(marker + ".release", "");
  return {
    async ready() { await until(() => fs.existsSync(marker + ".held") || child.exitCode !== null); },
    trigger() { fs.writeFileSync(marker + ".start", ""); },
    held() { return fs.existsSync(marker + ".held") && child.exitCode === null; },
    release,
    async stop() {
      release();
      if (options.triggered) fs.writeFileSync(marker + ".start", "");
      return child.exited;
    },
  };
}
