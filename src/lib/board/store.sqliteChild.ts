import fs from "node:fs";

import { boardFor, importLegacyBoard, mutateBoard, setBoardWriteHookForTests } from "./store";

const [mode, filePath, arg, gate] = process.argv.slice(2);
if (!mode || !filePath) throw new Error("board store child arguments are required");

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(2);
}

if (mode === "import") {
  if (gate) waitFor(gate);
  const outcome = importLegacyBoard(filePath, { reconcile: true });
  console.log(JSON.stringify({ state: outcome.state, digest: outcome.record.rowDigest, rows: outcome.record.rowCount }));
} else if (mode === "restore") {
  // Each pass adds one path to this process's own project, so two children
  // that interleave must both land every one of their writes.
  if (gate) waitFor(gate);
  const project = `proj-${process.pid}`;
  for (let index = 0; index < Number(arg); index += 1) {
    const board = boardFor(project, filePath);
    const written = mutateBoard(project, board.revision, [{ kind: "restore", path: `/p-${index}`, placement: "manual" }], filePath);
    if (!written.ok) throw new Error(`board write refused at ${index}`);
  }
  console.log(JSON.stringify({ manual: boardFor(project, filePath).prefs.manual.length }));
} else if (mode === "hold-mutate") {
  // Killed with SIGKILL while holding the collection lease mid-write.
  const revision = boardFor("repo", filePath).revision;
  setBoardWriteHookForTests((phase) => {
    if (phase !== "in-lease") return;
    fs.writeFileSync(arg!, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  });
  mutateBoard("repo", revision, [{ kind: "restore", path: "/never-committed", placement: "manual" }], filePath);
} else if (mode === "hold-import") {
  // Killed with SIGKILL inside the import's BEGIN IMMEDIATE transaction.
  importLegacyBoard(filePath, {
    reconcile: true,
    hooks: {
      beforeVerify: () => {
        fs.writeFileSync(arg!, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      },
    },
  });
} else {
  throw new Error(`unknown board store child mode: ${mode}`);
}
