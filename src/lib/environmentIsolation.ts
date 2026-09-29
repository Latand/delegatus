/* Only credentials used by first-party services or configured engine providers
 * may cross a process boundary by ambient inheritance. Other API keys stay in
 * the operator's shell instead of reaching managed children. */
const FORWARDED_API_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "SONIOX_API_KEY",
]);

export function unsupportedApiCredentialNames(base: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(base).filter((key) => key.endsWith("_API_KEY") && !FORWARDED_API_KEYS.has(key));
}

export function discardUnsupportedApiCredentials(
  environment: Record<string, string | undefined> = process.env,
): void {
  for (const key of unsupportedApiCredentialNames(environment)) delete environment[key];
}

export function withoutUnsupportedApiCredentials(
  base: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of Object.keys(base)) {
    if (key.endsWith("_API_KEY") && !FORWARDED_API_KEYS.has(key)) continue;
    env[key] = base[key];
  }
  return env;
}

export function withoutUnsupportedApiCredentialEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => {
    const key = entry.split("=", 1)[0]!;
    return !key.endsWith("_API_KEY") || FORWARDED_API_KEYS.has(key);
  });
}
