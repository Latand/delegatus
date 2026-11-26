import fs from "node:fs";
import path from "node:path";
import { RuntimeImageStore } from "../runtimeImageStore";
const [root, marker] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (path.basename(String(to)).startsWith(".writer-lock-retire.")) {
    fs.writeFileSync(marker!, fs.realpathSync(to));
    process.kill(process.pid, "SIGKILL");
  }
};
new RuntimeImageStore(root!, { now: () => 100_000, abandonedPartialMaxAgeMs: 1_000, writerLockStaleMs: 1 });
