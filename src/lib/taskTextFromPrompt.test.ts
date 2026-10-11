import { expect, test } from "bun:test";

import { taskTextFromPrompt } from "./taskTextFromPrompt";

test("extracts request titles after injected context and spoken fillers", () => {
  const text = taskTextFromPrompt(
    "# AGENTS.md instructions\nnoise\n</INSTRUCTIONS><environment_context>x</environment_context>\n\nЯ бы хотел, чтобы ты э-э-э создал автоматизацию для Delegatus.",
  );
  expect(text).toBe("Создать автоматизацию для Delegatus");
});

test("keeps the first sentence and the existing title bound", () => {
  expect(taskTextFromPrompt("Could you implement the deploy retry. Then update the board.")).toBe("Implement the deploy retry");
  expect(taskTextFromPrompt("Please implement " + "a".repeat(120))).toHaveLength(96);
});

test("filters harness service prompts and conversational chatter", () => {
  for (const prompt of [
    "<system-reminder>Please implement a retry.</system-reminder>",
    "Caveat: please implement a retry.",
    "[Request interrupted by user]",
    "This came from another Claude session: create a retry.",
    "# AGENTS.md instructions: implement a retry.",
    "ok",
    "thanks, looks good",
  ]) expect(taskTextFromPrompt(prompt)).toBeNull();
});
