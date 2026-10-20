import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCP_TOOL_NAMES,
  FileMcpReceiptStore,
  SqliteMcpReceiptStore,
  createMcpToolService,
  type McpRecoveryReceiptStore,
  type McpToolBindings,
} from "./server";

const scratch: string[] = [];
const stores: SqliteMcpReceiptStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

for (const adapter of ["file", "sqlite"] as const) {
  for (const fault of ["before-write", "after-write"] as const) {
    test(`${adapter} dispatch-marker ${fault} releases only the undispatched request for same-key retry`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-review-dispatch-failure-"));
      scratch.push(directory);
      const filename = path.join(directory, `receipts.${adapter === "file" ? "json" : "sqlite"}`);
      const store = adapter === "file" ? new FileMcpReceiptStore(filename) : new SqliteMcpReceiptStore(filename);
      if (store instanceof SqliteMcpReceiptStore) stores.push(store);
      const recoveryStore = store as McpRecoveryReceiptStore;
      const mark = recoveryStore.markDispatching.bind(recoveryStore);
      let faulted = false;
      recoveryStore.markDispatching = async (key, digest) => {
        if (faulted) return await mark(key, digest);
        faulted = true;
        if (fault === "before-write") throw new Error("injected pre-write refusal");
        await mark(key, digest);
        throw new Error("injected commit-then-lost-ack");
      };

      let effects = 0;
      const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
      bindings.update_task = async () => ({ task: { id: "task_fixture" }, effect: ++effects });
      const service = createMcpToolService(bindings, recoveryStore);
      const args = { clientRequestId: `${adapter}-${fault}`, taskId: "task_fixture", updates: { title: "changed" } };

      expect(await service.callTool("update_task", args)).toMatchObject({
        ok: false,
        code: "not_executed",
        retryable: true,
        replayed: false,
        details: { outcome: "not-executed", nextAction: "retry-same-key" },
      });
      expect(effects).toBe(0);
      expect(await recoveryStore.lookup(`update_task:${args.clientRequestId}`)).toBeNull();

      expect(await service.callTool("update_task", args)).toMatchObject({ ok: true, effect: 1, replayed: false });
      expect(effects).toBe(1);
      expect(await service.callTool("update_task", args)).toMatchObject({ ok: true, effect: 1, replayed: true });
      expect(effects).toBe(1);
    });
  }
}
