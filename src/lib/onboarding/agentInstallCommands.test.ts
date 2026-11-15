import { expect, test } from "bun:test";

import { agentStartupMessage } from "../../../bin/agent-binaries.mjs";
import { AGENT_INSTALL_COMMANDS } from "./agentInstallCommands";

/* The Engines step and `delegatus start` offer one set of commands. With no
   agent CLI found on the machine the start message names each of them. */
const NONE_FOUND = { home: "/nonexistent-home", envPath: "/nonexistent-bin", includeSystem: false };

for (const lang of ["en", "uk"] as const) {
  test(`${lang}: every install command the step shows is in the message the terminal prints`, () => {
    const message = agentStartupMessage(lang, NONE_FOUND);
    for (const { command } of Object.values(AGENT_INSTALL_COMMANDS)) expect(message).toContain(command);
  });
}

test("a command's break points join back to the exact command that is copied", () => {
  for (const { command, segments } of Object.values(AGENT_INSTALL_COMMANDS)) {
    expect(segments.join("")).toBe(command);
    /* Breaks only after the flags and after slashes: https:// and the pipe stay whole. */
    for (const segment of segments.slice(0, -1)) expect(segment.endsWith("/") || segment.endsWith("-fsSL ")).toBe(true);
    expect(segments.some((segment) => segment.includes("https://"))).toBe(true);
    expect(segments.at(-1)).toMatch(/^install\.sh \| (bash|sh)$/);
  }
});
