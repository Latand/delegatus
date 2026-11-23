const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const recipientValid = (value: unknown): boolean => record(value) && identifier(value.project) && identifier(value.conversationId)
  && Number.isSafeInteger(value.seatEpoch) && (value.seatEpoch as number) >= 0 && ["claude", "codex"].includes(value.engine as string);
/** Exported for the install transfer, which admits only sessions this reader accepts. */
export function sessionValid(key: string, session: unknown): boolean {
  if (!record(session) || session.id !== key || !identifier(key) || !identifier(session.project)
    || !["en", "uk"].includes(session.locale as string) || typeof session.closed !== "boolean"
    || !Number.isSafeInteger(session.generation) || (session.generation as number) < 1 || !Number.isFinite(session.createdAt)
    || !Number.isSafeInteger(session.seq) || (session.seq as number) < 0 || !Array.isArray(session.inputs)
    || !Array.isArray(session.events) || session.events.length > 512 || !record(session.proposals)) return false;
  if (session.authority !== undefined && session.authority !== "live-model") return false;
  if (session.backend !== undefined && session.backend !== "codex") return false;
  const window = (row: unknown) => row === null || (record(row) && typeof row.usedPercent === "number" && row.usedPercent >= 0 && row.usedPercent <= 100
    && (row.resetsAt === null || Number.isSafeInteger(row.resetsAt)) && (row.windowMinutes === null || Number.isSafeInteger(row.windowMinutes)));
  if (record(session.usage) && ((session.usage.startedAt !== undefined && !Number.isFinite(session.usage.startedAt))
    || (session.usage.planStart !== undefined && (typeof session.usage.planStart !== "number" || session.usage.planStart < 0 || session.usage.planStart > 100))
    || (session.usage.plan !== undefined && (!record(session.usage.plan) || !(session.usage.plan.type === null || identifier(session.usage.plan.type))
      || !window(session.usage.plan.primary) || !window(session.usage.plan.secondary) || typeof session.usage.plan.limitReached !== "boolean"
      || !Number.isFinite(session.usage.plan.observedAt))))) return false;
  if (record(session.usage) && session.usage.codexTokens !== undefined && (!record(session.usage.codexTokens)
    || Object.values(session.usage.codexTokens).some(n => !Number.isSafeInteger(n) || (n as number) < 0))) return false;
  if (session.currentProject !== undefined && session.currentProject !== null && !identifier(session.currentProject)) return false;
  if (session.startedBy !== undefined && (!record(session.startedBy)
    || !(Object.keys(session.startedBy).length === 1 && (identifier(session.startedBy.memberId) || session.startedBy.operator === true)))) return false;
  if (session.endedAt !== undefined && !Number.isFinite(session.endedAt)) return false;
  if (session.reportWatermarks !== undefined && (!record(session.reportWatermarks)
    || Object.entries(session.reportWatermarks).some(([project, seq]) => !identifier(project) || !Number.isSafeInteger(seq) || (seq as number) < 0))) return false;
  if (session.spokenReports !== undefined && (!Array.isArray(session.spokenReports) || session.spokenReports.length > 256 || !session.spokenReports.every(identifier))) return false;
  if (session.providerId !== undefined && !identifier(session.providerId)) return false;
  if (session.remoteOpen !== undefined && typeof session.remoteOpen !== "boolean") return false;
  if (session.mintUncertain !== undefined && typeof session.mintUncertain !== "boolean") return false;
  if (session.owner !== undefined && (!record(session.owner) || !Number.isSafeInteger(session.owner.pid) || !identifier(session.owner.instance))) return false;
  if (session.mintRequestId !== undefined && !identifier(session.mintRequestId)) return false;
  if (session.mintDigest !== undefined && (typeof session.mintDigest !== "string" || !/^[a-f0-9]{64}$/.test(session.mintDigest))) return false;
  if (session.answerSdp !== undefined && (typeof session.answerSdp !== "string" || session.answerSdp.length > 96_000)) return false;
  if (session.usage !== undefined && (!record(session.usage) || typeof session.usage.seconds !== "number" || !Number.isFinite(session.usage.seconds)
    || session.usage.seconds < 0 || !record(session.usage.responses) || Object.values(session.usage.responses).some(row => !record(row)
      || typeof row.complete !== "boolean" || (row.responseId !== undefined && !identifier(row.responseId))
      || (row.tokens !== undefined && (!record(row.tokens) || ![row.tokens.input, row.tokens.cached, row.tokens.cacheWrite, row.tokens.output].every(n => Number.isSafeInteger(n) && (n as number) >= 0)
        || (row.tokens.cached as number) + (row.tokens.cacheWrite as number) > (row.tokens.input as number)))
      || (row.usd !== null && (typeof row.usd !== "number" || !Number.isFinite(row.usd) || row.usd < 0))))) return false;
  if (session.inputs.some(input => !record(input) || !identifier(input.itemId) || typeof input.text !== "string" || typeof input.final !== "boolean"
    || (input.turn !== undefined && (!Number.isSafeInteger(input.turn) || (input.turn as number) < 0)))) return false;
  if (session.events.some(event => !record(event) || event.sessionId !== key || event.version !== 1 || !identifier(event.eventId)
    || !identifier(event.type) || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.generation) || !Number.isFinite(event.atMs))) return false;
  return Object.entries(session.proposals).every(([id, held]) => {
    if (!record(held) || !record(held.proposal) || (held.proposal.authority !== undefined && held.proposal.authority !== "live-model") || held.proposal.proposalId !== id || !identifier(id)
      || !identifier(held.proposal.callId) || !identifier(held.proposal.sourceItemId) || typeof held.proposal.instruction !== "string"
      || !recipientValid(held.proposal.recipient)
      || typeof held.sourceText !== "string" || !Number.isFinite(held.expiresAt) || !["pending", "cancelled", "admitted"].includes(held.state as string)
      || !Array.isArray(held.reports) || !held.reports.every(identifier)
      || (held.answered !== undefined && (!identifier(held.answered) || !held.reports.includes(held.answered)))
      || (held.renewed !== undefined && typeof held.renewed !== "boolean")
      || (held.retargetCount !== undefined && (!Number.isSafeInteger(held.retargetCount) || (held.retargetCount as number) < 0 || (held.retargetCount as number) > 1))
      || (held.publishedReceipt !== undefined && (!record(held.publishedReceipt)
        || !identifier(held.publishedReceipt.clientMessageId) || !identifier(held.publishedReceipt.operationId)))
      || (held.sourceTurn !== undefined && (!Number.isSafeInteger(held.sourceTurn) || (held.sourceTurn as number) < 0))) return false;
    if (held.state !== "admitted") return held.delivery === undefined && held.text === undefined && held.status === undefined;
    return record(held.delivery) && held.delivery.proposalId === id && held.delivery.callId === held.proposal.callId
      && identifier(held.delivery.clientMessageId) && (held.delivery.operationId === null || identifier(held.delivery.operationId))
      && recipientValid(held.delivery.recipient) && JSON.stringify(held.delivery.recipient) === JSON.stringify(held.proposal.recipient)
      && typeof held.text === "string" && (held.status === undefined || ["delivered", "queued", "unknown", "failed"].includes(held.status as string));
  });
}
