/* Stands in for the work-reads worker in workEvidence.test.ts: a registry read
   that holds its own thread for the given time, as synchronous SQLite and JSON
   work does, and then answers an empty registry. It marks when it entered and
   when it left, so the test can place its callers inside the read. */
import { appendFileSync } from "node:fs";

const [marker, ms] = process.argv.slice(2);
if (!marker || !ms) throw new Error("slow work reads need a marker file and a duration");

appendFileSync(marker, `entered ${Date.now()}\n`);
const until = performance.now() + Number(ms);
while (performance.now() < until) { /* synchronous work */ }
appendFileSync(marker, `left ${Date.now()}\n`);
process.stdout.write(`${JSON.stringify({ registryHealth: { value: [], ms: 0 }, pipelines: { value: [], ms: Number(ms) }, flows: { value: [], ms: 0 } })}\n`);
