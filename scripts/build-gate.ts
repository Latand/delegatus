import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "dist/gate");
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, "scripts/gate-slot.sh"), path.join(output, "gate-slot.sh"));
for (const name of ["owned-runner", "cpu-admission", "test-child-guardian"]) {
  const result = await Bun.build({ entrypoints: [path.join(root, `scripts/${name}.ts`)], target: "bun", format: "esm", naming: `${name}.ts`, outdir: output });
  if (!result.success) throw new AggregateError(result.logs, `Could not bundle ${name}`);
}
console.log("Built namespace-aware gate tooling in dist/gate");
