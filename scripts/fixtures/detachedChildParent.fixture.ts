import { spawn } from "node:child_process";
import fs from "node:fs";
import { captureProcessIdentity } from "../../src/lib/processIdentity";

const child = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.LLV_DETACHED_CHILD_RECORD!, JSON.stringify(captureProcessIdentity(child.pid!)));
child.unref();
process.exit(0);
