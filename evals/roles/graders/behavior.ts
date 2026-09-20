import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Run by the trusted root against an exported candidate. Test vectors stay outside it.
export async function gradeBehavior(caseId: string, workspace: string, vectorsFile: string) {
    const vectors = JSON.parse(fs.readFileSync(vectorsFile, "utf8"));
    let checked = 0;
    for (const vector of vectors) {
        const input = structuredClone(vector.input);
        if (input.text?.syntheticToken)
            input.text = "sk-" + "z".repeat(22);
        const before = JSON.stringify(input);
        const result = JSON.parse(execFileSync("bwrap", [
            "--unshare-all", "--die-with-parent", "--clearenv", "--ro-bind", "/usr", "/usr",
            "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev",
            "--tmpfs", "/tmp", "--dir", "/home", "--setenv", "HOME", "/home", "--setenv", "TMPDIR", "/tmp",
            "--ro-bind", fs.realpathSync(process.execPath), "/bun", "--ro-bind", workspace, "/candidate",
            "--ro-bind", path.join(import.meta.dir, "candidate-worker.ts"), "/worker.ts",
            "--chdir", "/candidate", "/bun", "/worker.ts", caseId,
        ], { input: JSON.stringify(input), encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }));
        const actual = result.actual;
        assert.equal(result.before, before);
        assert.equal(result.after, before, vector.name + ": mutated input");
        assert.deepEqual(actual, vector.expected, vector.name);
        assert.equal(JSON.stringify(input), before, `${vector.name}: mutated input`);
        checked++;
    }
    assert.ok(checked > 0, "empty grader");
    return { checked };
}
if (import.meta.main) {
    const [caseId, workspace, vectors] = process.argv.slice(2);
    console.log(JSON.stringify(await gradeBehavior(caseId, workspace, vectors)));
}
