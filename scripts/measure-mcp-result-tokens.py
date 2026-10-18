"""Count fixed MCP result projections with o200k_base; no live inputs."""
import json
from pathlib import Path
import tiktoken

samples = json.loads((Path(__file__).resolve().parents[1] / "src/lib/mcp/fixtures/modelResults.json").read_text())
encoder = tiktoken.get_encoding("o200k_base")


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def tokens(text):
    return len(encoder.encode(text))


runs = []
for _ in range(3):
    rows = []
    for index, result in enumerate(samples):
        text = compact(result)
        content = [{"type": "text", "text": text}]
        error = {} if result["ok"] else {"isError": True}
        before = compact({"content": content, "structuredContent": result, **error})
        after = compact({"content": content, **error})
        # These are the result-bearing text blocks observed in the native
        # clients. Fixed engine timing prefixes and transcript storage escapes
        # are excluded; Claude text blocks are joined after the engine unwraps.
        assert json.loads(after)["content"][0]["text"] == text
        rows.append({"sample": index, "tool": result["toolName"], "ok": result["ok"],
                     "codexBefore": tokens(before), "codexAfter": tokens(after),
                     "claudeBefore": tokens(text), "claudeAfter": tokens(text)})
    runs.append(rows)
assert runs[0] == runs[1] == runs[2]
totals = {key: sum(row[key] for row in runs[0]) for key in ["codexBefore", "codexAfter", "claudeBefore", "claudeAfter"]}
print(json.dumps({"encoding": "o200k_base", "tiktoken": tiktoken.__version__, "repetitions": 3,
                  "samples": len(samples), "rows": runs[0], "totals": totals}, indent=2))
