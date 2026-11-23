import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
import { statePath } from "@/lib/configDir";

// An expired, unprotected root with a consumer checkout whose links never name
// it. While each final fence validates, a steady writer touches only data the
// proof does not depend on: an ordinary file in the checkout, or an unrelated
// row of the shared state database. Retirement should still complete.
async function sweepWith(writer: "none" | "checkout-file" | "state-row") {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "review-liveness-"));
  const container = path.join(parent, "container"), directory = path.join(container, "llv-stage-expired");
  const consumer = path.join(parent, "consumer");
  fs.mkdirSync(path.join(directory, "cache"), { recursive: true }); fs.writeFileSync(path.join(directory, "cache", "payload"), "expired");
  fs.mkdirSync(path.join(consumer, ".git"), { recursive: true }); fs.mkdirSync(path.join(consumer, "src"));
  fs.writeFileSync(path.join(consumer, "src", "build.log"), "");
  fs.mkdirSync(path.dirname(statePath("state.sqlite")), { recursive: true });
  const shared = new Database(statePath("state.sqlite")); shared.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS unrelated (value TEXT)");
  const store = new AttemptTempStore(path.join(parent, "registry/owners.sqlite"));
  store.register({ directory, pipelineId: null, launchId: "fixture", retainUntilClose: true, createdAt: 1 });
  const previousPath = process.env.PATH, bin = path.join(parent, "bin"); fs.mkdirSync(bin);
  for (const command of ["find", "du"]) fs.symlinkSync("/usr/bin/" + command, path.join(bin, command)); process.env.PATH = bin;
  const nativeStat = fs.lstatSync.bind(fs);
  let writes = 0;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    const value = nativeStat(file, options as { bigint: false });
    if (writer !== "none" && String(file).endsWith("/cache") && String(new Error().stack).includes("at attemptMutationCurrent")) {
      writes++;
      if (writer === "checkout-file") fs.appendFileSync(path.join(consumer, "src", "build.log"), "line\n");
      else shared.run("INSERT INTO unrelated VALUES (?)", ["row"]);
    }
    return value;
  }) as typeof fs.lstatSync);
  try {
    const report = await sweepAttemptTemps(store, { now: () => Date.parse("2030-01-20T00:00:00Z"), maxRoots: 1, state: async () => "expired",
      scan: () => ({ ownNamespace: null, processes: [{ pid: 1, namespace: null, stamped: false, paths: [consumer] }] }) });
    const result = { writer, writes, removed: report.removed, inventoryWalks: report.inventoryWalks,
      outcomes: report.outcomes.map(row => [row.disposition, row.reason.slice(-90)]), rootExists: fs.existsSync(directory) };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    stat.mockRestore(); process.env.PATH = previousPath; store.close(); shared.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "linux")("control: with no writer the expired root retires", async () => {
  expect((await sweepWith("none")).removed).toBe(1);
});
test.skipIf(process.platform !== "linux")("an ordinary file write inside a consumer checkout does not refuse the final fence", async () => {
  const result = await sweepWith("checkout-file");
  expect(result.writes).toBeGreaterThan(0);
  expect(result.removed).toBe(1);
});
test.skipIf(process.platform !== "linux")("an unrelated row written to the shared state database does not refuse the final fence", async () => {
  const result = await sweepWith("state-row");
  expect(result.writes).toBeGreaterThan(0);
  expect(result.removed).toBe(1);
});
