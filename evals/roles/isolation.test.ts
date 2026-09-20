import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { prepare, git, hashTree } from "./runner";
import { sandbox } from "./testSupport";
test("twelve independent clean histories contain identical shared bytes, no controls/briefs/graders", () => {
    const s = sandbox();
    try {
        const destination = path.join(s.root, "candidates");
        prepare(s.dataset, destination, s.sealed);
        for (const f of s.dataset.fixtures)
            for (const arm of ["A", "B", "C", "planner"]) {
                const dir = path.join(destination, f.id + "-" + arm);
                expect(git(dir, ["rev-parse", "HEAD"])).toBe(f.baseCommit);
                expect(git(dir, ["status", "--porcelain"])).toBe("");
                expect(fs.existsSync(path.join(dir, "grader"))).toBe(false);
                expect(fs.existsSync(path.join(dir, "brief.md"))).toBe(false);
                expect(hashTree(path.join(dir, "support"))).toBe(f.supportHash);
            }
        fs.appendFileSync(path.join(s.sealed, "holdout/quota-window/vectors.json"), " ");
        expect(() => prepare(s.dataset, path.join(s.root, "changed"), s.sealed)).toThrow("sealed holdout changed");
    }
    finally {
        s.cleanup();
    }
});
