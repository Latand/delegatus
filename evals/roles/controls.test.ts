import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
for (const id of ["quota-window", "diagnostic-summary"]) {
    test(`${id}: identical behavioral grader executes correct and defective candidates`, () => {
        for (const [variant, passes] of [["correct", true], ["defective", false], ["seeded-bug", false]] as const) {
            const root = path.join(import.meta.dir, "fixtures", id);
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "re-control-"));
            try {
                fs.cpSync(path.join(root, "base"), workspace, { recursive: true });
                fs.cpSync(path.join(root, "base/support"), path.join(workspace, "support"), { recursive: true });
                for (const file of fs.readdirSync(path.join(root, "controls", variant, "case")))
                    fs.copyFileSync(path.join(root, "controls", variant, "case", file), path.join(workspace, "case", file.replace(/\.txt$/, "")));
                const run = () => execFileSync(process.execPath, [path.join(import.meta.dir, "graders/behavior.ts"), id, workspace, path.join(root, "public.json")], { stdio: "pipe" });
                if (passes)
                    expect(run).not.toThrow();
                else
                    expect(run).toThrow();
            }
            finally {
                fs.rmSync(workspace, { recursive: true, force: true });
            }
        }
    });
}
