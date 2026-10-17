"""Condense the raw acceptance matrix into the committed summary record.

The raw artifact written by `mcp-state-writer-matrix.py --summarize ROOT OUT.json
OUT.md` holds every call report and normalized response of 108 samples, about
18 MB. The repository keeps a summary below 1 MB instead:

    python3 -B scripts/mcp-state-writer-matrix-summary.py condense RAW.json OUT.json
    python3 -B scripts/mcp-state-writer-matrix-summary.py check SUMMARY.json DOC.md

`condense` keeps the verdicts, sources, cohort medians, comparer controls, the
method record, every per-sample figure the report tables print, every
candidate/control pair and each sample's comparison counters and hashes. It
drops the per-sample SQL phase breakdown, the per-process SQL duplicates, folds
the per-process connection records per role and database, and drops the
normalized rows and responses. `check` rebuilds the two report tables and the
totals paragraph from the summary and requires them to appear in DOC.md.
Regenerate the raw file with `--summarize` into an untracked path, for example
under the temporary directory, never into evidence/.
"""
import hashlib
import json
import pathlib
import sys

SUMMARY_SCHEMA_VERSION = 1
SAMPLE_REPORT_KEYS = [
    "clients", "mode", "shared", "offered", "completed", "failed", "pendingAtEnd",
    "allPendingAtObservedEnd", "pendingAfterDrain", "allPendingAfterDrain",
    "pendingAfterReconciliation", "allPendingAfterReconciliation", "completedAtEnd",
    "offeredAfterEnd", "failedAtEnd", "reconciliation", "latency", "seedChecksum",
    "failures", "unfinishedViewerCallsAtTeardown", "unfinishedExecutorCallsAtTeardown",
    "unfinishedAdapterCallsAtTeardown", "processes", "viewer",
]
SAMPLE_SQL_DROPPED = ["phases", "measuredByProcessDatabase", "measuredApplicationByProcessDatabase"]
SAMPLE_MANIFEST_KEYS = ["clients", "transport", "shared", "repeat", "startedAt", "smoke"]
COMPARISON_DROPPED = ["rows", "responses"]
VERDICT_KEYS = [
    "collectionComplete", "matrixComplete", "accepted", "acceptanceFailures", "comparerControls",
    "oldOracleRedProofs", "oldWindowRedProofs", "sources", "cohorts", "loopBoundaryObservations",
    "loopBoundaryGapsOverResolution", "measurementMethod",
]


def compact(value):
    return json.dumps(value, sort_keys=False, separators=(",", ":"))


