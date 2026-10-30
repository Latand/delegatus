import "./state/owner/tool";
import { createInterface } from "node:readline";
import { recoverInterruptedCodexAccountRemovals, removeManagedCodexAccount } from "./accounts/codex";
import { removeManagedClaudeAccount } from "./accounts/claude";

console.log = (...values: unknown[]) => console.error(...values);
const input = createInterface({ input: process.stdin });
input.once("line", async (line) => {
  let frame: unknown;
  try {
    const request = JSON.parse(line);
    if (!["codex", "claude"].includes(request.engine) || typeof request.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.id)) throw new Error("invalid account removal request");
    const result = request.engine === "codex" ? removeManagedCodexAccount(request.id) : removeManagedClaudeAccount(request.id);
    // A competing catalog writer can defer the final journal clear after the
    // archive is complete. Retry only this committed removal, off the web loop.
    if (request.engine === "codex" && result.cleanupPending) {
      for (const delay of [50, 200, 750]) {
        await new Promise(resolve => setTimeout(resolve, delay));
        try {
          if (recoverInterruptedCodexAccountRemovals(request.id).recovered.includes(request.id)) {
            result.cleanupPending = false;
            break;
          }
        } catch { /* The durable journal and cleanupPending retain the refusal. */ }
      }
    }
    frame = { ok: true, result };
  } catch (error) {
    const detail = error as Error & Record<string, unknown>;
    frame = { error: { name: detail?.name ?? "Error", message: detail?.message ?? "account removal failed",
      ...Object.fromEntries(["blockers", "archive", "report", "code"].filter(key => detail?.[key] !== undefined).map(key => [key, detail[key]])) } };
  }
  input.close();
  process.stdout.write(JSON.stringify(frame) + "\n", () => process.exit(0));
});
