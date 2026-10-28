import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EnvironmentSetupReceipt } from "@/lib/pipelines/cloudEnvironmentClient";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_~-]{1,200}$/.test(value);
/** Called only after this account's own catalog proves the config's repository
 * and ref. Filename/display-name account guesses confer no authority. Retain
 * identifiers only; private scripts, payloads and tokens never leave this reader. */
export async function readCloudRunSetup(configId: string, intent: string,
  directory = path.join(os.homedir(), ".local/state/delegatus-cloud-run")): Promise<EnvironmentSetupReceipt | null> {
  let entries;
  try { entries = await fs.opendir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Cloud setup receipt directory is unreadable"); }
  const records: Record<string, unknown>[] = [];
  let count = 0;
  for await (const entry of entries) {
    if (++count > 512) throw new Error("Cloud setup receipt directory exceeds import bound");
    if (!entry.isFile() || !/\.json$/.test(entry.name) || !/(?:environment|draft|approval|approve)/.test(entry.name)) continue;
    if (records.length >= 64) throw new Error("Cloud setup receipt import exceeds record bound");
    const filename = path.join(directory, entry.name), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024) continue;
    try { const document = object(JSON.parse(await fs.readFile(filename, "utf8"))); records.push(object(document.result ?? document)); }
    catch { throw new Error("Cloud setup receipt is unreadable"); }
  }
  for (const record of records) {
    if (record.id !== configId) continue;
    const draft = object(record.draft);
    if (!identifier(draft.id) || !identifier(record.environment_id)) continue;
    const operation = records.find(r => r.environment_id === record.environment_id && identifier(r.id)
      && ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"].includes(String(r.state)));
    return { intent, configId, draftId: draft.id, environmentId: record.environment_id,
      ...(operation ? { operationId: String(operation.id) } : {}),
      ...(Number.isSafeInteger(draft.revision) && Number(draft.revision) >= 0 ? { draftRevision: Number(draft.revision) } : {}) };
  }
  return null;
}
