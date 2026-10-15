"""Replay immutable product revisions through the existing state-writer driver.

Each sample takes its own owned-runner admission. Interrupted samples stay on
disk; rerunning the same command resumes only samples with complete reports.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import sqlite3
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
    pending, transactions, effects = {}, [], {}
    literals = sqlite3.connect(":memory:")
    with (sample / "sql.ndjson").open() as source:
        for line in source:
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
                if call.startswith(("create_task:", "update_task:")):
                    entry = effects.setdefault(call, {"commits": 0, "rows": []})
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
    return {"transactions": len(transactions), "effects": effects, "replayMatchesFinalRows": rows == actual,
            "replayedRowSha256": checksum_json(rows), "finalRowSha256": checksum_json(actual)}


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
    results = {}
    for sample in sorted(root.iterdir()):
        if not (sample / "report.json").exists():
            continue
        calls = json.loads((sample / "calls.json").read_text())
        rows = [{**row, "value_json": json.loads(row["value_json"])}
                for row in json.loads((sample / "final-rows.json").read_text())]
        seed = {key: {field: row[field] for field in rows[0]} for key, row in full_seed.items()}
        manifest = json.loads((sample / "manifest.json").read_text())
        by_key = {(row["collection"], row["row_key"]): row for row in rows}
        replacements, violations, creates, updates = {}, [], {}, {}
        final_receipts = {}
        history = committed_history(root, sample)
        if not history["replayMatchesFinalRows"]:
            violations.append("committed SQL history differs from final durable rows")
        if (sample / "final-receipts.json").exists():
            for receipt in json.loads((sample / "final-receipts.json").read_text()):
                if receipt["result_json"]:
                    result = json.loads(receipt["result_json"])
                    if isinstance(result, dict) and result.get("clientRequestId"):
                        final_receipts[(result.get("toolName"), result["clientRequestId"])] = result
        effective = []
        unresolved = 0
        unknown_replies = 0
        resolved_committed = 0
        resolved_no_commit = 0
        for call in calls:
            name, args = call["name"], call["args"]
            key = args.get("clientRequestId")
            answer = final_receipts.get((name, key), call.get("reconciled", call.get("result")))
            effective.append(answer)
            if name == "list_tasks":
                if isinstance(answer, dict) and answer.get("ok"):
                    tasks = answer.get("tasks", [])
                    if len(tasks) != len({task["id"] for task in tasks}):
                        violations.append("duplicate task in a list response")
                continue
            uncertain = not isinstance(answer, dict) or answer.get("code") in ["outcome_unknown", "request_in_progress"] or "transportError" in answer
            effect = history["effects"].get(name + ":" + str(key))
            if effect and (effect["commits"] != 1 or len(effect["rows"]) != 1):
                violations.append("one mutation key committed more than one task effect")
            committed_task = json.loads(effect["rows"][0]["value_json"]) if effect and len(effect["rows"]) == 1 else None
            if isinstance(answer, dict) and answer.get("ok"):
                if not committed_task or answer.get("taskId") != committed_task["id"] or answer.get("revision") != committed_task["revision"]:
                    violations.append("a successful reply differs from its committed task effect")
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
                return {key: normalize(item) for key, item in value.items()}
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

        normalized_rows = sorted(normalize(rows), key=lambda row: (row["collection"], row["row_key"]))
        responses = normalize([{key: call.get(key) for key in ["client", "index", "phase", "ok", "result"]} for call in calls])
        settled = normalize(effective)
        results[sample.name] = {"rows": len(rows), "responses": len(calls), "normalizedRowSha256": checksum_json(normalized_rows),
                                "normalizedResponseSha256": checksum_json(responses), "settledResponseSha256": checksum_json(settled),
                                "numericRowRevisionsRetained": True, "durableColumns": sorted(rows[0]), "unresolvedMutations": unresolved,
                                "unknownMutationRepliesAtReconciliation": unknown_replies, "unknownRepliesWithCommittedEffect": resolved_committed,
                                "unknownRepliesWithNoCommitAtTeardown": resolved_no_commit,
                                "committedHistoryReplayMatchesFinalRows": history["replayMatchesFinalRows"],
                                "committedRowTransactions": history["transactions"],
                                "replayedRowSha256": history["replayedRowSha256"], "finalRowSha256": history["finalRowSha256"],
                                "committedCreates": len(creates), "committedUpdates": len(updates), "createReceipts": len(actual_receipts),
                                "historyViolations": {reason: violations.count(reason) for reason in sorted(set(violations))}}
        (sample / "equivalence.json").write_text(json.dumps(results[sample.name], indent=2) + "\n")
    pairs = []
    for name, candidate in results.items():
        if not name.startswith("candidate-"):
            continue
        for side in ["audit", "main"]:
            peer = side + name[len("candidate"):]
            if peer in results:
                pairs.append({"before": peer, "after": name,
                              "exactNormalizedRowsEqual": results[peer]["normalizedRowSha256"] == candidate["normalizedRowSha256"],
                              "exactNormalizedResponsesEqual": results[peer]["normalizedResponseSha256"] == candidate["normalizedResponseSha256"],
                              "bothHistoriesReconciled": not any(results[key]["unresolvedMutations"] or results[key]["historyViolations"] for key in [peer, name])})
    result = {"normalization": "Generated task IDs and revision tokens by original mutation key; sample ISO times except the fixed seed instant. Numeric SQL row revisions and every other field retained.",
              "samples": results, "pairs": pairs}
    (root / "comparisons.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"samples": len(results), "pairs": len(pairs), "reconciled": sum(pair["bothHistoriesReconciled"] for pair in pairs)}, indent=2))


def main():
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
    parser.add_argument("--sides", nargs="+", choices=["audit", "main", "candidate"], default=["audit", "main", "candidate"])
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
