import fs from "node:fs";
import path from "node:path";

import { ingest, plan, prepare, readDataset, score, validate } from "../evals/roles/runner";
import type { TrialReceipt } from "../evals/roles/schema";

const [operation, ...args] = process.argv.slice(2);
const dataset = readDataset();
if (operation === "validate") {
  const errors = validate(dataset);
  console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
  process.exitCode = errors.length ? 1 : 0;
} else if (operation === "prepare") {
  if (!args[0]) throw new Error("usage: role-eval prepare <isolated-directory>");
  prepare(dataset, path.resolve(args[0]));
} else if (operation === "plan") {
  if (!args[0]) throw new Error("usage: role-eval plan <model-evidence.json>");
  const evidence = JSON.parse(fs.readFileSync(args[0], "utf8"));
  console.log(JSON.stringify(plan(dataset, evidence.receipts ?? [], evidence.models ?? [], evidence.harnessHead), null, 2));
} else if (operation === "ingest") {
  if (!args[0]) throw new Error("usage: role-eval ingest <receipt.json>");
  console.log(JSON.stringify(ingest(dataset, JSON.parse(fs.readFileSync(args[0], "utf8")) as TrialReceipt), null, 2));
} else if (operation === "score") {
  if (!args[0]) throw new Error("usage: role-eval score <scoring-input.json>");
  const input = JSON.parse(fs.readFileSync(args[0], "utf8"));
  console.log(JSON.stringify(score(input.receipt, input.checks), null, 2));
} else throw new Error("usage: role-eval <validate|prepare|plan|ingest|score>");
