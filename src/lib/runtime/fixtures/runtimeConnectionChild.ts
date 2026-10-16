import { UnixRuntimeHostClient } from "../client";
const endpoint = process.argv[2];
if (!endpoint) throw new Error("fixture requires its owned endpoint");
for (let index = 0; index < 12; index++) {
  if (await new UnixRuntimeHostClient(endpoint).filesRevision() !== 7) throw new Error("wrong fixture answer");
}
process.stdout.write("completed\n");
