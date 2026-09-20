// Runs inside a network/filesystem namespace containing only candidate files.
const [caseId] = process.argv.slice(2);
const file = caseId === "quota-window" ? "quotaSummary.ts" : "diagnosticSummary.ts";
const candidate = await import("/candidate/case/" + file);
const input = await Bun.stdin.json();
const before = JSON.stringify(input);
const actual = caseId === "quota-window" ? candidate.quotaSummary(input) : candidate.diagnosticSummary(input);
console.log(JSON.stringify({ actual, before, after: JSON.stringify(input) }));
export {};
