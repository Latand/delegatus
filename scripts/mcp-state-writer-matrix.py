"""Replay immutable product revisions through the existing state-writer driver.

Each sample takes its own owned-runner admission. Interrupted samples stay on
disk; rerunning the same command resumes only samples with complete reports.
Use --compare for stored histories, --verify-comparer for copied-record
controls, and --summarize ROOT OUTJSON OUTMD for the full acceptance report.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[1]
HARNESS = ["scripts/mcp-call-cost-benchmark.ts", "scripts/mcp-state-writer-benchmark.ts",
           "scripts/mcp-state-writer-report.ts", "scripts/sqlite-observer.ts",
           "scripts/sqlite-observer.c", "scripts/mcp-state-writer-matrix.py",
           "src/lib/mcp/writerConcurrencyChild.ts", "src/lib/mcp/ownedFixtureChildren.ts"]


def digest(filename):
    with open(filename, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def environment(root):
    env = {k: v for k, v in os.environ.items() if not k.startswith(
        ("LLV_", "DELEGATUS_", "MCP_SQL_", "MCP_BENCH_", "NEXT_PUBLIC_", "TMUX"))}
    # The runner validates this inherited lease against its live kernel lock.
    # Nested samples still receive their own owned runner and resource quota.
    if "LLV_GATE_SLOT_LEASE" in os.environ:
        env["LLV_GATE_SLOT_LEASE"] = os.environ["LLV_GATE_SLOT_LEASE"]
    for key in ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR", "LLV_CODEX_HOME",
                "LLV_CLAUDE_HOME", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "GH_CONFIG_DIR", "TMUX_TMPDIR"]:
        folder = root / key
        folder.mkdir(parents=True, exist_ok=True)
        env[key] = str(folder)
    # Keep every fixture directory beneath the process's declared temp root.
    env["TMPDIR"] = str(root)
    env.update(CODEX_HOME=env["LLV_CODEX_HOME"], CLAUDE_CONFIG_DIR=env["LLV_CLAUDE_HOME"],
               LLV_VIEWER_CONTROL_URL="http://127.0.0.1:1", NODE_ENV="test", LLV_STRUCTURED_HOSTS="0")
    return env


def quotas():
    relative = next(line[3:] for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    leaf = pathlib.Path("/sys/fs/cgroup") / relative.lstrip("/")
    return [{name: (parent / name).read_text().strip() for name in
             ["cpu.max", "memory.max", "cpuset.cpus.effective"] if (parent / name).exists()}
            for parent in [leaf, *leaf.parents] if str(parent).startswith("/sys/fs/cgroup")]


def run(gate, command, cwd, env, log):
    with open(log, "w") as output, open(str(log) + ".stderr", "w") as errors:
        child = subprocess.Popen(["bash", str(gate), *command], cwd=cwd, env=env,
                                 stdout=output, stderr=errors)
        pathlib.Path(str(log) + ".pid").write_text(str(child.pid))
        code = child.wait()
    if code:
        raise RuntimeError(f"owned command exited {code}; see {pathlib.Path(log).name}")


def checksum_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def committed_history(root, sample):
    """Replay only successful commits into a private in-memory seed copy.

    SQL collection revisions order concurrent transactions even when a process
    was descheduled between releasing SQLite's lock and logging its commit.
    Original caller replies remain separate evidence, including unknown ones.
    """
    pending, transactions, effects, task_versions = {}, [], {}, []
    literals = sqlite3.connect(":memory:")
    sql_hash = hashlib.sha256()
    with (sample / "sql.ndjson").open("rb") as source:
        for line in source:
            sql_hash.update(line)
            event = json.loads(line)
            connection = (event["pid"], event["connection"])
            if event["event"] in ["begin", "rollback"]:
                pending.pop(connection, None)
            elif event["event"] == "domain-statement":
                pending.setdefault(connection, []).append(event)
            elif event["event"] == "commit":
                statements = pending.pop(connection, [])
                if not statements:
                    continue
                inserts = []
                for statement in statements:
                    sql = statement["sql"]
                    match = re.search(r"INSERT\s+INTO\s+state_rows\s*\((.*?)\)\s*VALUES\s*\((.*)\)\s*ON\s+CONFLICT", sql, re.S | re.I)
                    if match:
                        columns = [name.strip() for name in match[1].split(",")]
                        values = literals.execute("SELECT " + match[2]).fetchone()
                        inserts.append(dict(zip(columns, values)))
                revision = max((row["row_revision"] for row in inserts if row["collection"] == "tasks"), default=0)
                transactions.append((revision, event["atNs"], statements))
                call = statements[0].get("call", "")
                task_versions.extend({"call": call, "row": row} for row in inserts
                                     if row["collection"] == "tasks" and row["row_key"].startswith("t:"))
                if call.startswith(("create_task:", "update_task:")):
                    entry = effects.setdefault(call, {"commits": 0, "rows": [],
                                                      "notBeforeMs": statements[0]["atMs"], "observedCommitMs": event["atMs"]})
                    entry["commits"] += 1
                    entry["rows"].extend(row for row in inserts if row["collection"] == "tasks" and row["row_key"].startswith("t:"))
    literals.close()
    mirror = sqlite3.connect(":memory:")
    with sqlite3.connect(f"file:{root / 'seed' / 'state.sqlite'}?mode=ro", uri=True) as seed:
        seed.backup(mirror)
    for _, _, statements in sorted(transactions, key=lambda item: item[:2]):
        with mirror:
            for statement in statements:
                mirror.execute(statement["sql"])
    actual = json.loads((sample / "final-rows.json").read_text())
    # Historical diagnostic records retained four columns. New samples retain
    # every persisted column, including ordering and the controller index flag.
    columns = list(actual[0])
    rows = [dict(zip(columns, row)) for row in mirror.execute(
        "SELECT " + ",".join(columns) + " FROM state_rows ORDER BY collection,row_key")]
    mirror.close()
    return {"transactions": len(transactions), "effects": effects, "taskVersions": task_versions, "replayMatchesFinalRows": rows == actual,
            "replayedRowSha256": checksum_json(rows), "finalRowSha256": checksum_json(actual),
            "observationSqlSha256": sql_hash.hexdigest()}


def task_cursor(value):
    if not isinstance(value, str) or not 0 < len(value) <= 2048:
        raise ValueError("invalid task cursor length")
    decoded = json.loads(base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True))
    if (not isinstance(decoded, dict) or set(decoded) != {"scope", "id", "time"}
            or not all(isinstance(item, str) for item in decoded.values())):
        raise ValueError("invalid task cursor fields")
    return decoded


def fixture_task_summary(task, links=False):
    """Expected compact fields of the benchmark's short, unassigned tasks."""
    result = {key: task[key] for key in ["id", "project", "status", "text", "updatedAt", "revision", "placement"]}
    result.update(assignmentCount=len(task.get("assignments", [])), detailsLength=len(task.get("details", "")),
                  textLength=len(task["text"]))
    if "board" in task:
        result["board"] = task["board"]
    if links:
        result.update(pipelineIds=[], pipelineIdsOmitted=0)
    return result


