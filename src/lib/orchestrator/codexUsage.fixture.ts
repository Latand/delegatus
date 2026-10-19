/** Codex token_count shape with provider-reported counters. Cached input is
 * included in input; reasoning output is included in output. */
export const CODEX_TOKEN_COUNT = {
  timestamp: "2026-10-19T05:53:13.644Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 550_986,
        cached_input_tokens: 454_912,
        cache_write_input_tokens: 0,
        output_tokens: 2_624,
        reasoning_output_tokens: 531,
        total_tokens: 553_610,
      },
      last_token_usage: {
        input_tokens: 105_960,
        cached_input_tokens: 93_824,
        cache_write_input_tokens: 0,
        output_tokens: 420,
        reasoning_output_tokens: 213,
        total_tokens: 106_380,
      },
      model_context_window: 475_000,
    },
    rate_limits: null,
  },
} as const;
