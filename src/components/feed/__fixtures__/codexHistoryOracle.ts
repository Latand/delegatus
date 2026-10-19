/** Run by the focused oracle test under the timezone recorded with its hashes. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setLocale } from "@/lib/i18n";
import * as parser from "../parse";
import { codexHistoryCorpus, codexHistorySeams } from "./codexHistory";
import { comparableHistory, realHistoryIds } from "./codexHistoryComparison";
import oracle from "./codexHistoryOracle.json";

setLocale("en");
const inputs: Record<string, string[]> = { seams: codexHistorySeams(), corpus: codexHistoryCorpus(533) };
const digests = oracle.rows.map(row => {
  const lines = inputs[row.name] ??= readFileSync(path.join(import.meta.dir, "../fixtures", row.name), "utf8").trim().split("\n");
  const snapshot = parser.createFeedSession({ engine: "codex", fmt: "codex", showSvc: row.showSvc, lineFilter: "" }).feed(lines, row.offset, false);
  return createHash("sha256").update(JSON.stringify(comparableHistory(snapshot, parser, realHistoryIds(lines)))).digest("hex");
});
process.stdout.write(JSON.stringify(digests));
