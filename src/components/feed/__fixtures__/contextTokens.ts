/* A hand-assembled Claude conversation for the tool-call token evidence
   (docs/design/tool-call-tokens.md §11). Every value is invented. The prompt
   size of each response is chained so the parser measures the growth listed
   on each call: one call in each of the four bands, a pair that shares one
   round, an MCP call, a call with nothing to measure, and — last, with no
   response after it yet — the worst-case row: an error whose duration, status
   chip and estimate are all at their widest. */

const START = Date.UTC(2026, 9, 1, 10, 0, 0);
const at = (seconds: number) => new Date(START + Math.round(seconds * 1000)).toISOString();
const filler = (chars: number) => "line of tool output ".repeat(Math.ceil(chars / 20)).slice(0, chars);

type Call = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Result size and how long the call ran. */
  chars: number;
  seconds: number;
  error?: boolean;
  result?: string;
};
type Round = { say: string; calls: Call[]; growth?: number };

const ROUNDS: Round[] = [
  { say: "I'll start with the settings route.", growth: 420, calls: [
    { id: "t1", name: "Read", input: { file_path: "src/app/settings/page.tsx" }, chars: 1_000, seconds: 0.352 },
  ] },
  { say: "Now where the settings hook is used.", growth: 3_870, calls: [
    { id: "t2", name: "Grep", input: { pattern: "useSettings", path: "src" }, chars: 9_300, seconds: 1.2 },
  ] },
  { say: "The hook lives in a large file, reading it.", growth: 12_449, calls: [
    { id: "t3", name: "Read", input: { file_path: "src/lib/settings/useSettings.ts" }, chars: 29_800, seconds: 0.41 },
  ] },
  { say: "Running the settings tests to see the slow path.", growth: 27_800, calls: [
    { id: "t4", name: "Bash", input: { command: "bun test src/lib/settings" }, chars: 66_700, seconds: 14.2 },
  ] },
  { say: "Two more files at once.", growth: 15_600, calls: [
    { id: "t5", name: "Read", input: { file_path: "src/lib/settings/store.ts" }, chars: 11_000, seconds: 0.2 },
    { id: "t6", name: "Read", input: { file_path: "src/lib/settings/migrate.ts" }, chars: 26_400, seconds: 0.3 },
  ] },
  { say: "Checking what the board says about it.", growth: 2_300, calls: [
    { id: "t7", name: "mcp__viewer__list_pipelines", input: { state: "open", compact: true }, chars: 5_500, seconds: 0.64 },
  ] },
  { say: "An empty listing tells me nothing to count.", growth: 0, calls: [
    { id: "t8", name: "Bash", input: { command: "ls tmp" }, chars: 0, seconds: 0.05 },
  ] },
];

/** The worst case: error chip, 59 s and ~99.9k, the last call of the live tail. */
const WORST: Call = {
  id: "t9",
  name: "Bash",
  input: { command: "bun run scripts/rebuild-everything.ts --all --verbose" },
  chars: 239_900,
  seconds: 59,
  error: true,
  result: `Command exited with code 127\n${filler(239_870)}`,
};

export function contextTokensConversationLines(): string[] {
  const lines: string[] = [];
  let clock = 0;
  let prompt = 41_000;
  let output = 140;
  let responses = 0;
  const assistant = (say: string, calls: Call[]) => {
    responses += 1;
    const usage = { input_tokens: 4, cache_read_input_tokens: prompt - 4 - 1_200, cache_creation_input_tokens: 1_200, output_tokens: output };
    const blocks: object[] = [{ type: "text", text: say }, ...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input }))];
    blocks.forEach((block, index) => {
      lines.push(JSON.stringify({
        type: "assistant", timestamp: at(clock + index * 0.001), requestId: `req-${responses}`,
        message: { id: `msg-${responses}`, model: "claude-opus-5-5", role: "assistant", content: [block], usage },
      }));
    });
  };
  lines.push(JSON.stringify({ type: "user", timestamp: at(clock), message: { role: "user", content: "The settings page takes seconds to open. Can you find out why?" } }));
  clock += 1;
  for (const round of ROUNDS) {
    assistant(round.say, round.calls);
    for (const call of round.calls) {
      clock += call.seconds;
      lines.push(JSON.stringify({
        type: "user", timestamp: at(clock),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: filler(call.chars), ...(call.error ? { is_error: true } : {}) }] },
      }));
    }
    clock += 1;
    prompt += output + (round.growth ?? 0);
    output = 160;
  }
  assistant("That was the slow part. One last rebuild to confirm.", [WORST]);
  clock += WORST.seconds;
  lines.push(JSON.stringify({
    type: "user", timestamp: at(clock),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: WORST.id, content: WORST.result, is_error: true }] },
  }));
  return lines;
}
