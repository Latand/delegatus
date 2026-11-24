import { boundedJson, object, RESOURCE } from "./constants";
import { PlanError, responseError } from "./errors";
import { modelSlug } from "./store";

export const unsupportedFields = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
  "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs",
  "top_p", "truncation", "user", "previous_response_id", "service_tier",
] as const;
const STREAM_LIMIT = 4 * 1024 * 1024;

export function validatePlanRequest(body: Record<string, unknown>): void {
  if (unsupportedFields.some(field => Object.hasOwn(body, field))
    || !Array.isArray(body.input) || body.input.some(item => object(item)?.role === "system")) throw new PlanError("request_invalid");
}

export async function streamPlanResponse(http: typeof fetch, accessToken: string, body: Record<string, unknown>,
  signal: AbortSignal, onDelta?: (text: string) => void): Promise<Record<string, unknown>> {
  validatePlanRequest(body);
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await http(`${RESOURCE}/responses`, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...body, store: false, stream: true }),
    });
  } catch { throw new PlanError("interrupted"); }
  const requestId = response.headers.get("x-request-id");
  if (!response.ok) throw responseError(response.status, await boundedJson(response), requestId, accessToken);
  const reader = response.body?.getReader();
  if (!reader) throw new PlanError("interrupted");
  const decoder = new TextDecoder();
  let partial: string[] = [], data: string[] = [], size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > STREAM_LIMIT) throw new PlanError("interrupted");
      const lines = decoder.decode(value, { stream: true }).split("\n");
      const remainder = lines.pop()!;
      for (const fragment of lines) {
        partial.push(fragment);
        const line = partial.join("").replace(/\r$/, "");
        partial = [];
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        if (line || !data.length) continue;
        const frame = data.join("\n");
        data = [];
        if (frame === "[DONE]") throw new PlanError("interrupted");
        const event = object(JSON.parse(frame));
        const result = object(event?.response);
        if (event?.type === "response.completed" && result) {
          if (frame.includes(accessToken)) throw new PlanError("interrupted");
          return result;
        }
        if (event?.type === "response.failed" || event?.type === "error") throw responseError(response.status, result ?? event, requestId, accessToken);
        if (event?.type === "response.incomplete") throw new PlanError("interrupted");
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string" && !event.delta.includes(accessToken)) onDelta?.(event.delta);
      }
      if (remainder) partial.push(remainder);
    }
    throw new PlanError("interrupted");
  } catch (error) {
    throw error instanceof PlanError ? error : new PlanError("interrupted");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function listPlanModels(http: typeof fetch, accessToken: string, signal: AbortSignal): Promise<string[]> {
  let response: Response;
  try {
    response = await http(`${RESOURCE}/models`, { redirect: "error", signal, headers: { authorization: `Bearer ${accessToken}` } });
  } catch { throw new PlanError("retry_later"); }
  const body = await boundedJson(response, 512 * 1024);
  if (!response.ok) throw responseError(response.status, body, response.headers.get("x-request-id"), accessToken);
  const models = object(body)?.models;
  if (!Array.isArray(models)) throw new PlanError("retry_later");
  return [...new Set(models.map(object).filter(row => row?.visibility === "list").map(row => row?.slug).filter(modelSlug))].slice(0, 200);
}
