export {};
if (process.env.LLV_CLOUD_PATCH_RESTART !== "1") throw new Error("test probe only");
const fs = await import("node:fs/promises");
const { applyCloudPatch } = await import("../cloudStagePatch");
const { realExec } = await import("@/lib/workflows/provision");
const file = process.argv[2]!;
const input = JSON.parse(await fs.readFile(file, "utf8"));
let applications = 0;
await applyCloudPatch(input.directory, input.patch, input.head, input.cwd, (command, args, ...rest) => {
  if (args[0] === "apply") applications++;
  return realExec(command, args, ...rest);
}, () => {}, async () => { await fs.writeFile(file, JSON.stringify(input)); });
process.stdout.write(JSON.stringify({ patch: input.patch, applications }));
