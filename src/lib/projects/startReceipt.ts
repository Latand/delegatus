import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { receiptKey, requestDigest } from "@/lib/mcp/receiptIdentity";
import { projectStartCheckpoint } from "./startContract";

/** Native consumers read one original operation from the serving Viewer's
 * receipt database. This read handle never prepares or migrates the schema. */
export function readProjectStartLink(operationId: string) {
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) return null;
  const db = new sqlite.Database(statePath("mcp-receipts.sqlite"), { readonly: true, strict: true });
  try {
    const rows = db.query<{ receipt_key: string; digest: string; binding_json: string }, [string]>(`
      SELECT receipt_key, digest, binding_json FROM mcp_receipts WHERE receipt_key GLOB 'start_project@*'
        AND json_extract(binding_json, '$.projectStart.operationId') = ?
      LIMIT 2
    `).all(operationId);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    const value: unknown = JSON.parse(row.binding_json);
    if (typeof value !== "object" || !value || Reflect.get(value, "toolName") !== "start_project"
      || Reflect.get(value, "version") !== 1) return null;
    const claimGeneration: unknown = Reflect.get(value, "claimGeneration");
    const checkpoint = projectStartCheckpoint.safeParse(Reflect.get(value, "projectStart"));
    if (typeof claimGeneration !== "string" || !claimGeneration || !checkpoint.success) return null;
    const { input, source } = checkpoint.data;
    const key = receiptKey("start_project", input.clientRequestId, source.conversationId);
    if (row.receipt_key !== key || requestDigest("start_project", input) !== row.digest
      || createHash("sha256").update(key).digest("hex") !== operationId
      || checkpoint.data.operationId !== operationId || Reflect.get(value, "downstreamKey") !== operationId
      || Reflect.get(value, "clientRequestId") !== input.clientRequestId) return null;
    return { claimGeneration, checkpoint: checkpoint.data };
  } finally { db.close(); }
}
