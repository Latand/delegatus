/** Portable runners retain identity-safe cleanup, with an explicit discovery
 * limit. The inherited marker keeps nested runners from repeating the warning.
 */
export function admitPortableTestRunner(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.error,
): void {
  if (platform === "linux") throw new Error("owned gates on Linux require a reachable user systemd manager");
  if (env.LLV_PORTABLE_TEST_WARNING_SHOWN === "1") return;
  warn("owned test runner: portable cleanup is best effort; a detached descendant can escape between guardian polls");
  env.LLV_PORTABLE_TEST_WARNING_SHOWN = "1";
}
