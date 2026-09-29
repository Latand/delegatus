import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HistoryEntry {
  at: string;
  by: "operator" | "auto";
  kind: "build" | "restart-web" | "restart-host";
  target: string;
  from: string | null;
  outcome: "done" | "failed" | "fell-back";
  detail?: string;
}
export function readHistory(file: string, limit = 20): HistoryEntry[] {
  try {
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line) as HistoryEntry;
        return value && typeof value.at === "string" && typeof value.kind === "string" ? [value] : [];
      } catch { return []; }
    }).slice(-limit).reverse();
  } catch { return []; }
}
export function appendHistory(file: string, entry: HistoryEntry): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  if (readFileSync(file, "utf8").split("\n").length - 1 > 1_000) {
    const latest = readHistory(file, 500).reverse();
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, latest.map((item) => JSON.stringify(item)).join("\n") + "\n");
    renameSync(temporary, file);
  }
}
