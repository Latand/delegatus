import "./state/owner/tool";
import { createInterface } from "node:readline";
import { removeManagedCodexAccount } from "./accounts/codex";
import { removeManagedClaudeAccount } from "./accounts/claude";

console.log = (...values: unknown[]) => console.error(...values);
const input = createInterface({ input: process.stdin });
input.once("line", (line) => {
  let frame: unknown;
  try {
    const request = JSON.parse(line);
    if (!["codex", "claude"].includes(request.engine) || typeof request.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(request.id)) throw new Error("invalid account removal request");
    frame = { ok: true, result: request.engine === "codex" ? removeManagedCodexAccount(request.id) : removeManagedClaudeAccount(request.id) };
  } catch (error) {
    const detail = error as Error & Record<string, unknown>;
    frame = { error: { name: detail?.name ?? "Error", message: detail?.message ?? "account removal failed",
      ...Object.fromEntries(["blockers", "archive", "report", "code"].filter(key => detail?.[key] !== undefined).map(key => [key, detail[key]])) } };
  }
  input.close();
  process.stdout.write(JSON.stringify(frame) + "\n", () => process.exit(0));
});
