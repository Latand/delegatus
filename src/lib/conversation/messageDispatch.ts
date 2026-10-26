/** Select a transport only after the caller has admitted and prepared the send.
 * Every non-null structured answer owns the send, including refusal or
 * uncertainty. Exceptions propagate: neither case authorizes a second send.
 * Ports retain their caller's authority checks and response interpretation. */
export async function dispatchConversationMessage<StructuredRequest, LegacyRequest, StructuredResult, LegacyResult>(
  structuredRequest: StructuredRequest,
  legacyRequest: LegacyRequest,
  ports: {
    structured(request: StructuredRequest): Promise<StructuredResult | null>;
    legacy(request: LegacyRequest): Promise<LegacyResult>;
  },
): Promise<{ transport: "structured"; result: StructuredResult } | { transport: "legacy"; result: LegacyResult }> {
  const result = await ports.structured(structuredRequest);
  if (result !== null) return { transport: "structured", result };
  return { transport: "legacy", result: await ports.legacy(legacyRequest) };
}
