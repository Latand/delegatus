import { expect, test } from "bun:test";

import { engineConnectedFrom, engineNotConnectedMessage, probeCli } from "./engineConnection";

test("an engine is connected when an account holds credentials inside the project's allowed set", () => {
  expect(engineConnectedFrom([], null)).toBe(false);
  expect(engineConnectedFrom([{ id: "a", authPresent: false }], null)).toBe(false);
  expect(engineConnectedFrom([{ id: "a", authPresent: true }], null)).toBe(true);
  /* A credential store that could not be read cannot prove absence. */
  expect(engineConnectedFrom([{ id: "a", authPresent: false, credentialState: "unknown" }], null)).toBe(true);
  expect(engineConnectedFrom([{ id: "a", authPresent: true }], ["b"])).toBe(false);
  expect(engineConnectedFrom([{ id: "a", authPresent: true }, { id: "b", authPresent: true }], ["b"])).toBe(true);
});

test("the refusal names the stage, the engine and the three ways out", () => {
  expect(engineNotConnectedMessage({ stageId: "review", role: "reviewer", engine: "codex" })).toBe(
    'Stage "review" runs on Codex, and no Codex account is signed in on this machine. Connect Codex (menu → Accounts), or point the reviewer role at another engine (menu → Agent mapping), or set engine and model on this stage.',
  );
  expect(engineNotConnectedMessage({ role: "builder", engine: "claude" })).toBe(
    "This launch runs on Claude, and no Claude account is signed in on this machine. Connect Claude (menu → Accounts), or point the builder role at another engine (menu → Agent mapping), or set engine and model on this launch.",
  );
});

test("a command the OS cannot start is missing; one that runs is found", async () => {
  expect(await probeCli("/nonexistent/llv-probe-binary")).toBe("missing");
  expect(await probeCli(process.execPath)).toBe("found");
});
