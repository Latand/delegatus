import { describe, expect, test } from "bun:test";

import { askGist, askSkipReason } from "./gist";
import { ASK_QUESTIONS, classifierText, classifyWithJev, JEV_ENDPOINT, JEV_MODEL, JevError, jevFailureCostUsd } from "./jev";

/* The classifier call as the research made it (docs/research/attention-classifier.md
   §2, §4), against a stubbed endpoint: the request Celestia's Tier-0 sends, the
   three statements scored as "Jev V2", and nothing that is not an answer. */

function answer(values: { asks?: unknown; waiting?: unknown; decision?: unknown; cost?: unknown } = {}): Response {
  return new Response(JSON.stringify({
    answers: {
      asks: { type: "noul", noul: values.asks ?? 0.91 },
      waiting: { type: "noul", noul: values.waiting ?? 0.3 },
      decision: { type: "noul", noul: values.decision ?? 0.2 },
    },
    usage: { input_tokens: 1191, output_tokens: 51, cost: "cost" in values ? values.cost : 0.00005 },
  }));
}

describe("classifyWithJev", () => {
  test("posts one redacted message with the three statements and scores the highest", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const verdict = await classifyWithJev("Reach me at someone@example.com, or run /home/user/bin/deploy. Merge now?", {
      apiKey: "test-key",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return answer({ asks: 0.4, waiting: 0.88, decision: 0.1 });
      }) as unknown as typeof fetch,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(JEV_ENDPOINT);
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(seen[0]!.init.body)) as { model: string; state: { agent_message: string }; questions: typeof ASK_QUESTIONS };
    expect(body.model).toBe(JEV_MODEL);
    expect(Object.keys(body.questions)).toEqual(["asks", "waiting", "decision"]);
    expect(body.state.agent_message).toBe("Reach me at <email>, or run ~/bin/deploy. Merge now?");
    expect(verdict).toEqual({ score: 0.88, answers: { asks: 0.4, waiting: 0.88, decision: 0.1 }, costUsd: 0.00005, inputTokens: 1191 });
  });

  test("an error status, a missing probability or a missing cost is an error, never a verdict", async () => {
    for (const response of [new Response("{}", { status: 402 }), answer({ asks: "high" }), answer({ cost: null }), new Response("not json")]) {
      const call = classifyWithJev("Should I merge it now or wait?", { apiKey: "k", fetch: (async () => response) as unknown as typeof fetch });
      await expect(call).rejects.toBeInstanceOf(JevError);
    }
  });

  test("an unusable 200 carries the cost the provider reported, or none when it did not say", async () => {
    const out = classifyWithJev("Should I merge it now or wait?", { apiKey: "k", fetch: (async () => answer({ asks: 1.2, cost: 0.00003 })) as unknown as typeof fetch });
    await expect(out).rejects.toMatchObject({ code: "shape", billedUsd: 0.00003 });
    const missing = classifyWithJev("Should I merge it now or wait?", { apiKey: "k", fetch: (async () => answer({ cost: "free" })) as unknown as typeof fetch });
    await expect(missing).rejects.toMatchObject({ code: "shape", billedUsd: null });
  });

  test("what a failure counts against the cap: nothing for an error status, else the bill or the ceiling", () => {
    expect(jevFailureCostUsd(new JevError("http", "402", 402), 0.001)).toBe(0);
    expect(jevFailureCostUsd(new JevError("shape", "bad", 200, 0.00003), 0.001)).toBe(0.00003);
    expect(jevFailureCostUsd(new JevError("shape", "bad", 200), 0.001)).toBe(0.001);
    expect(jevFailureCostUsd(new JevError("timeout", "slow"), 0.001)).toBe(0.001);
    expect(jevFailureCostUsd(new JevError("network", "reset"), 0.001)).toBe(0.001);
    expect(jevFailureCostUsd(new Error("socket hang up"), 0.001)).toBe(0.001);
  });

  test("a body that stops arriving is a timeout, and a dropped connection is a network failure", async () => {
    const stalled = classifyWithJev("Should I merge it now or wait?", {
      apiKey: "k",
      timeoutMs: 20,
      fetch: (async (_url: string, init: RequestInit) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"answers\":"));
          init.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      }))) as unknown as typeof fetch,
    });
    await expect(stalled).rejects.toMatchObject({ code: "timeout" });
    const dropped = classifyWithJev("Should I merge it now or wait?", {
      apiKey: "k",
      fetch: (async () => { throw new TypeError("socket connection was closed unexpectedly"); }) as unknown as typeof fetch,
    });
    await expect(dropped).rejects.toMatchObject({ code: "network" });
  });

  test("gives up after its timeout", async () => {
    const call = classifyWithJev("Should I merge it now or wait?", {
      apiKey: "k",
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
    });
    await expect(call).rejects.toMatchObject({ code: "timeout" });
  });

  test("a long message goes as its first 1,000 and last 3,000 characters", () => {
    const text = `${"head ".repeat(600)}${"tail ".repeat(600)}`.trim();
    const sent = classifierText(text);
    expect(sent.startsWith(`${text.slice(0, 1_000)} … `)).toBe(true);
    expect(sent.endsWith(text.slice(-3_000))).toBe(true);
    expect(sent.length).toBe(1_000 + 3 + 3_000);
  });
});

describe("askGist", () => {
  test("is the sentence that asks, in the agent's words, on one line", () => {
    expect(askGist("Built it.\n\n**Options:**\n- `A`: keep\n- `B`: drop\n\nWhich one should I ship? I will wait.")).toBe("Which one should I ship?");
    expect(askGist("Everything is staged. Say the word and I'll merge.")).toBe("Say the word and I'll merge.");
    expect(askGist(`Question: ${"word ".repeat(60)}?`).length).toBeLessThanOrEqual(160);
  });
});

describe("askSkipReason", () => {
  test("skips stage endings, short bodies and engine errors, and sends the rest", () => {
    expect(askSkipReason("Done.\nREVIEW_READY: https://example.invalid/pull/9")).toBe("structured");
    expect(askSkipReason("VERDICT: APPROVE\nNo findings on this head.")).toBe("structured");
    expect(askSkipReason("ok, merged")).toBe("short");
    expect(askSkipReason("Session limit reached ∙ resets 5pm for this account")).toBe("engine-error");
    expect(askSkipReason("The branch is ready. Should I open the pull request now?")).toBeNull();
  });
});
