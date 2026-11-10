import { expect, test } from "bun:test";

import { createFailedLegacyBufferProjection } from "./fixtures/failedLegacyBufferProjection";
import { hasStructuredDeliveryHost } from "./structuredDeliveryController";

test("a stored pane-host row retains one live running runtime verdict", async () => {
  const fixture = await createFailedLegacyBufferProjection();
  try {
    const sessions = fixture.snapshot.sessions
      .filter((session) => session.conversationId === fixture.conversationId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      hostKind: "tmux-legacy",
      host: "hosted",
      turn: "running",
      provenance: "derived",
    });
    expect(hasStructuredDeliveryHost(fixture.key)).toBeFalse();
  } finally {
    await fixture.dispose();
  }
});
