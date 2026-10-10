/** The speech surface keeps MCP filter names and narrows its answer budgets. */
export interface ToolProperty {
  type: string | readonly string[];
  description?: string;
  minLength?: number;
  maxLength?: number;
  enum?: readonly (string | null)[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: ToolProperty;
}
const optionalText = (maxLength: number): ToolProperty => ({ type: ["string", "null"], maxLength });
const optionalSet = (values?: readonly string[]): ToolProperty => ({ type: ["array", "null"], maxItems: 20,
  items: { type: "string", minLength: 1, maxLength: 128, ...(values ? { enum: values } : {}) } });
const limit: ToolProperty = { type: ["integer", "null"], minimum: 1, maximum: 10 };
const cursor = optionalText(3000);
const project = { ...optionalText(200), description: "Project name or handle; null uses the project currently in view. Ambiguous names are refused." };
const handle: ToolProperty = { type: "string", minLength: 1, maxLength: 128 };
const messages = { roles: optionalSet(["user", "assistant"]), since: optionalText(40), cursor, limit };
export const READ_SCHEMAS: Record<string, Record<string, ToolProperty>> = {
  list_tasks: { project, statuses: optionalSet(["inbox", "assigned", "blocked", "done"]), openOnly: { type: ["boolean", "null"] },
    query: optionalText(120), ids: optionalSet(), cursor, limit },
  get_task: { project, taskId: handle },
  list_pipelines: { project, state: optionalSet(["open", "draft", "provisioning", "running", "paused", "needs_decision", "needs_review", "completed", "closed"]), includeClosed: { type: ["boolean", "null"], description: "Set true to include closed history, including when state contains closed." }, ids: optionalSet(), query: optionalText(120), cursor, limit },
  get_pipeline: { project, pipelineId: handle, stageId: optionalText(128) },
  agent_activity: { project, liveOnly: { type: ["boolean", "null"] }, conversationId: optionalText(128), cursor, limit },
  conversation_messages: { project, conversationId: handle, ...messages },
  orchestrator_messages: { project, ...messages },
  search_transcripts: { project, query: { type: "string", minLength: 1, maxLength: 200 }, order: { type: ["string", "null"], enum: ["relevance", "newest", null] }, cursor },
  read_prototype_review: { project, taskId: handle },
  view_prototype_frame: { project, taskId: handle, reviewId: handle, mediaId: handle },
};
for (const schema of Object.values(READ_SCHEMAS)) schema.refresh = {
  type: ["boolean", "null"],
  description: "Set true only when the operator explicitly asks for a fresh observation. Null or false reuses recent identical reads; repeated refreshes in the same delegation reuse its fresh observation.",
};
export function validToolValue(property: ToolProperty, value: unknown): boolean {
  const types = typeof property.type === "string" ? [property.type] : property.type;
  if (value === undefined || value === null) return types.includes("null");
  if (typeof value === "string" && types.includes("string")) return value.trim().length >= (property.minLength ?? 0)
    && value.length <= (property.maxLength ?? 2000) && (!property.enum || property.enum.includes(value));
  if (typeof value === "boolean") return types.includes("boolean");
  if (typeof value === "number") return types.includes("integer") && Number.isSafeInteger(value)
    && value >= (property.minimum ?? 0) && value <= (property.maximum ?? Number.MAX_SAFE_INTEGER);
  return Array.isArray(value) && types.includes("array") && value.length <= (property.maxItems ?? 20)
    && !!property.items && value.every(item => validToolValue(property.items!, item));
}
