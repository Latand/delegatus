/**
 * Startup diagnostics (#2168): the progress and probe lines an operator reads
 * when a start misbehaves — structured-host startup phases, the identity-wave
 * migration summary, limits probes that found no CLI or no login.
 *
 * `bin/cli.mjs` sets `LLV_QUIET_DIAGNOSTICS=1` for children of an interactive
 * terminal launch unless `DELEGATUS_DEBUG=1` asks for diagnostics. Journal and
 * non-TTY launches clear that choice. Other entry points (`bun dev`, Docker)
 * print diagnostics by default. Loop-gap and performance-summary evidence
 * always bypasses quiet mode. Errors never go through here.
 */
export const QUIET_DIAGNOSTICS_ENV = "LLV_QUIET_DIAGNOSTICS";

export function startupDiagnosticsQuiet(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[QUIET_DIAGNOSTICS_ENV] === "1";
}

export function startupDiagnostic(level: "info" | "warn" | "error", ...args: unknown[]): void {
  if (startupDiagnosticsQuiet()) return;
  console[level](...args);
}
