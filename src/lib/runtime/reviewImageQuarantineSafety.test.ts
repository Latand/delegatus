import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { RuntimeImageStore } from "./runtimeImageStore";

for (const procSelfFdPaths of [true, false]) {
  for (const replacement of ["outside-symlink", "live-owner"] as const) {
    test(`quarantine deletion preserves ${replacement} after its final contents read (proc=${procSelfFdPaths})`, () => {
      const area = fs.mkdtempSync(path.join(os.tmpdir(), "quarantine-safety-"));
      const root = path.join(area, "images");
      const outside = path.join(area, "outside");
      fs.mkdirSync(root, { mode: 0o700 });
      fs.mkdirSync(outside, { mode: 0o700 });
      const token = "00000000-0000-0000-0000-000000000000";
      const staging = path.join(root, `.writer-lock-gate.${token}.partial`);
      fs.mkdirSync(staging, { mode: 0o700 });
      fs.writeFileSync(path.join(staging, "owner.json"), JSON.stringify({ pid: 2_147_483_647, startIdentity: null, token }));
      fs.utimesSync(staging, new Date(1_000), new Date(1_000));
      const sentinel = path.join(outside, "owner.json");
      fs.writeFileSync(sentinel, "outside sentinel");
      const original = fs.readdirSync;
      let swapped = false;
      let target = "";
      fs.readdirSync = new Proxy(original, {
        apply(fn, receiver, args) {
          const contents = Reflect.apply(fn, receiver, args);
          const candidate = String(args[0]);
          if (!swapped && path.basename(candidate).startsWith(".writer-lock-retire.")) {
            target = path.join(root, path.basename(candidate));
            fs.renameSync(candidate, path.join(root, ".displaced-quarantine"));
            if (replacement === "outside-symlink") fs.symlinkSync(outside, target);
            else {
              fs.mkdirSync(target, { mode: 0o700 });
              fs.writeFileSync(path.join(target, "owner.json"), JSON.stringify({ pid: process.pid, startIdentity: null, token }));
            }
            swapped = true;
          }
          return contents;
        },
      });
      try {
        new RuntimeImageStore(root, { procSelfFdPaths, now: () => 10_000, abandonedPartialMaxAgeMs: 1_000 });
      } finally { fs.readdirSync = original; }
      const outsideSurvives = fs.existsSync(sentinel);
      const liveSurvives = replacement !== "live-owner" || !swapped || fs.existsSync(path.join(target, "owner.json"));
      console.log(JSON.stringify({ procSelfFdPaths, replacement, swapped, outsideSurvives, liveSurvives }));
      expect(outsideSurvives).toBe(true);
      expect(liveSurvives).toBe(true);
    });
  }
}
