import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourceExtension = /\.(?:[cm]?[jt]sx?|py|sh|ps1|css|scss|sql|html)$/;

/** Inspect bytes before decoding: Git can classify a source with NUL as binary. */
export function sourceNuls(root: string): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return tracked.split("\0").filter((file) => file && sourceExtension.test(file)
    && readFileSync(join(root, file)).includes(0));
}

if (import.meta.main) {
  const files = sourceNuls(process.cwd());
  if (files.length) {
    console.error(`NUL bytes in tracked sources:\n${files.join("\n")}`);
    process.exitCode = 1;
  } else console.log("Tracked sources contain no NUL bytes.");
}
