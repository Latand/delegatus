import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, readDataset } from "./runner";
test("prepare materializes reproducible candidate workspaces without sealed data", () => { const temporaryRoot = os.tmpdir(); fs.mkdirSync(temporaryRoot, { recursive: true }); const destination = fs.mkdtempSync(path.join(temporaryRoot, "llv-role-eval-")); try { prepare(readDataset(), destination); const prepared = JSON.parse(fs.readFileSync(path.join(destination, "prepared.json"), "utf8")); expect(prepared.prepared).toHaveLength(3); expect(fs.existsSync(path.join(destination, "error-row", "workspace", "case", "ErrorRow.tsx"))).toBe(true); expect(fs.existsSync(path.join(destination, "error-row", "workspace", "grader"))).toBe(false); } finally { fs.rmSync(destination, { recursive: true, force: true }); } });
