import { expect, test } from "bun:test";

import { agentStartupMessage } from "../../../bin/agent-binaries.mjs";
import { AGENT_INSTALL_COMMANDS, AGENT_INSTALL_COMMANDS_POWERSHELL, ANTIGRAVITY_INSTALL_COMMAND, agentInstallCommand, hostPlatformOf } from "./agentInstallCommands";

/* The Accounts step and `delegatus start` offer one set of commands. With no
   agent CLI found on the machine the start message names each of them. */
const NONE_FOUND = { home: "/nonexistent-home", envPath: "/nonexistent-bin", includeSystem: false };

for (const lang of ["en", "uk"] as const) {
  test(`${lang}: every install command the step shows is in the message the terminal prints`, () => {
    const message = agentStartupMessage(lang, NONE_FOUND);
    for (const { command } of Object.values(AGENT_INSTALL_COMMANDS)) expect(message).toContain(command);
  });
}

test("a command's break points join back to the exact command that is copied", () => {
  for (const { command, segments } of [...Object.values(AGENT_INSTALL_COMMANDS), ANTIGRAVITY_INSTALL_COMMAND]) {
    expect(segments.join("")).toBe(command);
    /* Breaks only after the flags and after slashes: https:// and the pipe stay whole. */
    for (const segment of segments.slice(0, -1)) expect(segment.endsWith("/") || segment.endsWith("-fsSL ")).toBe(true);
    expect(segments.some((segment) => segment.includes("https://"))).toBe(true);
    expect(segments.at(-1)).toMatch(/^install\.sh \| (bash|sh)$/);
  }
});

test("a PowerShell line's break points join back to the command, and break only after the verb and after slashes", () => {
  for (const { command, segments } of Object.values(AGENT_INSTALL_COMMANDS_POWERSHELL)) {
    expect(segments.join("")).toBe(command);
    for (const segment of segments.slice(0, -1)) expect(segment.endsWith("/") || segment === "irm ").toBe(true);
    expect(segments.some((segment) => segment.includes("https://"))).toBe(true);
    expect(segments.at(-1)).toBe("install.ps1 | iex");
  }
});

test("a row shows the shell line everywhere except on Windows, where it shows the PowerShell line", () => {
  for (const engine of ["claude", "codex", "antigravity"] as const) {
    const shell = engine === "antigravity" ? ANTIGRAVITY_INSTALL_COMMAND : AGENT_INSTALL_COMMANDS[engine];
    expect(agentInstallCommand(engine, "linux")).toBe(shell);
    expect(agentInstallCommand(engine, "darwin")).toBe(shell);
    expect(agentInstallCommand(engine, "win32")).toBe(AGENT_INSTALL_COMMANDS_POWERSHELL[engine]);
  }
});

test("an unknown or absent host system reads as Linux", () => {
  expect(hostPlatformOf("win32")).toBe("win32");
  expect(hostPlatformOf("darwin")).toBe("darwin");
  for (const value of ["linux", "freebsd", undefined, null, 7]) expect(hostPlatformOf(value)).toBe("linux");
});
