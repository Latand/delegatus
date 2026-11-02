import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCloudRunSetup } from "./cloudRunSetupImport";

test("legacy setup import selects identifiers by verified configuration and environment, leaving private payloads behind", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-import-"));
  try {
    fs.writeFileSync(path.join(root, "environment.private.json"), JSON.stringify({ result: { id: "asenvcfg_fixture", environment_id: "ccarenv_setup", draft: { id: "draft-fixture", revision: 1 }, install_script: "private-content", privateValue: "private-content" } }));
    fs.writeFileSync(path.join(root, "approval.private.json"), JSON.stringify({ result: { id: "operation-fixture", environment_id: "ccarenv_setup", state: "RUNNING", privateValue: "private-content" } }));
    const imported = await readCloudRunSetup("asenvcfg_fixture", "fixed-intent", root);
    expect(imported).toEqual({ intent: "fixed-intent", configId: "asenvcfg_fixture", draftId: "draft-fixture", environmentId: "ccarenv_setup", operationId: "operation-fixture", draftRevision: 1 });
    expect(await readCloudRunSetup("asenvcfg_other", "fixed-intent", root)).toBeNull();
    expect(await readCloudRunSetup("asenvcfg_fixture", "fixed-intent", path.join(root, "absent"))).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
