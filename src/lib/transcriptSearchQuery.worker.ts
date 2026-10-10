import { createInterface } from "node:readline";
import { transcriptSearchSteps, type TranscriptSearchOptions } from "@/lib/search/transcriptSearch";

// stdout carries protocol frames only, including full source text for a
// trusted redactor. Exception text, SQL and paths never cross as diagnostics.
console.log = (...values: unknown[]) => { console.error(...values); };
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let projection: { resolve: (text: string) => void } | null = null;
let active: number | null = null;

async function search(id: number, options: TranscriptSearchOptions, redact: boolean): Promise<void> {
  active = id;
  const steps = transcriptSearchSteps({ ...options, ...(redact ? { redactText: (text: string) => text } : {}) });
  try {
    let step = steps.next();
    while (!step.done) {
      const text = await new Promise<string>((resolve) => {
        projection = { resolve };
        send({ id, type: "redact", text: step.value });
      });
      step = steps.next(text);
    }
    send({ id, type: "result", result: step.value, rssBytes: process.memoryUsage().rss });
  } catch (error) {
    send({ id, type: "error", name: error instanceof Error ? error.name : "Error" });
  } finally {
    steps.return(undefined as never);
    projection = null;
    active = null;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const frame = JSON.parse(line);
    if (frame.type === "redacted" && frame.id === active && projection && typeof frame.text === "string") {
      const pending = projection;
      projection = null;
      pending.resolve(frame.text);
    } else if (frame.type === "search" && active === null && Number.isSafeInteger(frame.id)) {
      void search(frame.id, frame.options, frame.redact === true);
    } else process.exit(1);
  } catch { process.exit(1); }
});
