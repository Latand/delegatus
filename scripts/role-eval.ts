import fs from "node:fs";
import path from "node:path";
import { freezeBrief, grade, ingest, initRun, plan, prepare, prepareControl, readDataset, score, validate, verifySealed } from "../evals/roles/runner";
const [operation, ...args] = process.argv.slice(2);
const data = readDataset();
const json = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
let result: unknown;
if (operation === "validate") {
    const errors = validate(data);
    if (args[0])
        verifySealed(data, path.resolve(args[0]));
    result = { ok: !errors.length, errors };
    process.exitCode = errors.length ? 1 : 0;
}
else if(operation==="control" && args.length===3)
    result=prepareControl(data,args[0],args[1],path.resolve(args[2]));
else if (operation === "prepare" && args[0] && args[1])
    result = prepare(data, path.resolve(args[0]), path.resolve(args[1]));
else if (operation === "init" && args[0] && args[1])
    result = initRun(data, path.resolve(args[0]), args[1]);
else if (operation === "freeze" && args.length === 3)
    result = freezeBrief(data, path.resolve(args[0]), args[1], args[2]);
else if (operation === "plan" && args[0] && args[1]) {
    const input = json(args[1]);
    result = plan(data, path.resolve(args[0]), input.models, input.identity, input.stage);
}
else if (operation === "ingest" && args[0] && args[1])
    result = ingest(data, path.resolve(args[0]), json(args[1]));
else if (operation === "grade" && args.length === 4) {
    const graded = grade(data, path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]));
    result = graded;
    process.exitCode = graded.checks.some(c => c.exitCode !== 0) ? 1 : 0;
}
else if (operation === "score" && args.length === 2) {
    result = score(data, path.resolve(args[0]), args[1]);
    process.exitCode = (result as {
        verdict: string;
    }).verdict === "pass" ? 0 : 1;
}
else
    throw new Error("usage: role-eval validate [sealedRoot] | prepare <workspaces> <sealedRoot> | init <trustedRoot> <harnessSHA> | freeze <trustedRoot> <caseId> <planner-transcript.json> | plan <trustedRoot> <input.json> | ingest <trustedRoot> <receipt.json> | grade <trustedRoot> <sealedRoot> <cellId> <candidateRepo> | score <trustedRoot> <cellId>");
console.log(JSON.stringify(result ?? { ok: true }, null, 2));
