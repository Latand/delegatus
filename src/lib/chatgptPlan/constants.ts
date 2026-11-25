export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT = "dynamic_agent_client";
/** Dynamic registration must be explicitly enabled by an installation owner. */
export const configuredClientId = () => process.env.LLV_CHATGPT_PLAN_CLIENT_ID?.trim() || undefined;
export const planConfigured = () => !!configuredClientId();
export const credentialStorageSupported = (platform = process.platform) => platform !== "win32";
export const CALLBACK = "/auth/callback";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const clientIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) && value !== DYNAMIC_CLIENT;

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function boundedJson(response: Response, limit = 64 * 1024, strictRead = false): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) return undefined;
      chunks.push(value);
    }
  } catch (error) {
    if (strictRead) throw error;
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return undefined; }
}