def dump(summary):
    """One line per record, so a diff and a review stay readable."""
    lines = ["{"]
    keys = list(summary)
    for index, key in enumerate(keys):
        value = summary[key]
        tail = "," if index < len(keys) - 1 else ""
        if isinstance(value, list) and len(value) > 3 and all(isinstance(item, dict) for item in value):
            lines.append(f"{json.dumps(key)}:[")
            lines.extend("  " + compact(item) + ("," if i < len(value) - 1 else "") for i, item in enumerate(value))
            lines.append("]" + tail)
        elif isinstance(value, dict) and len(value) > 3 and all(isinstance(item, dict) for item in value.values()):
            lines.append(f"{json.dumps(key)}:{{")
            names = list(value)
            lines.extend("  " + json.dumps(name) + ":" + compact(value[name]) + ("," if i < len(names) - 1 else "")
                         for i, name in enumerate(names))
            lines.append("}" + tail)
        else:
            lines.append(f"{json.dumps(key)}:{compact(value)}{tail}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def connection_totals(connections):
    """Fold per-process connection records into one record per role and database."""
    folded = {}
    for c in connections:
        total = folded.setdefault((c["role"], c["database"]), {
            "role": c["role"], "database": c["database"], "processes": 0, "opened": 0, "readonly": 0,
            "closed": 0, "reclaimedAtExit": 0, "liveAtExit": 0, "peakPerProcess": 0,
            "currentAfterTeardown": 0, "unbalancedProcesses": 0})
        total["processes"] += 1
        for key in ["opened", "readonly", "closed", "reclaimedAtExit", "liveAtExit", "currentAfterTeardown"]:
            total[key] += c[key]
        total["peakPerProcess"] = max(total["peakPerProcess"], c["peak"])
        if c["opened"] != c["closed"] + c["reclaimedAtExit"] or c["currentAfterTeardown"]:
            total["unbalancedProcesses"] += 1
    return list(folded.values())


def sample_record(entry):
    report = entry["report"]
    sql = {k: v for k, v in report["sql"].items() if k not in SAMPLE_SQL_DROPPED}
    sql["connections"] = connection_totals(sql["connections"])
    record = {"sample": entry["sample"]}
    record.update({k: entry["manifest"][k] for k in SAMPLE_MANIFEST_KEYS})
    record["report"] = {k: report[k] for k in SAMPLE_REPORT_KEYS}
    record["report"]["sql"] = sql
    return record


def totals_by_side(samples):
    totals = {}
    for entry in samples:
        side = entry["sample"].split("-", 1)[0]
        report = entry["report"]
        total = totals.setdefault(side, {"offered": 0, "completed": 0, "failed": 0, "pendingAfterReconciliation": 0})
        for key in total:
            total[key] += report[key]
    return totals


def condense(raw_path, out_path):
    raw_bytes = raw_path.read_bytes()
    raw = json.loads(raw_bytes)
    equivalence = raw["equivalence"]
    summary = {
        "summarySchemaVersion": SUMMARY_SCHEMA_VERSION,
        "generation": {
            "command": "python3 -B scripts/mcp-state-writer-matrix.py --summarize ROOT RAW.json RAW.md, "
                       "then python3 -B scripts/mcp-state-writer-matrix-summary.py condense RAW.json THIS.json",
            "candidateRevision": raw["sources"]["candidate"]["sourceRevision"],
            "harnessRevision": raw["sources"]["candidate"]["harnessRevision"],
            "analysisFileSha256": equivalence["analysisFileSha256"],
            "rawArtifact": {
                "schemaVersion": raw["schemaVersion"],
                "bytes": len(raw_bytes),
                "lines": raw_bytes.count(b"\n"),
                "sha256": hashlib.sha256(raw_bytes).hexdigest(),
                "samples": len(raw["samples"]),
                "pairs": len(equivalence["pairs"]),
                "droppedFromSummary": [
                    "per-sample SQL phase breakdown and per-process SQL duplicates",
                    "per-process connection records (folded per role and database, with a count of unbalanced processes)",
                    "normalized rows and responses of every sample",
                ],
                "recover": "git show 442282e51c065fa4071d75227e407abbffce35c6:evidence/mcp-state-writers-matrix.json "
                           "(git blob 6bf96578f7c2285ba60da5421777a355552789b3)",
            },
        },
    }
    summary.update({key: raw[key] for key in VERDICT_KEYS})
    summary["totalsBySide"] = totals_by_side(raw["samples"])
    summary["samples"] = [sample_record(entry) for entry in raw["samples"]]
    summary["equivalence"] = {
        "normalizationVersion": equivalence["normalizationVersion"],
        "analysisVersion": equivalence["analysisVersion"],
        "responseProjectionFields": equivalence["responseProjectionFields"],
        "detailedOutcomeFields": equivalence["detailedOutcomeFields"],
        "analysisFileSha256": equivalence["analysisFileSha256"],
        "normalization": equivalence["normalization"],
        "samples": {name: {k: v for k, v in comparison.items() if k not in COMPARISON_DROPPED}
                    for name, comparison in equivalence["samples"].items()},
        "pairs": equivalence["pairs"],
    }
    out_path.write_text(dump(summary))
    json.loads(out_path.read_text())
    print(json.dumps({"bytes": out_path.stat().st_size, "samples": len(summary["samples"]),
                      "pairs": len(equivalence["pairs"])}))


def fmt(x):
    return f"{x['loopP99']:.6f} / {x['loopMax']:.6f}"


def cohort_rows(summary):
    rows = []
    for c in summary["cohorts"]:
        cells = [fmt(c["mediansMs"][s]) if s in c["mediansMs"] else "incomplete" for s in ["candidate", "main", "audit"]]
        rows.append("| " + c["cohort"] + " | " + " | ".join(cells) + " | " + ("yes" if c["loopNoRegression"] else "no") + " |")
    return rows


def sample_rows(summary):
    rows = []
    boundaries = summary["loopBoundaryObservations"]
    for entry in summary["samples"]:
        r = entry["report"]
        p = r["processes"]
        sql = r["sql"]
        conn = [c for c in sql["connections"] if c["database"] == "state.sqlite"]
        sums = [sum(c[k] for c in conn) for k in ["opened", "closed", "reclaimedAtExit"]]
        b = boundaries[entry["sample"]]
        cells = [
            entry["sample"], fmt(r["viewer"]), f"{b['startDelayMs']}/{b['endDelayMs']}",
            f"{r['offered']}/{r['completed']}/{r['failed']}",
            f"{r['pendingAtEnd']}/{r['pendingAfterDrain']}/{r['pendingAfterReconciliation']}",
            f"{p['peak']}/{p['births']}/{p['births'] - p['survivors']}/{p['survivors']}",
            f"{p['peakAdapterDescriptors']}/{p['peakMainDescriptors']}",
            "/".join(map(str, sums)), str(sql["measuredByDatabase"].get("state.sqlite", {}).get("commit", 0)),
            f"{sql['contentionPer10000Completed']:.3f}", str(sql["heldLeaseRefusals"] + sql["leaseSqlRefusals"]),
        ]
        rows.append("| " + " | ".join(cells) + " |")
    return rows


def pair_rows(summary):
    rows = []
    for p in summary["equivalence"]["pairs"]:
        k = p["committedLogicalKeys"]
        rows.append(f"| {p['before']} / {p['after']} | {k['common']}/{k['beforeOnly']}/{k['afterOnly']} | "
                    f"{len(p['commonCommittedTaskPayloadMismatchKeys'])} | "
                    f"{p['originalSuccessfulMutationReplyPairs']}/{p['originalSuccessfulMutationReplyMismatches']} | "
                    f"{p['differentRevisionGuardInputs']} | {p['exactNormalizedRowsEqual']} / {p['exactNormalizedResponsesEqual']} |")
    return rows


def check(summary_path, doc_path):
    summary = json.loads(summary_path.read_text())
    doc = doc_path.read_text().splitlines()
    problems = []
    for label, rows in [("cohort", cohort_rows(summary)), ("sample", sample_rows(summary)), ("pair", pair_rows(summary))]:
        missing = [row for row in rows if row not in doc]
        problems += [f"{label} row missing from the document: {row}" for row in missing]
        print(f"{label}: {len(rows)} rows, {len(missing)} missing")
    totals = summary["totalsBySide"]
    pairs = summary["equivalence"]["pairs"]
    text = " ".join(doc)
    expected = [
        f"{sum(t['offered'] for t in totals.values()):,} measured offers",
        f"completed {totals['candidate']['completed']:,}",
        f"{totals['candidate']['failed']:,} failures",
        f"{totals['main']['completed']:,} of {totals['main']['offered']:,}",
        f"{totals['main']['failed']:,} failures",
        f"{totals['main']['pendingAfterReconciliation']:,} pending",
        f"{totals['audit']['completed']:,} of {totals['audit']['offered']:,}",
        f"{totals['audit']['failed']:,} failures",
        f"{totals['audit']['pendingAfterReconciliation']:,} pending",
        f"agree in {sum(p['exactNormalizedRowsEqual'] for p in pairs)}/{len(pairs)} pairs",
        f"Committed histories reconcile in {sum(p['bothHistoriesReconciled'] for p in pairs)}/{len(pairs)} pairs",
    ]
    normalized = " ".join(text.split())
    for phrase in expected:
        if phrase not in normalized:
            problems.append(f"total missing from the document: {phrase}")
    failures = "Recorded acceptance failures: `" + json.dumps(summary["acceptanceFailures"], separators=(",", ":")) + "`."
    if failures not in doc:
        problems.append("acceptance failures line differs from the document")
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "condense":
        condense(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
        return 0
    if len(sys.argv) == 4 and sys.argv[1] == "check":
        return check(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
