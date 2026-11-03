# Role-selection replay

The fixed corpus has 24 launches: 10 from the failed-first-builder protocol
introduced in #3406 and 14 recent labelled deliveries. Exact delivered ids and
text digests resolve historical versions. It contains 64 applied labels and
8 misled labels. Anonymous scope wrappers retain the role, project and machine
distinctions. `inputs.json` fixes the corpus and source snapshot digests;
`results.json` contains every measured cell.

Both providers used the same two prompts, candidate ordering, 0.10 cutoff,
9,000-code-point selection budget and 24,000-byte rendered ceiling. Version 2
ships. These are single-run offline measurements, including BM25 fallback on
provider failure. The offline provider deadline was 120 seconds per case;
live selection retains its three-second deadline, so slow live requests can
fall back sooner. Prompt scores and usage receipts were captured on 2026-11-03.

| Arm | Decisions successes | Applied recall | Misled retained | Misled / delivered rules | Mean bytes | Latency p50 / p95, ms | Usage-confirmed USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Whole | n/a | 58/64 (90.6%) | 6/8 | 6/1932 (0.31%) | 23,864 | 6 / 15 | 0 |
| BM25 | n/a | 44/64 (68.8%) | 5/8 | 5/753 (0.66%) | 9,685 | 5 / 10 | 0 |
| OpenAI v1 | 19/24 | 37/64 (57.8%) | 5/8 | 5/486 (1.03%) | 6,528 | 2,261 / 2,905 | 0.04916002 |
| OpenAI v2 | 23/24 | 49/64 (76.6%) | 6/8 | 6/669 (0.90%) | 8,318 | 2,356 / 3,498 | 0.05954745 |
| OpenRouter v1 | 0/24 | 44/64 (68.8%) | 5/8 | 5/753 (0.66%) | 9,685 | 70 / 155 | 0 |
| OpenRouter v2 | 0/24 | 44/64 (68.8%) | 5/8 | 5/753 (0.66%) | 9,685 | 74 / 132 | 0 |

OpenRouter refused all decision cells; its rows measure BM25 fallback. The
byte ceiling removes some historical labels even from whole delivery. Misled
labels are sparse, and unlabelled rules have unknown relevance. The rate in
the table counts reported misled rules among all delivered rules. The 0.10
cutoff was tuned on captured scores from this corpus, so recall is an in-sample
measurement. The eight misled labels warrant reporting the tradeoff alongside
recall: v2 retains one more misled rule than BM25.

Total usage-confirmed spend across both providers and all evaluation calls is
**USD 0.21919767**. Twelve partially priced cells retain their complete request
ceilings. The conservative total charge is **USD 0.358401295**, below the shared
**USD 5** cap. Exact final billing of those twelve cells is unavailable. This
total includes the earlier input-assembly run; the table uses only the final
corpus. No balance endpoint or admin credential was used. OpenRouter's observed
charge is zero. Local reservations survive process restarts and prevent retry
of an uncertain cell.

The runner and instructions are in
`docs/design/role-memory-selector-observations.md#repeat-the-offline-evaluation`.
Private corpus text and score receipts remain outside version control. An
offline `--replay` requires their matching digests and sends no requests.

No operator action is required for an unsaved provider choice: a connected
OpenAI key selects OpenAI; otherwise a connected OpenRouter key selects
OpenRouter. To override an explicit saved choice, use **Settings → Keys →
OpenAI → Learned rules → OpenAI** (`PUT /api/openai-services` with
`{"feature":"rules","provider":"openai"}`). Live settings were left intact.
