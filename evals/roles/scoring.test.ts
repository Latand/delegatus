import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { grade, score, readRun, writeRun, git } from "./runner";
import { sandbox, candidate, evidence, approve } from "./testSupport";
test("real candidate execution and signed byte-bound artifacts accept correct and reject seeded defect", () => {
    for (const variant of ["correct", "seeded-bug"]) {
        const s = sandbox();
        try {
            const w = candidate(s.root, "quota-window", variant);
            evidence(s.root, "quota-window-A", w);
            approve(s.root, "quota-window-A", w);
            const result = grade(s.dataset, s.root, s.sealed, "quota-window-A", w);
            expect(result.checks.every(c => c.exitCode === 0)).toBe(variant === "correct");
            expect(score(s.dataset, s.root, "quota-window-A").verdict).toBe(variant === "correct" ? "pass" : "fail");
        }
        finally {
            s.cleanup();
        }
    }
});
test("fabricated, missing, tampered, stale, forbidden and REQUEST_CHANGES evidence cannot pass", () => {
    const s = sandbox();
    try {
        const w = candidate(s.root, "quota-window");
        const { receipt } = evidence(s.root, "quota-window-A", w);
        approve(s.root, "quota-window-A", w);
        expect(score(s.dataset, s.root, "quota-window-A").verdict).toBe("fail");
        const artifact = grade(s.dataset, s.root, s.sealed, "quota-window-A", w);
        const dir = path.join(s.root, "grades/quota-window-A", receipt.candidateHead!);
        const file = path.join(dir, "grade.json");
        const original = fs.readFileSync(file, "utf8");
        const originalLog = fs.readFileSync(path.join(dir, "public.log"));
        fs.writeFileSync(file, JSON.stringify({ ...artifact, signature: "a".repeat(64) }));
        expect(score(s.dataset, s.root, "quota-window-A").reasons).toContain("untrusted/fabricated grading artifact");
        fs.writeFileSync(file, original);
        fs.appendFileSync(path.join(dir, "public.log"), "fabricated");
        expect(score(s.dataset, s.root, "quota-window-A").reasons).toContain("artifact bytes changed");
        const review = path.join(s.root, "review.json"), data = JSON.parse(fs.readFileSync(review, "utf8"));
        data.records[0].text = "REQUEST_CHANGES at " + receipt.candidateHead;
        fs.writeFileSync(review, JSON.stringify(data));
        // Keep this independent of log tamper: scoring must fail for review as well.
        fs.writeFileSync(path.join(dir, "public.log"), originalLog);
        expect(score(s.dataset, s.root, "quota-window-A").reasons).toContain("Viewer final review does not approve this head");
        data.records[0].text = "APPROVE at " + receipt.candidateHead;
        fs.writeFileSync(review, JSON.stringify(data));
        const approvalFile = path.join(s.root, "reviews/quota-window-A.json"), approval = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
        approval.audit.violations = ["production action"];
        fs.writeFileSync(approvalFile, JSON.stringify(approval));
        expect(score(s.dataset, s.root, "quota-window-A").reasons).toContain("forbidden-action audit missing/failed");
        const run = readRun(s.root);
        run.receipts[0].candidateHead = "b".repeat(40);
        run.receipts[0].publishedHead = "b".repeat(40);
        writeRun(s.root, run);
        expect(score(s.dataset, s.root, "quota-window-A").verdict).toBe("fail");
        fs.appendFileSync(path.join(w, "support/README.md"), "changed");
        git(w, ["add", "."]);
        git(w, ["commit", "--quiet", "-m", "forbidden"]);
        run.receipts[0].candidateHead = git(w, ["rev-parse", "HEAD"]);
        run.receipts[0].publishedHead = run.receipts[0].candidateHead;
        writeRun(s.root, run);
        expect(() => grade(s.dataset, s.root, s.sealed, "quota-window-A", w)).toThrow("forbidden-file");
    }
    finally {
        s.cleanup();
    }
});
