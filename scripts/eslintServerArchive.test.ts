import { expect, test } from "bun:test";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });
const source = "@/lib/pipelines/store";
const forbidden = [
  'import { loadArchivedPipelines as read } from "../pipelines/store"; read();',
  `const store = await import("${source}"); const read = store["loadArchivedPipelines"]; read();`,
  `import { loadArchivedPipelines as read } from "${source}"; read();`,
  `const { loadArchivedPipelines: read } = await import("${source}"); read();`,
  `import * as store from "${source}"; store.loadArchivedPipelines();`,
];
test("server lint refuses mutable archive imports and dynamic copies while maintenance remains allowed", async () => {
  for (const filePath of ["src/lib/done/world.ts", "src/app/api/done/route.ts", "src/runtime-host/fixture.ts"]) {
    for (const code of forbidden) {
      const [result] = await eslint.lintText(code, { filePath });
      expect(result!.messages.some(m => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")).toBe(true);
    }
    const [allowed] = await eslint.lintText(`import { loadArchivedPipelinesForList as read } from "${source}"; read();`, { filePath });
    expect(allowed!.messages.filter(m => m.ruleId?.startsWith("no-restricted"))).toEqual([]);
  }
  for (const filePath of ["src/lib/pipelines/worktreeSweep.ts", "src/lib/pipelines/store.reads.test.ts"]) {
    const [allowed] = await eslint.lintText(forbidden[0]!, { filePath });
    expect(allowed!.messages.filter(m => m.ruleId?.startsWith("no-restricted"))).toEqual([]);
  }
});