def check_list_answers(calls, seed, history):
    """Check page content against seed and committed versions independently.

    The product may read page selection and individual records at different
    committed revisions. Do not impose a single atomic snapshot on that API.
    Commit logging occurs after releasing the SQL lock: statement and commit
    observations bound the possible visibility window without ordering peers
    by their logger's scheduling.
    """
    versions, creations, seed_counts, violations = {}, [], {}, []
    for (collection, key), row in seed.items():
        if collection == "tasks" and key.startswith("t:"):
            task = row["value_json"]
            versions[(task["id"], task["revision"])] = (task, 0)
            seed_counts[task["project"]] = seed_counts.get(task["project"], 0) + 1
    for name, effect in history["effects"].items():
        for row in effect["rows"]:
            task = json.loads(row["value_json"])
            versions[(task["id"], task["revision"])] = (task, effect["notBeforeMs"])
            if name.startswith("create_task:"):
                creations.append((task["project"], effect["notBeforeMs"], effect["observedCommitMs"]))
    times_by_id = {}
    for (identity, _), (task, start) in versions.items():
        times_by_id.setdefault(identity, []).append((task["updatedAt"], start))
    checked = 0
    for call in calls:
        answer = call.get("result")
        if call["name"] != "list_tasks" or not isinstance(answer, dict) or not answer.get("ok"):
            continue
        checked += 1
        tasks, args = answer.get("tasks", []), call["args"]
        project, limit = args["project"], args["limit"]
        lower = seed_counts[project] + sum(p == project and commit < call["offered"] for p, _, commit in creations)
        upper = seed_counts[project] + sum(p == project and start <= call["completed"] for p, start, _ in creations)
        total = answer.get("total")
        if not isinstance(total, int) or not lower <= total <= upper:
            violations.append("list total differs from its possible committed create counts")
            continue
        if (answer.get("count") != len(tasks) or len(tasks) != min(limit, total)
                or answer.get("remainingCount") != total - len(tasks)
                or answer.get("omittedCount") != total - len(tasks)
                or answer.get("hasMore") != (total > len(tasks))
                or answer.get("cursorReset") is not False
                or answer.get("compact") is not True or answer.get("omittedRecordCount") != len(tasks)):
            violations.append("list pagination metadata differs from its returned rows")
        if len(tasks) != len({task["id"] for task in tasks}):
            violations.append("duplicate task in a list response")
        for task in tasks:
            stored = versions.get((task.get("id"), task.get("revision")))
            if (not stored or stored[1] > call["completed"] or stored[0]["project"] != project
                    or fixture_task_summary(stored[0], links=True) != task):
                violations.append("a listed task differs from every visible committed version")
        boundary = None
        if answer.get("hasMore") and tasks:
            try:
                cursor = task_cursor(answer.get("nextCursor"))
                scope = {"project": project, "statuses": [], "placement": "", "openOnly": False,
                         "updatedSince": "", "ids": [], "query": "", "priorities": []}
                expected_scope = hashlib.sha256(json.dumps(scope, separators=(",", ":")).encode()).hexdigest()[:16]
                times = {time for time, start in times_by_id.get(tasks[-1]["id"], []) if start <= call["completed"]}
                if cursor["scope"] != expected_scope or cursor["id"] != tasks[-1]["id"] or cursor["time"] not in times:
                    raise ValueError("cursor differs from its selected boundary")
                boundary = (cursor["time"], cursor["id"])
            except (ValueError, TypeError):
                violations.append("list cursor differs from its committed boundary or filters")
        elif answer.get("nextCursor") is not None:
            violations.append("terminal list retains a next cursor")
        previous = None
        for index, task in enumerate(tasks):
            choices = [(time, task["id"]) for time, start in times_by_id.get(task["id"], [])
                       if start <= call["completed"] and (previous is None or (time, task["id"]) < previous)]
            if boundary and index == len(tasks) - 1:
                choices = [choice for choice in choices if choice == boundary]
            if not choices:
                violations.append("list ordering differs from every committed selection history")
                break
            previous = max(choices)
    return checked, violations


def check_committed_guards(calls, seed, history):
    """Check each committed mutation against its immediate durable predecessor."""
    tasks = {row["value_json"]["id"]: row["value_json"] for (collection, key), row in seed.items()
             if collection == "tasks" and key.startswith("t:")}
    offered = {call["name"] + ":" + str(call["args"].get("clientRequestId")): call
               for call in calls if call["name"] in ["create_task", "update_task"]}
    checked, metadata_checked, violations = 0, 0, []
    for version in sorted(history["taskVersions"], key=lambda entry: entry["row"]["row_revision"]):
        task = json.loads(version["row"]["value_json"])
        previous = tasks.get(task["id"])
        label = version["call"]
        if label.startswith(("create_task:", "update_task:")):
            call = offered.get(label)
            if call is None:
                violations.append("a committed mutation has no original offered call")
            elif call["name"] == "create_task":
                if previous is not None or task["project"] != call["args"].get("project"):
                    violations.append("a committed create differs from its requested project or reuses a task")
            else:
                args = call["args"]
                checked += 1
                if (previous is None or args.get("taskId") != task["id"]
                        or ("expectedProject" in args and args["expectedProject"] != previous["project"])
                        or ("expectedRevision" in args and args["expectedRevision"] != previous["revision"])):
                    violations.append("a committed update bypassed its project or revision guard")
                # These fixture updates carry only short text. The public
                # acknowledgement computes its delta before the store stamps
                # the successor revision. Concurrent keys may become the first
                # explicit edit (chosen=true) in a different order per sample.
                answer = call.get("result")
                if previous and isinstance(answer, dict) and answer.get("ok") is True:
                    metadata_checked += 1
                    fields = [field for field in dict.fromkeys([*previous, *task])
                              if field != "revision" and previous.get(field) != task.get(field)]
                    changes = {field: task.get(field) for field in fields
                               if field not in ["id", "project", "revision", "updatedAt", "createdAt"]}
                    if answer.get("changedFields") != fields or answer.get("changes") != changes:
                        violations.append("update acknowledgement delta differs from its committed predecessor")
        tasks[task["id"]] = task
    return checked, metadata_checked, violations


def pair_view(calls, rows, history, normalize):
    def identity(call):
        return (call["client"], call["index"], call["phase"], call["name"])
    # Keep cross-sample response memory bounded by storing page hashes.
    originals = {identity(call): checksum_json(normalize({field: call.get(field) for field in ["ok", "code", "result"]}))
                 for call in calls}
    successful_mutations = {identity(call) for call in calls if call["name"] != "list_tasks"
                            and isinstance(call.get("result"), dict) and call["result"].get("ok")}
    successful_fields = {identity(call): {field: checksum_json(normalize(value)) for field, value in call["result"].items()}
                         for call in calls if identity(call) in successful_mutations}
    inputs, guards = {}, {}
    for call in calls:
        args = dict(call["args"])
        guards[identity(call)] = normalize(args.pop("expectedRevision", None))
        inputs[identity(call)] = checksum_json(normalize(args))
    effects = {}
    for key, effect in history["effects"].items():
        if effect["commits"] == 1 and len(effect["rows"]) == 1:
            effects[key] = checksum_json(normalize(json.loads(effect["rows"][0]["value_json"])))
    durable = {}
    for row in normalize(rows):
        durable[(row["collection"], row["row_key"])] = row
    return {"originals": originals, "inputs": inputs, "guards": guards,
            "effects": effects, "durable": durable, "successful_mutations": successful_mutations,
            "successful_fields": successful_fields}


def pair_details(before, after):
    common = before["effects"].keys() & after["effects"].keys()
    successful = before["successful_mutations"] & after["successful_mutations"]
    mismatch = sorted(key for key in common if before["effects"][key] != after["effects"][key])
    reply_fields = {}
    for key in successful:
        b, a = before["successful_fields"][key], after["successful_fields"][key]
        for field in b.keys() | a.keys():
            if b.get(field) != a.get(field):
                reply_fields[field] = reply_fields.get(field, 0) + 1
    bkeys, akeys = before["durable"].keys(), after["durable"].keys()
    columns, values = {}, {}
    for key in sorted(bkeys & akeys):
        b, a = before["durable"][key], after["durable"][key]
        for field in sorted(b.keys() | a.keys()):
            if field not in b or field not in a or b[field] != a[field]:
                columns[field] = columns.get(field, 0) + 1
        bv, av = b["value_json"], a["value_json"]
        if isinstance(bv, dict) and isinstance(av, dict):
            for field in sorted(bv.keys() | av.keys()):
                if field not in bv or field not in av or bv[field] != av[field]:
                    values[field] = values.get(field, 0) + 1
    responses = {}
    bk, ak = before["originals"].keys(), after["originals"].keys()
    for key in sorted(bk | ak):
        bucket = responses.setdefault(key[-1], {"equal": 0, "different": 0, "missing": 0})
        field = "missing" if key not in bk or key not in ak else "equal" if before["originals"][key] == after["originals"][key] else "different"
        bucket[field] += 1
    return {
        "offeredInputsEqualExceptRevisionGuards": before["inputs"] == after["inputs"],
        "differentRevisionGuardInputs": sum(before["guards"].get(k) != after["guards"].get(k) for k in bk | ak),
        "committedLogicalKeys": {"common": len(common),
            "beforeOnly": len(before["effects"].keys() - after["effects"].keys()),
            "afterOnly": len(after["effects"].keys() - before["effects"].keys())},
        "commonCommittedTaskPayloadsEqual": not mismatch,
        "commonCommittedTaskPayloadMismatchKeys": mismatch,
        "originalSuccessfulMutationReplyPairs": len(successful),
        "originalSuccessfulMutationReplyMismatches": sum(before["originals"][k] != after["originals"][k] for k in successful),
        "originalSuccessfulMutationReplyMismatchFields": reply_fields,
        "originalResponseComparisonByTool": responses,
        "normalizedFinalRowDifferences": {"beforeOnly": len(bkeys - akeys), "afterOnly": len(akeys - bkeys),
            "changedColumns": columns, "changedTaskOrReceiptFields": values},
    }


