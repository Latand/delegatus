import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepare, readDataset } from "./runner";

test("prepare writes only the chosen isolated workspace", () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-eval-"));
  try {
    prepare(readDataset(), destination);
    expect(JSON.parse(fs.readFileSync(path.join(destination, "prepared.json"), "utf8"))).toMatchObject({ seed: "20260920" });
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
