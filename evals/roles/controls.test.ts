import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readDataset } from "./runner";
test("public controls are executable: correct passes and defective variants fail", () => { const root = path.join(import.meta.dir, "fixtures"); for (const fixture of readDataset().fixtures) { const run = (variant: string) => execFileSync("bun", ["run", path.join(root, fixture.id, "controls", variant, "grader.ts")], { encoding: "utf8" }); expect(() => run("correct")).not.toThrow(); expect(() => run("defective")).toThrow(); expect(() => run("seeded-bug")).toThrow(); } });