def compare_samples(root):
    """Keep exact normalized hashes and validate each concurrent history.

    Numeric SQL revisions remain in the exact hash. Concurrent commits and
    the 100-entry create-receipt cap can produce different exact final states;
    the history checks below report those separately from corruption.
    """
    with sqlite3.connect(f"file:{root / 'seed' / 'state.sqlite'}?mode=ro", uri=True) as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(state_rows)")]
        full_seed = {}
        for values in db.execute("SELECT * FROM state_rows"):
            row = dict(zip(columns, values))
            row["value_json"] = json.loads(row["value_json"])
            full_seed[(row["collection"], row["row_key"])] = row
    results, views = {}, {}
    for sample in sorted(root.iterdir()):
        if not (sample / "report.json").exists():
            continue
        print("COMPARE", sample.name, file=sys.stderr, flush=True)
        calls = json.loads((sample / "calls.json").read_text())
        rows = [{**row, "value_json": json.loads(row["value_json"])}
                for row in json.loads((sample / "final-rows.json").read_text())]
        seed = {key: {field: row[field] for field in rows[0]} for key, row in full_seed.items()}
        manifest = json.loads((sample / "manifest.json").read_text())
        boundaries = json.loads((sample / "boundaries.json").read_text()) if (sample / "boundaries.json").exists() else None
        by_key = {(row["collection"], row["row_key"]): row for row in rows}
        replacements, violations, creates, updates = {}, [], {}, {}
        final_receipts = {}
        report = json.loads((sample / "report.json").read_text())
        measured = [call for call in calls if call["phase"] == "measured"]
        measured_counts = {"offered": len(measured),
                           "completed": sum(call.get("completed") is not None for call in measured),
                           "failed": sum(call.get("ok") is False for call in measured),
                           "pendingAfterReconciliation": sum(call.get("completed") is None for call in measured)}
        if boundaries and not manifest["smoke"] and (boundaries["warmSeconds"] != 30 or boundaries["seconds"] != 300
                or len(measured) != 300 * manifest["clients"]):
            violations.append("sample differs from its declared full acceptance window or offered load")
        measured_outcomes = {}
        for call in measured:
            counts = measured_outcomes.setdefault(call["name"], {"offered": 0, "completed": 0, "failed": 0,
                                                                  "pending": 0, "failureKinds": {}})
            counts["offered"] += 1
            counts["completed"] += call.get("completed") is not None
            counts["pending"] += call.get("completed") is None
            if call.get("ok") is False:
                counts["failed"] += 1
                answer = call.get("result")
                code = answer.get("code", "") if isinstance(answer, dict) else ""
                if "task executor admission is full; retry the original request key" in json.dumps(answer):
                    kind = "executor-admission-full"
                elif isinstance(code, str) and re.fullmatch(r"[A-Z_]{2,80}|outcome_unknown|request_in_progress|tool_failed|call_interrupted|http-[0-9]{3}", code):
                    kind = code
                elif isinstance(answer, dict) and not isinstance(answer.get("ok"), bool):
                    kind = "unstructured-sdk-reply"
                elif "MCP error -32001" in str(call.get("code", "")):
                    kind = "sdk-request-timeout"
                else:
                    kind = "other-error-sha256:" + checksum_json(call.get("code"))
                counts["failureKinds"][kind] = counts["failureKinds"].get(kind, 0) + 1
        if any(report.get(key) != count for key, count in measured_counts.items()):
            violations.append("reported call counts differ from original measured call records")
        history = committed_history(root, sample)
        if not history["replayMatchesFinalRows"]:
            violations.append("committed SQL history differs from final durable rows")
        checked_guards, checked_metadata, guard_violations = check_committed_guards(calls, seed, history)
        violations.extend(guard_violations)
        checked_lists, list_violations = check_list_answers(calls, seed, history)
        violations.extend(list_violations)
        if (sample / "final-receipts.json").exists():
            for receipt in json.loads((sample / "final-receipts.json").read_text()):
                if receipt["result_json"]:
                    result = json.loads(receipt["result_json"])
                    if isinstance(result, dict) and result.get("clientRequestId"):
                        final_receipts[(result.get("toolName"), result["clientRequestId"])] = result
        def uncertain_reply(answer):
            return (not isinstance(answer, dict) or not isinstance(answer.get("ok"), bool) or "transportError" in answer
                    or answer.get("code") in ["outcome_unknown", "request_in_progress", "tool_failed", "call_interrupted"]
                    or str(answer.get("code", "")).startswith("http-"))

        effective = []
        original_uncertain = {"receipt": 0, "recoveryReply": 0, "committedEffect": 0, "noEffectAtTeardown": 0, "unresolved": 0}
        unresolved = 0
        unknown_replies = 0
        resolved_committed = 0
        resolved_no_commit = 0
        settled_failure_effects = {}
        for call in calls:
            name, args = call["name"], call["args"]
            key = args.get("clientRequestId")
            answer = final_receipts.get((name, key), call.get("reconciled", call.get("result")))
            effective.append(answer)
            if name == "list_tasks":
                continue
            uncertain = uncertain_reply(answer)
            effect = history["effects"].get(name + ":" + str(key))
            if uncertain_reply(call.get("result")):
                if (name, key) in final_receipts and not uncertain:
                    original_uncertain["receipt"] += 1
                elif not uncertain:
                    original_uncertain["recoveryReply"] += 1
                elif not history["replayMatchesFinalRows"]:
                    original_uncertain["unresolved"] += 1
                elif effect:
                    original_uncertain["committedEffect"] += 1
                else:
                    original_uncertain["noEffectAtTeardown"] += 1
            if effect and (effect["commits"] != 1 or len(effect["rows"]) != 1):
                violations.append("one mutation key committed more than one task effect")
            committed_task = json.loads(effect["rows"][0]["value_json"]) if effect and len(effect["rows"]) == 1 else None
            original = call.get("result")
            if isinstance(original, dict) and original.get("ok"):
                if (not committed_task or original.get("taskId") != committed_task["id"]
                        or not isinstance(original.get("replayed"), bool)
                        or original.get("revision") != committed_task["revision"]
                        or original.get("task") != fixture_task_summary(committed_task)
                        or original.get("toolName") != name or original.get("clientRequestId") != key):
                    violations.append("original successful mutation reply differs from its committed task effect")
            if isinstance(answer, dict) and answer.get("ok"):
                if not committed_task or answer.get("taskId") != committed_task["id"] or answer.get("revision") != committed_task["revision"]:
                    violations.append("a successful reply differs from its committed task effect")
                elif answer.get("task") != fixture_task_summary(committed_task):
                    violations.append("mutation task summary differs from its committed task effect")
            if uncertain:
                unknown_replies += 1
                if not history["replayMatchesFinalRows"]:
                    unresolved += 1
                    continue
                if effect and len(effect["rows"]) == 1:
                    resolved_committed += 1
                    task = committed_task
                    # This is a forensic effect, never a fabricated MCP reply.
                    answer = {"ok": True, "taskId": task["id"], "revision": task["revision"], "task": task}
                else:
                    resolved_no_commit += 1
                    continue
            elif not answer.get("ok") and committed_task:
                settled_failure_effects.setdefault(str(answer.get("code", "unspecified")), []).append(name + ":" + str(key))
                if answer.get("details", {}).get("outcome") == "not-executed":
                    violations.append("a not-executed reply has a committed task effect")
                answer = {"ok": True, "taskId": committed_task["id"], "revision": committed_task["revision"], "task": committed_task}
            if not answer.get("ok"):
                continue
            task = answer.get("task", {})
            task_id, revision = answer.get("taskId"), answer.get("revision")
            if not task_id or not revision or task.get("text") != args["text"]:
                violations.append("mutation acknowledgement differs from its requested task")
                continue
            replacements[revision] = "revision:" + key
            if name == "create_task":
                replacements[task_id] = "created:" + key
                if task_id in creates and creates[task_id] != key:
                    violations.append("two create keys share one generated task")
                creates[task_id] = key
                persisted = by_key.get(("tasks", "t:" + task_id))
                if not persisted or persisted["value_json"].get("text") != args["text"] or persisted["value_json"].get("revision") != revision:
                    violations.append("accepted create is missing or differs in final rows")
            else:
                updates[revision] = (task_id, args["text"], call["index"])
        if manifest["shared"]:
            successful_indices = [value[2] for value in updates.values()]
            if len(successful_indices) != len(set(successful_indices)):
                violations.append("more than one shared-task write passed the same revision guard")
        for row in rows:
            value = row["value_json"]
            identity = (row["collection"], row["row_key"])
            if row["collection"] != "tasks" or not row["row_key"].startswith("t:"):
                if identity in seed and row != seed[identity]:
                    violations.append("an untouched collection row changed")
                continue
            if identity not in seed:
                if value["id"] not in creates:
                    violations.append("a generated task lacks a settled create acknowledgement")
                continue
            if row == seed[identity]:
                continue
            update = updates.get(value.get("revision"))
            if not update or update[:2] != (value["id"], value["text"]) or row["row_revision"] <= seed[identity]["row_revision"]:
                violations.append("a changed seed task lacks a matching committed acknowledgement")
        for identity, row in seed.items():
            if identity not in by_key:
                violations.append("a seed row disappeared")
        # Create receipts are capped at 100 by committed insertion order.
        created_rows = sorted((by_key[("tasks", "t:" + task_id)] for task_id in creates), key=lambda row: row["row_revision"])
        expected_receipts = {creates[row["value_json"]["id"]] for row in created_rows[-100:]}
        actual_receipts = {row["value_json"]["clientRequestId"] for row in rows
                           if row["collection"] == "tasks" and row["row_key"].startswith("r:")}
        if expected_receipts != actual_receipts:
            violations.append("the create-receipt cap differs from committed create order")
        for row in rows:
            if row["collection"] == "tasks" and row["row_key"].startswith("r:"):
                value = row["value_json"]
                task = by_key.get(("tasks", "t:" + value["taskId"]))
                if not task or creates.get(value["taskId"]) != value["clientRequestId"] or task["row_revision"] != row["row_revision"]:
                    violations.append("task and create receipt do not share their atomic revision")

        def normalize(value):
            if isinstance(value, dict):
                normalized = {}
                for key, item in value.items():
                    if key == "nextCursor" and item is not None:
                        try:
                            item = {"taskCursor": task_cursor(item)}
                        except (ValueError, TypeError):
                            pass
                    normalized[key] = normalize(item)
                return normalized
            if isinstance(value, list):
                return [normalize(item) for item in value]
            if isinstance(value, str):
                if value in replacements:
                    return replacements[value]
                if value.startswith("t:") and value[2:] in replacements:
                    return "t:" + replacements[value[2:]]
                if value != "2026-10-01T00:00:00.000Z" and re.fullmatch(r"\d{4}-\d\d-\d\dT[0-9:.]+Z", value):
                    return "SAMPLE_TIME"
            return value

        views[sample.name] = pair_view(calls, rows, history, normalize)
        normalized_rows = sorted(normalize(rows), key=lambda row: (row["collection"], row["row_key"]))
        responses = normalize([{key: call.get(key) for key in ["client", "index", "phase", "ok", "result"]} for call in calls])
        settled = normalize(effective)
        results[sample.name] = {"rows": len(rows), "responses": len(calls), "normalizedRowSha256": checksum_json(normalized_rows),
                                "rawRecordSha256": {**{filename: digest(sample / filename) for filename in
                                    ["calls.json", "final-rows.json", "final-receipts.json", "boundaries.json", "report.json", "manifest.json",
                                     "sql.ndjson.js", "teardown.json", "viewer.ndjson", "census.ndjson", "runtime.json"]
                                    if (sample / filename).exists()}, "sql.ndjson": history["observationSqlSha256"]},
                                "normalizedResponseSha256": checksum_json(responses), "settledResponseSha256": checksum_json(settled),
                                "numericRowRevisionsRetained": True, "durableColumns": sorted(rows[0]), "unresolvedMutations": unresolved,
                                "originalUncertainMutationReplies": sum(original_uncertain.values()),
                                "originalUncertainDispositions": original_uncertain,
                                "unknownMutationRepliesAtReconciliation": unknown_replies, "unknownRepliesWithCommittedEffect": resolved_committed,
                                "unknownRepliesWithNoCommitAtTeardown": resolved_no_commit,
                                "reconciliationFailureRepliesWithCommittedEffects": {
                                    code: {"count": len(keys), "keys": keys} for code, keys in settled_failure_effects.items()},
                                "committedHistoryReplayMatchesFinalRows": history["replayMatchesFinalRows"],
                                "committedRowTransactions": history["transactions"],
                                "replayedRowSha256": history["replayedRowSha256"], "finalRowSha256": history["finalRowSha256"],
                                "committedCreates": len(creates), "committedUpdates": len(updates), "createReceipts": len(actual_receipts),
                                "successfulListRepliesChecked": checked_lists,
                                "committedRevisionGuardsChecked": checked_guards,
                                "updateAcknowledgementDeltasChecked": checked_metadata,
                                "originalMeasuredCallCounts": measured_counts,
                                "windowBoundaries": boundaries,
                                "originalMeasuredOutcomesByTool": measured_outcomes,
                                "unstructuredOriginalMutationReplies": sum(call["name"] != "list_tasks" and isinstance(call.get("result"), dict)
                                    and not isinstance(call["result"].get("ok"), bool) for call in calls),
                                "historyViolations": {reason: violations.count(reason) for reason in sorted(set(violations))}}
        (sample / "equivalence.json").write_text(json.dumps(results[sample.name], indent=2) + "\n")
    pairs = []
    for name, candidate in results.items():
        if not name.startswith("candidate-"):
            continue
        for side in ["audit", "main"]:
            peer = side + name[len("candidate"):]
            if peer in results:
                pairs.append({"before": peer, "after": name, **pair_details(views[peer], views[name]),
                              "exactNormalizedRowsEqual": results[peer]["normalizedRowSha256"] == candidate["normalizedRowSha256"],
                              "exactNormalizedResponsesEqual": results[peer]["normalizedResponseSha256"] == candidate["normalizedResponseSha256"],
                              "bothHistoriesReconciled": not any(results[key]["unresolvedMutations"] or results[key]["historyViolations"] for key in [peer, name])})
    result = {"normalizationVersion": 2, "analysisVersion": 4,
              "responseProjectionFields": ["client", "index", "phase", "ok", "result"],
              "detailedOutcomeFields": ["ok", "code", "result"],
              "analysisFileSha256": digest(pathlib.Path(__file__)),
              "normalization": "Generated task IDs and revision tokens by original mutation key; sample ISO times except the fixed seed instant, including the decoded id/time of task nextCursor tokens while retaining their scope. Numeric SQL row revisions and every other field retained.",
              "samples": results, "pairs": pairs}
    (root / "comparisons.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"samples": len(results), "pairs": len(pairs), "reconciled": sum(pair["bothHistoriesReconciled"] for pair in pairs)}, indent=2))


def verify_comparer(root):
    """Exercise the oracle against copied records; leave collected data intact."""
    scratch = pathlib.Path(tempfile.gettempdir()).resolve()
    root = root.resolve()
    if not root.is_relative_to(scratch) or root == scratch:
        raise RuntimeError("comparer controls require an isolated study under the caller's temporary root")
    source = next(sample for sample in sorted(root.iterdir())
                  if (sample / "report.json").exists() and json.loads((sample / "manifest.json").read_text())["clients"] == 1)
    cases = ["pristine", "unknown-mutations", "list-text", "list-count", "cursor-scope", "list-order",
             "mutation-summary", "row-order", "controller-flag", "invalid-revision-guard",
             "unstructured-mutations", "reported-call-count", "changed-fields", "change-values"]
    with tempfile.TemporaryDirectory(prefix="comparer-controls-", dir=scratch) as directory:
        controls = pathlib.Path(directory)
        (controls / "seed").symlink_to(root / "seed", target_is_directory=True)
        for case in cases:
            target = controls / case
            target.mkdir()
            for name in ["manifest.json", "sql.ndjson", "final-receipts.json", "boundaries.json"]:
                (target / name).symlink_to(source / name)
            calls = json.loads((source / "calls.json").read_text())
            rows = json.loads((source / "final-rows.json").read_text())
            listed = next(call for call in calls if call["name"] == "list_tasks" and call.get("result", {}).get("ok"))
            mutation = next(call for call in calls if call["name"] != "list_tasks" and call.get("result", {}).get("ok"))
            report = json.loads((source / "report.json").read_text())
            if case in ["unknown-mutations", "unstructured-mutations"]:
                for call in calls:
                    if call["name"] != "list_tasks":
                        call["result"] = ({"ok": False, "code": "outcome_unknown"} if case == "unknown-mutations" else
                                          {"isError": True, "content": [{"type": "text", "text": "Fixture tool error"}]})
                        call["ok"] = False
                        call.pop("reconciled", None)
                (target / "final-receipts.json").unlink()
                (target / "final-receipts.json").write_text("[]")
                report["failed"] = sum(call["phase"] == "measured" and call.get("ok") is False for call in calls)
            elif case == "invalid-revision-guard":
                update = next(call for call in calls if call["name"] == "update_task" and call.get("result", {}).get("ok"))
                update["args"]["expectedRevision"] = "invalid-fixture-revision-guard"
            elif case in ["changed-fields", "change-values"]:
                update = next(call for call in calls if call["name"] == "update_task" and call.get("result", {}).get("ok"))
                if case == "changed-fields":
                    update["result"]["changedFields"] = []
                else:
                    update["result"]["changes"]["text"] = "Wrong acknowledged delta"
            elif case == "reported-call-count":
                report["failed"] += 1
            elif case == "list-text":
                listed["result"]["tasks"][0]["text"] = "Wrong returned text"
            elif case == "list-count":
                listed["result"]["count"] -= 1
            elif case == "cursor-scope":
                cursor = task_cursor(listed["result"]["nextCursor"])
                cursor["scope"] = "0" * 16
                listed["result"]["nextCursor"] = base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode().rstrip("=")
            elif case == "list-order":
                tasks = listed["result"]["tasks"]
                tasks[0], tasks[1] = tasks[1], tasks[0]
            elif case == "mutation-summary":
                mutation["result"]["task"]["status"] = "done"
            elif case == "row-order":
                rows[0]["row_order"] += 1
            elif case == "controller-flag":
                rows[0]["controller_active"] = 1 - rows[0]["controller_active"]
            (target / "report.json").write_text(json.dumps(report))
            (target / "calls.json").write_text(json.dumps(calls))
            (target / "final-rows.json").write_text(json.dumps(rows))
        compare_samples(controls)
        results = json.loads((controls / "comparisons.json").read_text())
        records = {}
        for name, sample in results["samples"].items():
            clean = not sample["historyViolations"] and not sample["unresolvedMutations"]
            expected = name in ["pristine", "unknown-mutations", "unstructured-mutations"]
            if name == "unstructured-mutations":
                source_calls = json.loads((source / "calls.json").read_text())
                mutation_count = sum(call["name"] != "list_tasks" for call in source_calls)
                clean = clean and sample["originalUncertainMutationReplies"] == mutation_count
            records[name] = {"accepted": clean, "expectedAcceptance": expected, "violations": sample["historyViolations"],
                             "originalUncertainMutationReplies": sample["originalUncertainMutationReplies"]}
            if clean != expected:
                raise RuntimeError(f"comparer control {name} gave an unexpected verdict: {sample['historyViolations']}")
        report = {"analysisFileSha256": digest(pathlib.Path(__file__)), "sourceSample": source.name, "controls": records}
    filename = root / f"comparer-controls-{time.time_ns()}.json"
    filename.write_text(json.dumps(report, indent=2) + "\n")
    comparison = root / "comparisons.json"
    if (comparison.exists() and json.loads(comparison.read_text()).get("analysisVersion") == 4
            and len(json.loads((root / "matrix.json").read_text())["samples"]) == 108):
        report["summaryWindowControls"] = verify_summary_windows(root)
        filename.write_text(json.dumps(report, indent=2) + "\n")
        print("PASS three report-window controls")
    print("PASS fourteen comparer controls; record:", filename.name)


def verify_summary_windows(root):
    """Hold medians green while testing nominal-window coverage independently."""
    records = {}
    control_file = sorted(root.glob("comparer-controls-*.json"))[-1]
    with tempfile.TemporaryDirectory(prefix="summary-controls-", dir=tempfile.gettempdir()) as directory:
        for case in ["aligned", "late-start", "late-end"]:
            target = pathlib.Path(directory) / case
            target.mkdir()
            matrix = json.loads((root / "matrix.json").read_text())
            comparisons = json.loads((root / "comparisons.json").read_text())
            for side in ["audit", "main", "candidate"]:
                (target / (side + ".manifest.json")).symlink_to(root / (side + ".manifest.json"))
            (target / control_file.name).symlink_to(control_file)
            for entry in matrix["samples"]:
                report = entry["report"]
                viewer = report["viewer"]
                for field in ["loopP50", "loopP95", "loopP99", "loopMax"]:
                    viewer[field] = 0 if entry["sample"].startswith("candidate-") else 1
                viewer.update(firstSampleAt=viewer["scheduledStartAt"], lastSampleAt=viewer["scheduledEndAt"],
                              resetDelayMs=0, missingTailMs=0, completedWindow=True)
                if entry["sample"] == "main-1-stdio-independent-1":
                    if case == "late-start":
                        viewer["firstSampleAt"] += 30
                        viewer["resetDelayMs"] = 30
                    elif case == "late-end":
                        viewer["lastSampleAt"] += 30
                sample = target / entry["sample"]
                sample.mkdir()
                (sample / "manifest.json").symlink_to(root / entry["sample"] / "manifest.json")
                (sample / "report.json").write_text(json.dumps(report))
                comparisons["samples"][entry["sample"]]["rawRecordSha256"]["report.json"] = digest(sample / "report.json")
            (target / "matrix.json").write_text(json.dumps(matrix))
            (target / "comparisons.json").write_text(json.dumps(comparisons))
            result_file, markdown = target / "result.json", target / "result.md"
            summarize_matrix(target, result_file, markdown)
            result = json.loads(result_file.read_text())
            rejected = any("measurementWindow" in failure for failure in result["acceptanceFailures"])
            medians_pass = all(cohort["loopNoRegression"] for cohort in result["cohorts"])
            legacy_complete = all(entry["report"]["viewer"]["completedWindow"] for entry in result["samples"])
            records[case] = {"reportedLoopMediansPass": medians_pass, "windowRejected": rejected,
                             "legacyCompletedWindow": legacy_complete,
                             "expectedWindowRejection": case != "aligned",
                             "matchedExpectation": legacy_complete and medians_pass and rejected == (case != "aligned")}
    if not all(record["matchedExpectation"] for record in records.values()):
        raise RuntimeError("report-window controls disagree: " + json.dumps(records, sort_keys=True))
    return records


def summarize_matrix(root, out, markdown):
    """Publish the declared matrix, retaining failed bounds and exact differences."""
    matrix = json.loads((root / 'matrix.json').read_text())
    comparisons = json.loads((root / 'comparisons.json').read_text())
    records = matrix['samples']
    failures = []
    cohorts = []
    expected_names = []
    for n in [1, 19, 37]:
        for mode in ['stdio-independent', 'stdio-shared', 'http-independent', 'http-shared']:
            for rep in [1, 2, 3]:
                for side in ['candidate', 'main', 'audit'] if rep % 2 else ['audit', 'main', 'candidate']:
                    expected_names.append(f"{side}-{n}-{mode}-{rep}")
    collection_complete = [e['sample'] for e in records] == expected_names
    if not collection_complete:
        failures.append({'matrix': 'sample coverage or alternating source order differs from the declared matrix'})
    for entry in records:
        name = entry['sample']
        r = entry['report']
        m = entry['manifest']
        problems = []
        if not r['viewer']['completedWindow']:
            problems.append('incomplete loop window')
        if r['offeredAfterEnd']:
            problems.append('offered after measurement end')
        if r['processes']['survivors'] or r['processes']['postTeardownMainDescriptors']:
            problems.append('process or descriptor survived teardown')
        for c in r['sql']['connections']:
            if c['opened'] != c['closed'] + c['reclaimedAtExit'] or c['currentAfterTeardown']:
                problems.append('connection imbalance')
        if m['smoke']:
            problems.append('smoke window')
        if name.startswith('candidate-') and any((c['role'] == 'adapter' and c['opened'] for c in r['sql']['connections'])):
            problems.append('adapter opened a database')
        e = comparisons['samples'].get(name)
        if not e or e['unresolvedMutations'] or e['historyViolations'] or (not e['committedHistoryReplayMatchesFinalRows']):
            problems.append('unreconciled final state')
        raw_report, raw_manifest = root / name / "report.json", root / name / "manifest.json"
        if (not raw_report.exists() or not raw_manifest.exists()
                or json.loads(raw_report.read_text()) != r or json.loads(raw_manifest.read_text()) != m
                or not e or e.get("rawRecordSha256", {}).get("report.json") != digest(raw_report)
                or e.get("rawRecordSha256", {}).get("manifest.json") != digest(raw_manifest)):
            problems.append("aggregate differs from its analyzed report or manifest")
        if problems:
            failures.append({'sample': name, 'reasons': sorted(set(problems))})
    for clients in [1, 19, 37]:
        for mode in ['stdio', 'http']:
            for shared in [False, True]:
                suffix = f"{clients}-{mode}-{('shared' if shared else 'independent')}"
                metrics = {}
                for side in ['candidate', 'main', 'audit']:
                    samples = [e for e in records if e['sample'].startswith(side + '-' + suffix + '-')]
                    if len(samples) != 3:
                        continue
                    metrics[side] = {k: statistics.median((e['report']['viewer'][k] for e in samples)) for k in ['loopP99', 'loopMax']}
                passes = len(metrics) == 3 and all((metrics['candidate'][k] <= metrics[side][k] for side in ['main', 'audit'] for k in ['loopP99', 'loopMax']))
                cohorts.append({'cohort': suffix, 'mediansMs': metrics, 'loopNoRegression': passes})
    if len(records) != 108:
        failures.append({'matrix': 'expected 108 complete samples', 'actual': len(records)})
    if len(comparisons['pairs']) != 72:
        failures.append({'equivalence': 'expected 72 candidate/control pairs', 'actual': len(comparisons['pairs'])})
    if sum((e['report']['offered'] for e in records)) != 615600:
        failures.append({'calls': 'expected 615600 measured offers'})
    for p in comparisons['pairs']:
        if not p.get('offeredInputsEqualExceptRevisionGuards'):
            failures.append({'pair': [p['before'], p['after']], 'equivalence': 'offered intents differ'})
        if not p.get('commonCommittedTaskPayloadsEqual'):
            failures.append({'pair': [p['before'], p['after']], 'equivalence': 'common committed payloads differ'})
        # Exact hashes retain replay and delta differences. A retry may settle
        # before the original; concurrent keys can apply their first explicit
        # edit in different orders. Deltas are checked against each committed
        # predecessor, independently of this cross-run comparison.
        if (p.get('originalSuccessfulMutationReplyMismatches', -1) != 0
                and not set(p.get('originalSuccessfulMutationReplyMismatchFields', {})).issubset({'replayed', 'changedFields', 'changes'})):
            failures.append({'pair': [p['before'], p['after']], 'equivalence': 'successful original mutation replies differ'})
    if not all((c['loopNoRegression'] for c in cohorts)):
        failures.append({'loop': 'one or more cohort medians regressed or are incomplete'})
    manifest = {side: json.loads((root / (side + '.manifest.json')).read_text()) for side in ['candidate', 'main', 'audit']}
    for entry in records:
        side = entry['sample'].split('-', 1)[0]
        if side not in manifest or any(entry['manifest'].get(key) != value for key, value in manifest[side].items()):
            failures.append({'sample': entry['sample'], 'identity': 'sample differs from its frozen source manifest'})
    control_files = sorted(root.glob('comparer-controls-*.json'))
    controls = json.loads(control_files[-1].read_text()) if control_files else None
    if not controls or len(controls['controls']) != 14 or any((v['accepted'] != v['expectedAcceptance'] for v in controls['controls'].values())):
        failures.append({'comparer': 'fourteen controls missing or failed'})
    if comparisons.get('analysisVersion') != 4 or not controls or controls.get('analysisFileSha256') != comparisons.get('analysisFileSha256'):
        failures.append({'comparer': 'analysis version or control source identity differs'})
    window_controls = controls.get("summaryWindowControls", {}) if controls else {}
    if collection_complete and (len(window_controls) != 3
            or not all(value.get("matchedExpectation") for value in window_controls.values())):
        failures.append({"comparer": "three report-window controls missing or failed"})
    identities = ['seedSha256', 'bunSha256', 'nodeSha256', 'dependencySnapshotSha256', 'observerSha256', 'capabilitiesFileSha256', 'dependencyLockSha256', 'harnessRevision', 'harnessFiles']
    for key in identities:
        if len({json.dumps(e['manifest'][key], sort_keys=True) for e in records}) != 1:
            failures.append({'identity': key, 'reason': 'samples did not retain one frozen input'})
    if len({json.dumps(e['report']['runtime']['quotaHierarchyLeafFirst'], sort_keys=True) for e in records}) != 1:
        failures.append({'resources': 'sample quota hierarchies differ'})
    method_file = root / 'method-evidence.json'
    method = json.loads(method_file.read_text()) if method_file.exists() else {}
    progress = method.get('progressObserverChange')
    red = method.get('oldOracleRedProofs')
    loop_boundaries = {
        entry["sample"]: {
            "startDelayMs": entry["report"]["viewer"]["resetDelayMs"],
            "endDelayMs": entry["report"]["viewer"]["lastSampleAt"]
                          - entry["report"]["viewer"]["scheduledEndAt"],
            "observedIntervalMs": entry["report"]["viewer"]["lastSampleAt"]
                                  - entry["report"]["viewer"]["firstSampleAt"],
            "missingTailMs": entry["report"]["viewer"]["missingTailMs"],
        }
        for entry in records
    }
    # The frozen harness requests 10 ms resolution. A larger boundary shift
    # prevents certifying the nominal window from these aggregate histograms.
    # Keep the measurements and refuse full-window acceptance without filling
    # those gaps with invented observations.
    loop_resolution_ms = 10
    boundary_gaps = {name: value for name, value in loop_boundaries.items()
                     if abs(value["startDelayMs"]) > loop_resolution_ms or abs(value["endDelayMs"]) > loop_resolution_ms}
    if boundary_gaps:
        failures.append({"measurementWindow": "histogram boundaries exceed the configured resolution; nominal-window coverage is unverified",
                         "samples": len(boundary_gaps), "probeResolutionMs": loop_resolution_ms})
    artifact = {
        'schemaVersion': 3,
        'collectionComplete': collection_complete,
        'matrixComplete': collection_complete and len(comparisons['pairs']) == 72 and (not any(('loop' not in failure for failure in failures))),
        'comparerControls': controls,
        'oldOracleRedProofs': red,
        'oldWindowRedProofs': method.get("oldWindowRedProofs"),
        'accepted': not failures,
        'acceptanceFailures': failures,
        'sources': manifest,
        'cohorts': cohorts,
        'samples': records,
        'equivalence': comparisons,
        'loopBoundaryObservations': loop_boundaries,
        'loopBoundaryGapsOverResolution': boundary_gaps,
        'measurementMethod': {
            'warmSeconds': 30,
            'measuredSeconds': 300,
            'loopProbeResolutionMs': loop_resolution_ms,
            'measuredOffered': sum((e['report']['offered'] for e in records)),
            'sourceOrderByRepetition': [
                [
                    'candidate',
                    'main',
                    'audit',
                ],
                [
                    'audit',
                    'main',
                    'candidate',
                ],
                [
                    'candidate',
                    'main',
                    'audit',
                ],
            ],
            'progressObserverChange': progress,
            'excludedInterSampleDiagnostics': method.get('excludedInterSampleDiagnostics', []),
            'resumedCollection': method.get('resumedCollection'),
            'excludedPartialSamples': method.get('excludedPartialSamples', []),
            'excludedSetupFailures': method.get('excludedSetupFailures', []),
            'methodEvidenceFileSha256': hashlib.sha256(method_file.read_bytes()).hexdigest() if method_file.exists() else None,
            'recovery': 'Original mutation tools retried with original arguments and request keys after drain, at most 19 concurrently under a 300-second whole-recovery budget. Original reply and timing records are retained. API retry counters and forensic SQL effects are separate observations; per-attempt recovery timestamps were not recorded.',
            'processGone': 'Observed runtime births minus post-teardown survivors, supported by empty private-namespace teardown. Native exit timestamps were not recorded.',
            'callCounters': 'Original measured offers; completed includes settled failures. SQL counters use observation time; call phases use offered time.',
            'comparison': 'Full numeric row revisions and durable columns retained. Analysis version 4 independently checks committed SQL predecessors, all call counts, successful list pages, original mutation replies and update deltas against their committed predecessors; normalization remains version 2.',
            'loopWindow': 'Runtime completedWindow records coverage of the nominal tail. It does not prove an on-time histogram reset. First/last and scheduled timestamps, reset delay, end delay and observed interval are retained. A late callback can exclude early nominal work or include drain work; missing histogram observations are not reconstructed.',
        },
    }
    out.write_text(json.dumps(artifact, indent=2) + '\n')
    text = [
        '### Acceptance matrix with bounded task execution',
        '',
        f"Frozen product revisions: candidate `{manifest['candidate']['sourceRevision']}`, matched main `{manifest['main']['sourceRevision']}`, original audit `{manifest['audit']['sourceRevision']}`.",
        '',
        'Every sample uses 30 seconds warmup and 300 seconds measured load. Revision order alternates candidate/main/audit, audit/main/candidate, candidate/main/audit. The JSON record includes runtime, dependency, seed and observer identities, actual quotas, per-process connection balances, all observations and normalized equivalence checks.',
        '',
        '| Clients / transport / tasks | Candidate p99 / max | Main p99 / max | Audit p99 / max | No loop regression |',
        '|---|---:|---:|---:|---|',
    ]
    fmt = lambda x: f"{x['loopP99']:.6f} / {x['loopMax']:.6f}"
    for c in cohorts:
        text.append('| ' + c['cohort'] + ' | ' + ' | '.join((fmt(c['mediansMs'][s]) if s in c['mediansMs'] else 'incomplete' for s in ['candidate', 'main', 'audit'])) + ' | ' + ('yes' if c['loopNoRegression'] else 'no') + ' |')
    text += [
        '',
        'The following rows retain every repetition. Calls are offered/completed/failed; completed includes settled failures, so successful calls equal completed minus failed. Pending counts are at measurement end/after the 35-second drain/after bounded recovery, before teardown. Processes are peak/observed runtime births/derived gone/survivors; gone is births minus survivors, supported by empty private-namespace teardown. Descriptors are peak adapter/total main-database descriptors. Connections are total main-database opens/explicit closes/reclaimed at process exit across all phases; commits and contention frequency use the measured window.',
        '',
        '| Sample | Loop p99 / max, ms | Loop start/end lateness, ms | Calls | Pending | Processes | Descriptors | Connections | State commits | SQL contention / 10,000 completed | Lease refusals |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ]
    for e in records:
        r = e['report']
        p = r['processes']
        sql = r['sql']
        conn = [c for c in sql['connections'] if c['database'] == 'state.sqlite']
        sums = [sum((c[k] for c in conn)) for k in ['opened', 'closed', 'reclaimedAtExit']]
        boundary = loop_boundaries[e["sample"]]
        cells = [
            e["sample"], fmt(r["viewer"]),
            f"{boundary['startDelayMs']}/{boundary['endDelayMs']}",
            f"{r['offered']}/{r['completed']}/{r['failed']}",
            f"{r['pendingAtEnd']}/{r['pendingAfterDrain']}/{r['pendingAfterReconciliation']}",
            f"{p['peak']}/{p['births']}/{p['births'] - p['survivors']}/{p['survivors']}",
            f"{p['peakAdapterDescriptors']}/{p['peakMainDescriptors']}",
            "/".join(map(str, sums)), str(sql["measuredByDatabase"].get("state.sqlite", {}).get("commit", 0)),
            f"{sql['contentionPer10000Completed']:.3f}", str(sql["heldLeaseRefusals"] + sql["leaseSqlRefusals"]),
        ]
        text.append("| " + " | ".join(cells) + " |")
    text += [
        "",
        "Loop boundary lateness is the observed histogram reset and final sample relative to the scheduled window. "
        "The runtime's completedWindow field checks the nominal tail only. Some controls reset late under load; "
        "their histograms exclude early nominal work or include drain work. The JSON retains every boundary and "
        "observed interval. These reported histogram comparisons retain that limitation; missing histogram observations are not reconstructed.",
        "",
    ]
    pairs = comparisons['pairs']
    rows = sum((p['exactNormalizedRowsEqual'] for p in pairs))
    responses = sum((p['exactNormalizedResponsesEqual'] for p in pairs))
    histories = sum((p['bothHistoriesReconciled'] for p in pairs))
    text += [
        '',
        f"Exact normalized row hashes agree in {rows}/{len(pairs)} pairs; response hashes agree in {responses}/{len(pairs)} pairs. Committed histories reconcile in {histories}/{len(pairs)} pairs. Numeric row revisions, row order, controller flags, receipts and tombstones stay in the comparison. Concurrent commit ordering, shared-task guards and failed calls remain observable; the artifact records each exact mismatch and its own history validation.",
        '',
        '**Acceptance: ' + ('met.' if not failures else 'unmet.') + '**',
        '',
    ]
    text += [
        '',
        '| Candidate/control comparison | Common / before-only / after-only committed keys | Common payload mismatches | Paired original successful mutation replies / mismatches | Differing revision guards | Exact rows / replies |',
        '|---|---:|---:|---:|---:|---|',
    ]
    for p in pairs:
        k = p['committedLogicalKeys']
        text.append(f"| {p['before']} / {p['after']} | {k['common']}/{k['beforeOnly']}/{k['afterOnly']} | {len(p['commonCommittedTaskPayloadMismatchKeys'])} | {p['originalSuccessfulMutationReplyPairs']}/{p['originalSuccessfulMutationReplyMismatches']} | {p['differentRevisionGuardInputs']} | {p['exactNormalizedRowsEqual']} / {p['exactNormalizedResponsesEqual']} |")
    reply_field_differences = {}
    for pair in pairs:
        for field, count in pair.get("originalSuccessfulMutationReplyMismatchFields", {}).items():
            reply_field_differences[field] = reply_field_differences.get(field, 0) + count
    if reply_field_differences:
        text += [
            "Original successful mutation reply field differences across the paired comparisons: `"
            + json.dumps(reply_field_differences, sort_keys=True)
            + "`. Each original successful reply is independently checked against its one committed effect. "
              "A same-key retry can settle first and make the original return a stored reply with replayed=true. "
              "Replay flags and delta differences remain in exact hashes and mismatch counts. Update changedFields and changes must match their own committed predecessor; all remaining paired fields must agree.",
            "",
        ]
    if failures:
        text += ['Recorded acceptance failures: `' + json.dumps(failures, separators=(',', ':')) + '`.', '']
    uncertain = {key: sum((e['originalUncertainDispositions'][key] for e in comparisons['samples'].values())) for key in ['receipt', 'recoveryReply', 'committedEffect', 'noEffectAtTeardown', 'unresolved']}
    text += [
        '',
        'Original uncertain mutation replies include warmup and measured calls; their measured failures and latencies remain in each sample. Final disposition counts: `' + json.dumps(uncertain, sort_keys=True) + '`.',
        '',
        'Recovery retries the original mutation tool with its original arguments and request key, at most 19 concurrently under a 300-second budget. It can admit a previously unexecuted mutation after the measured window. Final-state reconciliation proves each key has at most one effect and agrees with the durable rows after retries and teardown; it does not convert an original failed call into a successful measured reply. The legacy queried field counts retry attempts. Per-attempt recovery timestamps were not recorded.',
        '',
        'Raw SDK tool errors without a boolean ok field are uncertain replies for forensic reconciliation. The frozen recovery classifier did not retry those completed SDK errors. Their SQL effect or absence after teardown is still checked independently. API recovery unknown counts and final unresolved effects remain separate.',
        '',
        'Process counts cover observed fixture runtimes and launchers. All database connection balances, per-process commits, SQLite waits, logical lease refusals and their durations remain in the JSON record. The SQL contention denominator uses completed measured calls; lease refusals are shown separately. Call phases follow offer timestamps, while SQL and HTTP counters follow observation timestamps, so work can cross a window boundary.',
        '',
        'Analysis version 4 retains normalization version 2. The comparer controls and any old-oracle red proofs are retained in the JSON record. Whole-millisecond commit and offer observations in the same bin do not establish ordering; the lower visibility bound requires commit < offer.',
        '',
    ]
    if progress or method.get('excludedInterSampleDiagnostics'):
        text += [
            'Method observations: `' + json.dumps({'progressObserverChange': progress, 'excludedInterSampleDiagnostics': method.get('excludedInterSampleDiagnostics', [])}, sort_keys=True, separators=(',', ':')) + '`.',
            '',
        ]
    markdown.write_text('\n'.join(text))
    print(json.dumps({'samples': len(records), 'pairs': len(pairs), 'accepted': not failures, 'failures': failures}, indent=2))


def main():
    if len(sys.argv) == 5 and sys.argv[1] == "--summarize":
        summarize_matrix(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--verify-comparer":
        verify_comparer(pathlib.Path(sys.argv[2]))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--compare":
        compare_samples(pathlib.Path(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["output", "gate", "observer"]:
        parser.add_argument("--" + name, required=True, type=pathlib.Path)
    for name in ["seed", "capabilities"]:
        parser.add_argument("--" + name, type=pathlib.Path)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--audit", default="45d25ac")
    parser.add_argument("--candidate", default="HEAD")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--clients", nargs="+", type=int, choices=[1, 19, 37], default=[1, 19, 37])
    parser.add_argument("--modes", nargs="+", choices=["stdio-independent", "stdio-shared", "http-independent", "http-shared"],
                        default=["stdio-independent", "stdio-shared", "http-independent", "http-shared"])
    parser.add_argument("--sides", nargs="+", choices=["audit", "main", "candidate"], default=["candidate", "main", "audit"])
    parser.add_argument("--repeats", type=int, choices=[1, 2, 3], default=3)
    args = parser.parse_args()
    if bool(args.seed) != bool(args.capabilities):
        parser.error("supply both --seed and --capabilities, or generate a fresh fixture by omitting both")
    if git("status", "--porcelain"):
        raise RuntimeError("freeze requires a clean source checkout")
    if git("rev-parse", args.candidate) != git("rev-parse", "HEAD"):
        raise RuntimeError("run the harness from the candidate checkout")
    root = args.output.resolve()
    scratch = pathlib.Path(tempfile.gettempdir()).resolve()
    if not root.is_relative_to(scratch) or root == scratch:
        raise RuntimeError("samples require a directory inside the caller's temporary root")
    root.mkdir(parents=True, exist_ok=True)
    runtime = root / "runtime"
    runtime.mkdir(exist_ok=True)
    for name in ["bun", "node"]:
        if not (runtime / name).exists():
            shutil.copy2(shutil.which(name), runtime / name)
    observer = runtime / "observer.so"
    if not observer.exists():
        shutil.copy2(args.observer.resolve(), observer)
    bun = runtime / "bun"
    capabilities = root / "capabilities.json"
    if not capabilities.exists() and args.capabilities:
        shutil.copy2(args.capabilities.resolve(), capabilities)
    dependencies = root / "node_modules"
    if not dependencies.exists():
        preparing = pathlib.Path(tempfile.mkdtemp(prefix="dependencies-", dir=root))
        shutil.copytree(REPO / "node_modules", preparing / "node_modules", symlinks=True,
                        ignore=shutil.ignore_patterns(".cache"))
        (preparing / "node_modules").rename(dependencies)
        preparing.rmdir()
    dependency_hash_file = root / "dependencies.sha256"
    if not dependency_hash_file.exists():
        dependency_hash = hashlib.sha256()
        for filename in sorted(dependencies.rglob("*")):
            if filename.is_symlink():
                dependency_hash.update(str(filename.relative_to(dependencies)).encode())
                dependency_hash.update(os.readlink(filename).encode())
            elif filename.is_file():
                dependency_hash.update(str(filename.relative_to(dependencies)).encode())
                dependency_hash.update(digest(filename).encode())
        dependency_hash_file.write_text(dependency_hash.hexdigest())
    seed = root / "seed"
    if not seed.exists():
        if args.seed:
            shutil.copytree(args.seed.resolve(), seed)
        else:
            seed_env = environment(root / "seed-setup")
            seed_env.update(MCP_BENCH_CHILD="seed", MCP_BENCH_READY=str(capabilities))
            seed_env["PATH"] = str(runtime) + os.pathsep + seed_env["PATH"]
            run(args.gate, [str(bun), "src/lib/mcp/writerConcurrencyChild.ts"], REPO, seed_env, root / "seed.log")
            shutil.copytree(seed_env["LLV_STATE_DIR"], seed)
    checksum = hashlib.sha256()
    for filename in sorted(seed.rglob("*")):
        if filename.is_file():
            checksum.update(str(pathlib.Path("LLV_STATE_DIR") / filename.relative_to(seed)).encode())
            checksum.update(filename.read_bytes())
    seed_hash = checksum.hexdigest()
    head = git("rev-parse", args.candidate)
    exports = {}
    for side, ref in [("audit", args.audit), ("main", args.baseline), ("candidate", head)]:
        revision = git("rev-parse", ref)
        target = root / side
        manifest_path = root / (side + ".manifest.json")
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            if manifest["sourceRevision"] != revision or manifest["harnessRevision"] != head:
                raise RuntimeError("resume cannot replace an immutable export")
        else:
            target.mkdir()
            archive = root / (side + ".tar")
            with archive.open("wb") as output:
                subprocess.run(["git", "archive", revision], cwd=REPO, stdout=output, check=True)
            subprocess.run(["tar", "-xf", str(archive), "-C", str(target)], check=True)
            for filename in HARNESS:
                shutil.copy2(REPO / filename, target / filename)
            (target / "node_modules").symlink_to(dependencies, target_is_directory=True)
            manifest = {"sourceRevision": revision, "sourceArchiveSha256": digest(archive),
                        "harnessRevision": head, "harnessFiles": {f: digest(REPO / f) for f in HARNESS},
                        "observerSha256": digest(observer), "bunVersion": subprocess.check_output([str(bun), "--version"], text=True).strip(),
                        "bunSha256": digest(bun), "nodeVersion": subprocess.check_output([str(runtime / "node"), "--version"], text=True).strip(),
                        "nodeSha256": digest(runtime / "node"), "pythonVersion": platform.python_version(),
                        "dependencyLockSha256": digest(REPO / "bun.lock"), "capabilitiesFileSha256": digest(capabilities),
                        "dependencySnapshotSha256": dependency_hash_file.read_text(),
                        "kernel": platform.release(), "quotaHierarchyLeafFirst": quotas(), "seedSha256": seed_hash}
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        exports[side] = (target, manifest)
    records = []
    # Each repeat reverses the order, including the original audit control.
    for clients in args.clients:
        for scenario in args.modes:
            mode, sharing = scenario.split("-")
            shared = sharing == "shared"
            for repeat in range(1 if args.smoke else args.repeats):
                for side in (args.sides if repeat % 2 == 0 else list(reversed(args.sides))):
                    sample = root / f"{side}-{clients}-{mode}-{'shared' if shared else 'independent'}-{repeat + 1}"
                    target, manifest = exports[side]
                    if (sample / "report.json").exists():
                        recorded = json.loads((sample / "manifest.json").read_text())
                        bounds = json.loads((sample / "boundaries.json").read_text())
                        expected = {"clients": clients, "mode": mode, "shared": shared,
                                    "warmSeconds": 1 if args.smoke else 30,
                                    "seconds": 10 if args.smoke else 300}
                        if recorded.get("smoke") != args.smoke or any(bounds.get(key) != value for key, value in expected.items()):
                            raise RuntimeError("resume cannot mix smoke and acceptance windows or replace sample parameters")
                    if not (sample / "report.json").exists():
                        if sample.exists():
                            raise RuntimeError(f"partial sample retained: {sample.name}; choose a new output directory")
                        sample.mkdir()
                        env = environment(sample / "controller")
                        env["PATH"] = str(runtime) + os.pathsep + env["PATH"]
                        env.update(MCP_BENCH_OUTPUT=str(sample), MCP_BENCH_SEED=str(seed),
                                   MCP_BENCH_SCRATCH_ROOT=str(scratch),
                                   MCP_BENCH_CAPABILITIES=str(capabilities), MCP_BENCH_SEED_CHECKSUM=seed_hash,
                                   MCP_SQL_OBSERVER=str(observer), MCP_BENCH_CLIENTS=str(clients),
                                   MCP_BENCH_TRANSPORT=mode, MCP_BENCH_SHARED="1" if shared else "0",
                                   MCP_BENCH_HOST_NAMESPACE=os.readlink("/proc/self/ns/pid"))
                        if args.smoke:
                            env.update(MCP_BENCH_WARM_SECONDS="1", MCP_BENCH_SECONDS="10")
                        sample_manifest = {**manifest, "clients": clients, "transport": mode, "shared": shared,
                                           "repeat": repeat + 1, "startedAt": time.time(), "smoke": args.smoke}
                        (sample / "manifest.json").write_text(json.dumps(sample_manifest, indent=2) + "\n")
                        command = ["unshare", "--user", f"--map-user={os.getuid()}", f"--map-group={os.getgid()}",
                                   "--pid", "--fork", "--kill-child", "--mount-proc", "sh", "-c", '"$@"; exit $?', "sh",
                                   str(bun), "scripts/mcp-call-cost-benchmark.ts", "--state-writer-sample"]
                        print("START", sample.name, flush=True)
                        run(args.gate, command, target, env, sample / "run.log")
                        run(args.gate, [str(bun), "scripts/mcp-call-cost-benchmark.ts", "--state-writer-report", str(sample)],
                            target, environment(sample / "analysis"), sample / "report-output.log")
                        (sample / "report.json").write_text((sample / "report-output.log").read_text())
                    records.append({"sample": sample.name, "manifest": json.loads((sample / "manifest.json").read_text()),
                                    "report": json.loads((sample / "report.json").read_text())})
                    (root / "matrix.json").write_text(json.dumps({"samples": records}, indent=2) + "\n")
                    print("COMPLETE", sample.name, flush=True)


if __name__ == "__main__":
    main()
