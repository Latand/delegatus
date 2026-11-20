"""Detached, observable checkout switch. Importing this module performs no I/O."""
import argparse
import contextlib
import datetime
import hashlib
import json
import os
import pathlib
import re
import select
import shlex
import signal
import socket
import sqlite3
import stat as stat_mode
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid


CPU_SLICE = "delegatus.slice"
CPU_WEIGHT = "1000"


def census_identity(value):
    return (isinstance(value, dict) and type(value.get("pid")) is int and value["pid"] > 0
            and isinstance(value.get("startIdentity"), str) and bool(value["startIdentity"])
            and (value.get("bootEpoch") is None or isinstance(value["bootEpoch"], str)))


class BaselineReadinessError(RuntimeError):
    def __init__(self, serving, target):
        checks = serving.get("checks", {})
        failed = {name for name in ["http", "runtimeSocket", "mcp", "service"]
                  if checks.get(name) is not True}
        # ready() also requires every serving process to report the reviewed
        # baseline SHA and healthy state. Attribute those failures to the
        # corresponding public readiness check so the refusal stays useful.
        for role, name in [("viewer", "http"), ("runtimeHost", "runtimeSocket"), ("launcher", "service")]:
            process = serving.get(role, {})
            if process.get("sha") != target or process.get("healthy") is not True:
                failed.add(name)
        self.checks = [name for name in ["http", "runtimeSocket", "mcp", "service"] if name in failed]
        super().__init__("baseline serving health unavailable")


class SwitchRefused(RuntimeError):
    """A fixed, publishable admission refusal."""


def census_environment(state):
    # The census needs filesystem and interpreter settings only. An allowlist
    # also excludes credentials whose names do not contain "token" or "secret".
    allowed = {"PATH", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
               "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ",
               "SYSTEMROOT", "WINDIR", "LD_LIBRARY_PATH"}
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment["LLV_STATE_DIR"] = str(state)
    environment["LLV_VIEWER_CONTROL_URL"] = "http://127.0.0.1:1"
    return environment


def protected_host_census(release, bun, state, target, timeout):
    """One owned child, bounded by the capture's remaining wall-clock allowance."""
    if not 0 < timeout <= 30:
        raise RuntimeError("census deadline")
    deadline = time.monotonic() + timeout
    child = subprocess.Popen([bun, "--no-env-file", str(release / "scripts/protected-host-census.ts"), target,
                              str(max(0, int(timeout * 1000)))], cwd=release,
                             env=census_environment(state), stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    data = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("census deadline")
            if not select.select([child.stdout], [], [], remaining)[0]:
                raise RuntimeError("census deadline")
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 4 * 1024 * 1024:
                raise RuntimeError("census output oversized")
        if child.wait(timeout=max(0, deadline - time.monotonic())) != 0:
            raise RuntimeError("census unavailable")
        answer = json.loads(data)
        if (not isinstance(answer, dict) or answer.get("targetRevision") != target
                or not isinstance(answer.get("conversations"), list)
                or type(answer.get("registryRevision")) is not int or answer["registryRevision"] < 0
                or not isinstance(answer.get("observedAt"), str) or not answer["observedAt"]
                or not isinstance(answer.get("selection"), dict)):
            raise RuntimeError("census output malformed")
        selection = answer["selection"]
        for key in ["matched", "selected", "recoveryPending", "projected", "unreadable"]:
            if type(selection.get(key)) is not int or selection[key] < 0:
                raise RuntimeError("census output malformed")
        if (type(selection.get("recoveryTruncated")) is not bool
                or selection.get("cacheStatus") not in ["hit", "miss", "pending", "stale"]
                or type(answer.get("unselectedCount")) is not int or answer["unselectedCount"] < 0
                or type(answer.get("undescribedHostCount")) is not int or answer["undescribedHostCount"] < 0
                or selection["selected"] != len(answer["conversations"])):
            raise RuntimeError("census output malformed")
        for row in answer["conversations"]:
            if (not isinstance(row, dict) or "pipeline" not in row
                    or not isinstance(row.get("host"), dict)):
                raise RuntimeError("census row malformed")
            host, pipeline = row["host"], row.get("pipeline")
            if (host.get("state") not in ["alive", "gone", "unknown"]
                    or host.get("kind") not in ["structured", "tmux", "headless", "none"]
                    or (host.get("state") == "alive" and (type(host.get("pid")) is not int or host["pid"] <= 0))
                    or row.get("turnState") not in ["busy", "idle", "unknown"]
                    or row.get("evidenceSource") not in ["transcript", "projection", "unreadable"]
                    or (row.get("conversationId") is not None and not isinstance(row["conversationId"], str))
                    or (pipeline is not None and (not isinstance(pipeline, dict)
                        or not all(isinstance(pipeline.get(key), str) and pipeline[key] for key in ["pipelineId", "stageId"])
                        or type(pipeline.get("attempt")) is not int or pipeline["attempt"] < 1))):
                raise RuntimeError("census row malformed")
            process, writer = host.get("process"), host.get("exitWriter")
            if ((process is not None and (not census_identity(process) or process["pid"] != host.get("pid")))
                    or (writer is not None and (not isinstance(writer, dict)
                        or not census_identity(writer.get("process"))
                        or not isinstance(writer.get("exitFile"), str) or not os.path.isabs(writer["exitFile"])))):
                raise RuntimeError("census row malformed")
        return answer
    finally:
        # Kill the process group even when the leader exited with a pipe held by
        # a descendant. Only this child's newly-created session is owned here.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        child.stdout.close()


class Clock:
    now = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)

    @staticmethod
    def process_since(identity):
        boot = next(line.split()[1] for line in pathlib.Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
        seconds = int(boot) + int(identity) / os.sysconf("SC_CLK_TCK")
        return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()


def retry(read, clock, timeout):
    """Every transport has its own call timeout as well as this readiness bound."""
    deadline = clock.now() + timeout
    while True:
        try:
            return read()
        except Exception:
            if clock.now() >= deadline:
                raise
            clock.sleep(min(1, deadline - clock.now()))


def process_or_gone(adapter, entry):
    try:
        return adapter.process(entry)
    except (FileNotFoundError, ProcessLookupError):
        return None


def ready(serving, target, placement=True):
    """The baseline is read with placement=False: putting the service into its
    configured slice is what a restart does, so only the replacement owes it."""
    return all(serving.get(role, {}).get("sha") == target
               and serving.get(role, {}).get("healthy") is True
               for role in ["launcher", "viewer", "runtimeHost"]) and all(
                   passed for name, passed in serving.get("checks", {}).items() if placement or name != "placement")


def run_switch(adapter, target, samples=21, interval=15, timeout=180):
    old, hosts = adapter.preflight()
    if getattr(adapter, "switch_mode", None) == "relaunch":
        result = observe_switch(adapter, target, samples, interval, timeout, old, hosts)
        adapter.emit(result)
        return result
    # Keep termination deferred through recovery and the final cleanup, too.
    with deferred_termination():
        result = None
        try:
            result = observe_switch(adapter, target, samples, interval, timeout, old, hosts)
        finally:
            relocation = getattr(adapter, "relocation", None)
            if relocation and relocation["stopSubmitted"]:
                attempts = relocation["startAttempts"]
                pending = None
                # The detached worker owns the start until the same unit is
                # active with no queued job. Each batch remains bounded; a
                # refused final batch cannot discharge that obligation.
                while True:
                    try:
                        adapter.recover_start(attempts=START_ATTEMPTS)
                    except Exception as error:
                        relocation["started"] = False
                        relocation["outcome"] = "start-failed"
                        diagnostic = "exit-recovery:" + type(error).__name__
                        if diagnostic not in relocation["diagnostics"]:
                            relocation["diagnostics"].append(diagnostic)
                    if relocation["started"]:
                        break
                    pending = {"state": "pending", "ownerPid": os.getpid(), "unit": adapter.unit}
                    # Report failure while recovery is outstanding, even if
                    # observation raised or evidence publication itself fails.
                    with contextlib.suppress(Exception):
                        adapter.emit({**(result or {"serving": {}, "diagnostics": []}),
                                      "verdict": "fail", "relocation": relocation, "recovery": pending})
                    adapter.clock.sleep(5)
                if pending:
                    completed = {**pending, "state": "complete"}
                    if result is not None:
                        result["recovery"] = completed
                    else:
                        with contextlib.suppress(Exception):
                            adapter.emit({"verdict": "fail", "target": target, "serving": {},
                                          "diagnostics": ["exit-recovery:health-unverified"],
                                          "relocation": relocation, "recovery": completed})
                if result is not None and (pending or relocation["startAttempts"] != attempts):
                    # The last health sample predates this recovery operation.
                    result["verdict"] = "fail"
                    result["diagnostics"].append("exit-recovery:health-unverified")
        adapter.emit(result)
        return result


def observe_switch(adapter, target, samples, interval, timeout, old, hosts):
    in_place = getattr(adapter, "switch_mode", None) == "relaunch"
    if in_place:
        old, hosts = adapter.capture_relaunch(hosts)
    started = utc()
    diagnostics = []
    serving = {}
    protected = []
    relocation = None
    # Even a publication call which raises after its atomic rename owes samples.
    try:
        if in_place:
            adapter.relaunch(old)
        else:
            adapter.publish()
            relocation = adapter.restart()
    except SwitchRefused as error:
        diagnostics.append(str(error))
        if in_place:
            adapter.relaunch_evidence["result"] = "refused"
    except Exception as error:
        diagnostics.append(type(error).__name__)
        if in_place:
            adapter.relaunch_evidence["custodyUnknown"] = True
    finally:
        # A restart that raised after stopping still recorded what it did.
        relocation = relocation or getattr(adapter, "relocation", None)
        for index in range(samples):
            if index:
                adapter.clock.sleep(interval)
            try:
                for entry in old:
                    process_or_gone(adapter, entry)
            except Exception as error:
                diagnostics.append(type(error).__name__)
            protected = []
            for host in hosts:
                try:
                    if host.get("startIdentity") and process_or_gone(adapter, host) is not None:
                        outcome = {"outcome": "preserved", "pipelineId": host.get("pipelineId"),
                                   "stageId": host.get("stageId"), "attempt": host.get("attempt")}
                    else:
                        outcome = retry(lambda: adapter.stage(host), adapter.clock, timeout)
                    protected.append(outcome)
                except Exception as error:
                    protected.append({"outcome": "unknown", "pipelineId": host.get("pipelineId"),
                                      "stageId": host.get("stageId"), "attempt": host.get("attempt")})
                    diagnostics.append(type(error).__name__)
            # Serving is sampled after potentially slow recovery reads, so the
            # final verdict cannot quote a serving observation from before them.
            serving = {}
            def read_serving():
                nonlocal serving
                if relocation and relocation["stopSubmitted"]:
                    adapter.recover_start()
                serving = adapter.serving()
                if not ready(serving, target):
                    raise RuntimeError("replacement not ready")
                return serving
            try:
                if in_place and adapter.relaunch_evidence["result"] != "done":
                    serving = adapter.serving()
                else:
                    retry(read_serving, adapter.clock, timeout)
            except Exception as error:
                diagnostics.append(type(error).__name__)
            if in_place:
                adapter.poll_relaunch_unit()
            try:
                adapter.emit({"sample": index + 1, "serving": serving, "protected": protected})
            except Exception as error:
                diagnostics.append("sample-log:" + type(error).__name__)
    # Read once the samples are over: the booting Viewer records its cuts
    # before it re-hosts anything, long before the last sample. A list read
    # with gaps names them in `interruptedUnreadable`; a list that could not be
    # read at all is null. Either leaves the inventory unknown, which the seat
    # has to look at, so the switch cannot pass on it.
    try:
        interrupted, unreadable = adapter.interrupted(started, hosts)
    except Exception as error:
        interrupted, unreadable = None, ["interrupted:" + type(error).__name__]
        diagnostics.append(unreadable[0])
    healthy = ready(serving, target)
    outcomes = {entry["outcome"] for entry in protected}
    unknown = "unknown" in outcomes or interrupted is None or bool(unreadable)
    relaunch = None
    if in_place:
        relaunch = adapter.finish_relaunch(hosts, protected)
        switch_failed = (relaunch["result"] in {"rolled-back", "fell-back", "refused", "request-refused"}
                         or relaunch["unitLeftActive"] or relaunch["scopeStopped"]
                         or relaunch["custodyChanged"] or bool(relaunch["generationSurvivors"]))
        switch_unknown = relaunch["result"] != "done" or relaunch["unitUnknown"] or relaunch["custodyUnknown"]
    else:
        switch_failed = not (relocation is not None and relocation.get("released") is True
                             and relocation.get("placement") == "placed" and relocation.get("started") is True)
        switch_unknown = False
    if switch_failed or "lost" in outcomes:
        verdict = "fail"
    elif switch_unknown:
        verdict = "needs_decision"
    elif not healthy:
        verdict = "fail"
    else:
        verdict = "needs_decision" if unknown else "pass"
    result = {"verdict": verdict, "target": target, "serving": serving,
              "protected": protected, "interrupted": interrupted,
              "interruptedUnreadable": unreadable, "relocation": relocation,
              "relaunch": relaunch, "diagnostics": diagnostics}
    adapter.last_result = result
    return result


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def parse_time(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


OBLIGATION_STATES = {"owed", "submitted", "delivered", "discharged", "failed"}


def text(value):
    return isinstance(value, str) and bool(value)


def count(value):
    return isinstance(value, int) and not isinstance(value, bool)


def obligation_flaw(record):
    """The first field that keeps a record from naming the conversation it cut,
    or None. The fields are the ones the Viewer itself requires before it acts
    on a record, with the stage and checkpoint shapes the inventory reports."""
    if record.get("version") != 1:
        return "version"
    for field in ["conversationId", "hostKey", "path"]:
        if not text(record.get(field)):
            return field
    if record.get("engine") not in ["claude", "codex"]:
        return "engine"
    if record.get("reason") not in ["viewer-release", "viewer-restart"]:
        return "reason"
    if record.get("state") not in OBLIGATION_STATES:
        return "state"
    if not (record.get("resolution") is None or isinstance(record["resolution"], str)):
        return "resolution"
    stage = record.get("stage")
    if stage is not None and not (isinstance(stage, dict) and text(stage.get("pipelineId"))
                                  and (stage.get("stageId") is None or text(stage["stageId"]))
                                  and (stage.get("attempt") is None or count(stage["attempt"]))):
        return "stage"
    checkpoint = record.get("checkpoint")
    tasks = checkpoint.get("backgroundTasks", []) if isinstance(checkpoint, dict) else None
    if not (isinstance(tasks, list) and all(text(task) for task in tasks)):
        return "checkpoint"
    return None


PENDING_JOURNAL = "interruption-obligations.pending.jsonl"
# Inventory reads before the records are reported as still moving. An import
# holds its claim for milliseconds, so a quiet read comes within a few.
INVENTORY_ROUNDS = 5


def read_journal(path, records, unreadable):
    """Adds the records of one pending journal, each id once. A journal gone
    by the read moved elsewhere; the round that read it says so by its places."""
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        return
    except OSError as error:
        unreadable.append(path.name + ":" + type(error).__name__)
        return
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            record = None
        if not isinstance(record, dict) or not isinstance(record.get("id"), str):
            unreadable.append(path.name + ":" + str(number))
            continue
        records.setdefault(record["id"], record)


def file_identity(path):
    try:
        status = os.stat(path)
    except FileNotFoundError:
        return None
    return status.st_ino, status.st_size, status.st_mtime_ns


def optional_json(path):
    try:
        value = json.loads(path.read_bytes())
    except FileNotFoundError:
        return None
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def path_present(path):
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def obligation_places(directory, pending):
    """Every place a record can be, by what would change if one moved: the
    pending journal and each import claim by file identity, the record
    directory by its names, or the sealed source by its marker and database
    identity. A rename, append, publication or deleted claim changes one."""
    try:
        beside = sorted(os.listdir(directory.parent))
    except FileNotFoundError:
        beside = []
    claims = tuple((name, file_identity(directory.parent / name))
                   for name in beside if name.startswith(PENDING_JOURNAL + ".claim-"))
    if directory.is_file():
        database = directory.parent / "state.sqlite"
        status = database.stat()
        names = (file_identity(directory), (status.st_dev, status.st_ino))
    else:
        names = tuple(sorted(os.listdir(directory))) if os.path.lexists(directory) else ()
    return file_identity(pending), claims, names


def read_sqlite_obligations(directory, unreadable):
    """Reads the canonical source without migrating, repairing or opening a writer."""
    try:
        marker = json.loads(directory.read_text())
    except (OSError, ValueError) as error:
        raise OSError("canonical cut source is unreadable") from error
    try:
        database = directory.parent / "state.sqlite"
        status = database.stat()
        collection = "interruption_obligations:" + directory.name
        if (not isinstance(marker, dict) or marker.get("format") != "interruption-sqlite-v2"
                or marker.get("collection") != collection or not isinstance(marker.get("epoch"), str)
                or marker.get("databaseIdentity") != str(status.st_dev) + ":" + str(status.st_ino)):
            raise ValueError("incompatible cut source")
        with contextlib.closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0)) as db:
            db.execute("BEGIN")
            meta = db.execute("SELECT schema_version,migration_id FROM state_collections WHERE collection=?", (collection,)).fetchone()
            if meta != (2, "interruption-source-v2"):
                raise ValueError("incomplete cut collection")
            records = {}
            for key, payload in db.execute("SELECT row_key,value_json FROM state_rows WHERE collection=? ORDER BY row_order,row_key", (collection,)):
                try:
                    record = json.loads(payload)
                    if not isinstance(record, dict) or record.get("id") != key:
                        raise ValueError("incompatible cut row")
                    records[key] = record
                except (ValueError, TypeError):
                    unreadable.append(key + ":shape")
            return records
    except (OSError, ValueError, sqlite3.Error) as error:
        unreadable.append(directory.name + ":" + type(error).__name__)
        return {}


def read_obligations(directory, pending, claims):
    journaled = {}
    unreadable = []
    read_journal(pending, journaled, unreadable)
    for name in claims:
        read_journal(directory.parent / name, journaled, unreadable)
    records = read_sqlite_obligations(directory, unreadable) if directory.is_file() else {}
    if not directory.is_file() and directory.with_name(directory.name + ".source.json").exists():
        unreadable.append(directory.name + ":incomplete")
    names = sorted(os.listdir(directory)) if directory.is_dir() else []
    for name in names:
        if not (name.startswith("interruption-continuation-") and name.endswith(".json")):
            continue
        try:
            record = json.loads((directory / name).read_text())
        except (OSError, ValueError) as error:
            unreadable.append(name + ":" + type(error).__name__)
            continue
        if not isinstance(record, dict) or not isinstance(record.get("id"), str):
            unreadable.append(name + ":shape")
            continue
        records[record["id"]] = record
    for identifier, record in journaled.items():
        records.setdefault(identifier, record)
    return records, unreadable


def interrupted_conversations(state, since, hosts=()):
    """The conversations whose turn this switch cut, as the Viewers recorded
    them: an incumbent at release, the booting successor at restart, and the
    records it could not read or that are too incomplete to name a
    conversation. Each conversation names its pipeline stage when it ran one;
    a stage the preflight protected names it from that capture when the record
    does not. A state with no record directory recorded no cut.

    A record can wait in the pending journal, and an import takes that journal
    by renaming it to a claim beside it, writes its records into the
    canonical source, returns refused records to the journal and only then
    deletes the claim. A sealed SQLite source is read in one read-only snapshot;
    its marker and database identity join the same journal-movement inventory.
    Unrelated collection writes cannot invalidate that coherent cut snapshot. A later import takes over a claim one died holding
    by renaming it to a claim of its own. A record can therefore move while it
    is read, so a read counts only when every place it can be is unchanged
    across it. A read that never finds them still is reported as unreadable,
    which leaves the inventory unknown."""
    directory = pathlib.Path(state) / "interruption-obligations"
    pending = directory.with_name(PENDING_JOURNAL)
    for round_number in range(INVENTORY_ROUNDS):
        if round_number:
            time.sleep(0.05 * round_number)
        before = obligation_places(directory, pending)
        records, unreadable = read_obligations(directory, pending, [name for name, _ in before[1]])
        if obligation_places(directory, pending) == before:
            break
    else:
        unreadable.append("interruption-obligations:moving")
    unreadable = list(dict.fromkeys(unreadable))
    boundary = parse_time(since)
    protected = {host.get("conversationId"): host for host in hosts if host.get("conversationId")}
    listed = []
    for record in records.values():
        try:
            if parse_time(record["recordedAt"]) < boundary:
                continue
        except (KeyError, TypeError, ValueError, AttributeError):
            unreadable.append(record["id"] + ":recordedAt")
            continue
        flaw = obligation_flaw(record)
        if flaw:
            unreadable.append(record["id"] + ":" + flaw)
            continue
        conversation = record["conversationId"]
        stage = record.get("stage")
        host = protected.get(conversation)
        if not stage and host:
            stage = {"pipelineId": host.get("pipelineId"), "stageId": host.get("stageId"), "attempt": host.get("attempt")}
        listed.append({"conversationId": conversation, "recordedAt": record["recordedAt"],
                       "reason": record["reason"], "state": record["state"],
                       "resolution": record.get("resolution"), "stage": stage or None,
                       "backgroundTasks": record["checkpoint"].get("backgroundTasks", [])})
    return sorted(listed, key=lambda entry: (entry["recordedAt"], entry["conversationId"])), unreadable


def write_json(destination, body, *, exclusive=False):
    """Private atomic results remain readable if the launching turn disappears."""
    destination = pathlib.Path(destination)
    fd, name = tempfile.mkstemp(prefix=".deploy-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(body, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            os.link(name, destination)
        else:
            os.replace(name, destination)
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def proc_field(pid, field, root="/proc"):
    proc = pathlib.Path(root) / str(pid)
    if field == "cwd":
        return os.readlink(proc / field)
    if field == "cmdline":
        return (proc / field).read_bytes()
    if field == "fds":
        descriptors = []
        for index, entry in enumerate((proc / "fd").iterdir()):
            if index >= 64:
                raise RuntimeError("process descriptor table exceeds its bound")
            try:
                info = entry.stat()
            except FileNotFoundError:
                continue
            descriptors.append((int(entry.name), info.st_dev, info.st_ino, stat_mode.S_ISFIFO(info.st_mode)))
        return descriptors
    return (proc / field).read_text()


def start_identity(stat):
    return stat[stat.rfind(")") + 2:].split()[19]


def read_process(entry, read=proc_field):
    """ENOENT at any point means gone. Reused PIDs never prove preservation."""
    try:
        pid = entry["pid"]
        if not isinstance(pid, int) or pid <= 0:
            return None
        identity = start_identity(read(pid, "stat"))
        expected = entry.get("startIdentity")
        if expected is not None and identity != expected:
            return None
        args = read(pid, "cmdline").decode().split("\0")
        cwd = read(pid, "cwd")
        if start_identity(read(pid, "stat")) != identity:
            return None
        return {"pid": pid, "startIdentity": identity, "args": args, "cwd": cwd}
    except (FileNotFoundError, ProcessLookupError):
        return None


def pidfd_signal(entry, signum, group, read=proc_field):
    """Signals exactly one process. The descriptor is opened first and the
    start identity and cgroup are read through /proc afterwards, so a PID
    reused before the open fails the identity check and one reused after it
    cannot be reached through the descriptor. False means the PID no longer
    names that process in that cgroup; nothing was signalled."""
    pid = entry["pid"]
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return False
    try:
        if (start_identity(read(pid, "stat")) != entry["startIdentity"]
                or not within(kernel_cgroup(read(pid, "cgroup")), group)):
            return False
        signal.pidfd_send_signal(descriptor, signum)
        return True
    except (FileNotFoundError, ProcessLookupError):
        return False
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def deferred_termination():
    """Holds SIGTERM, SIGHUP and SIGINT while the service may be stopped, so stopping
    the worker's own unit cannot cut between the stop and the start. A held
    signal is delivered once the start has run. SIGKILL cannot be held."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    held = []
    previous = {signum: signal.signal(signum, lambda number, frame: held.append(number))
                for signum in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]}
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        for signum in dict.fromkeys(held):
            os.kill(os.getpid(), signum)


# The relocation's bounds. Release waits for the launcher to retire its
# generation (three seconds, then terminate and kill) and for systemd to prune
# the emptied cgroup; each signal round waits for its survivors to exit.
RELEASE_WAIT = 30
SIGNAL_WAIT = 5
STOP_SETTLE = 300
START_ATTEMPTS = 3
RELAUNCH_PROTOCOL = "delegatus-launcher-relaunch-v1"
CHECKOUT_HANDOFF = "delegatus-checkout-launcher-v2"
REQUEST_WAIT = 120
# bin/launcher-deadline.mjs exports 10-minute switch and rollback bounds.
SWITCH_TIMEOUT = 600
ROLLBACK_TIMEOUT = 600
RELAUNCH_SETTLE = 60
UNIT_FENCE_PROPERTIES = ("ActiveState", "MainPID", "NRestarts", "InvocationID",
                         "InactiveEnterTimestampMonotonic")


class LeftoverProcesses(RuntimeError):
    """The service cgroup holds processes that are neither agents nor the
    serving generation. KillMode=process spares them at the restart, and while
    any of them remains systemd starts the replacement in that old cgroup path
    instead of the configured slice (2026-10-08: tail and ugrep; 2026-10-10: a
    Telegram connector runner of an earlier generation)."""
    def __init__(self, members):
        super().__init__("leftover processes in the service cgroup")
        self.members = members


def leftover_lines(members):
    return ["Leftover in service cgroup: pid=" + str(member["pid"]) + " name=" + member["name"]
            + " identity=" + str(member["startIdentity"]) + " since=" + str(member["since"])
            + " parent=" + str(member["parentPid"])
            + " reason=" + member["reason"] for member in members]


def systemd_properties(output):
    values = {}
    for line in output.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    return values


def parent_pid(stat):
    return int(stat[stat.rfind(")") + 2:].split()[1])


def process_group(stat):
    return int(stat[stat.rfind(")") + 2:].split()[2])


def process_session(stat):
    return int(stat[stat.rfind(")") + 2:].split()[3])


def boot_epoch():
    return "linux:" + pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":pidns:" + os.readlink("/proc/self/ns/pid")


def kernel_cgroup(text):
    """The cgroup v2 path of a process; anything else is unreadable."""
    for line in text.splitlines():
        if line.startswith("0::"):
            return line[3:]
    raise RuntimeError("process cgroup unreadable")


def within(group, parent):
    return group == parent or group.startswith(parent.rstrip("/") + "/")


def process_name(args):
    """The executable's base name, and a script's beside it: the arguments
    themselves can carry paths and credentials."""
    names = [os.path.basename(args[0])] if args and args[0] else []
    if len(args) > 1 and re.search(r"\.(py|mjs|cjs|js|ts)$", args[1]):
        names.append(os.path.basename(args[1]))
    return " ".join(names) or "unknown"


def stage_outcome(host, attempts, activity):
    current = max((a for a in attempts if not a.get("historical")), key=lambda a: a["n"], default=None)
    result = {"stageId": host["stageId"], "attempt": current["n"] if current else None, "outcome": "unknown"}
    if current is None or current["n"] < host["attempt"]:
        return result
    lost = bool(re.search(r"host.*lost|lost.*host|interrupted.*restart|stopped.*turn went silent", current.get("error") or "", re.I))
    if current["state"] in ["passed", "failed", "needs_decision", "skipped"]:
        result["outcome"] = "lost" if lost else "completed"
    elif (current["state"] in ["running", "reviewing", "committing"]
          and activity.get("host", {}).get("state") == "alive"
          and activity.get("lifecycle") not in ["failed", "interrupted", "stalled"]):
        result["outcome"] = "fresh attempt started" if current["n"] > host["attempt"] else "recovered"
    return result


def complete_activity(answer):
    """agent_activity is a capped selection; it has no pagination cursor."""
    selection = answer.get("selection") or {}
    if (answer.get("unselectedCount") != 0
            or not isinstance(selection.get("matched"), int)
            or selection.get("matched") != selection.get("selected")
            or selection.get("recoveryPending") != 0
            or selection.get("recoveryTruncated") is not False
            or selection.get("cacheStatus") in ["pending", "stale"]
            or answer.get("catalog") in ["pending", "stale"]
            or answer.get("evidence") == "pending"
            or any(answer.get(key, 0) for key in ["unverifiedCount", "undescribedHostCount", "undescribedTargetCount"])
            or any(selection.get(key, 0) for key in ["projected", "unreadable"])
            or any(row.get("evidenceSource") != "transcript" for row in answer.get("conversations", []))):
        raise RuntimeError("protected activity capture incomplete")
    return answer["conversations"]


def detached_command(script, config, state, run_id):
    return ["systemd-run", "--user", "--collect", "--no-block",
            "--unit=delegatus-deploy-" + run_id, "--property=UMask=0077",
            "--setenv=LLV_STATE_DIR=" + state,
            sys.executable, script, "--approved", "--config", config, "--worker", run_id]


def command(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, timeout=10, text=True)
    if result.returncode:
        # Subprocess output and arguments can contain paths or credentials.
        raise RuntimeError("command refused")
    return result.stdout.strip()


class Mcp:
    """Owns only its recorded child; reconnects after restart transport failures."""
    def __init__(self, checkout, state, token, bun):
        # The MCP entry folds DELEGATUS_* over LLV_* before loading. Pin both
        # state spellings and remove both credential spellings before spawning.
        self.env = {**os.environ, "LLV_STATE_DIR": str(state), "DELEGATUS_STATE_DIR": str(state),
                    "LLV_TOKEN": token, "DELEGATUS_TOKEN": token}
        self.env["PATH"] = str(pathlib.Path(bun).parent) + os.pathsep + self.env.get("PATH", "")
        for prefix in ["LLV_", "DELEGATUS_"]:
            for suffix in ["SPAWN_CAPABILITY", "SPAWN_CONVERSATION_ID", "SPAWN_TRANSCRIPT_PATH"]:
                self.env.pop(prefix + suffix, None)
        self.checkout, self.bun = checkout, bun
        self.child = None
        self.buffer = b""
        self.sequence = 0

    def close(self):
        child, self.child = self.child, None
        if child is None:
            return
        try:
            child.stdin.close()
            child.wait(timeout=2)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        finally:
            child.stdout.close()

    def exchange(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.child.stdin.write((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n").encode())
        self.child.stdin.flush()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                response = json.loads(line)
                if response.get("id") != request_id:
                    continue
                result = response.get("result", {})
                if "error" in response or result.get("isError"):
                    raise RuntimeError("MCP read refused")
                return result
            readable, _, _ = select.select([self.child.stdout], [], [], max(0, deadline - time.monotonic()))
            if readable:
                part = os.read(self.child.stdout.fileno(), 65536)
                if not part or len(self.buffer) + len(part) > 4 * 1024 * 1024:
                    raise RuntimeError("MCP frame unavailable")
                self.buffer += part
        raise TimeoutError("MCP read timeout")

    def call(self, tool, args):
        try:
            if self.child is None:
                self.buffer = b""
                self.child = subprocess.Popen([self.bun, str(self.checkout / "bin/mcp-server.mjs")],
                                              cwd=self.checkout, env=self.env, stdin=subprocess.PIPE,
                                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                self.exchange("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                             "clientInfo": {"name": "deploy-health", "version": "1"}})
                self.child.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
                self.child.stdin.flush()
            # Reads use a fresh key on every observation, including retries, so
            # a restart refusal cannot be replayed as the later serving state.
            arguments = {**args, "clientRequestId": "deploy-checkout-" + uuid.uuid4().hex}
            result = self.exchange("tools/call", {"name": tool, "arguments": arguments}).get("structuredContent", {})
            if result.get("ok") is not True:
                raise RuntimeError("MCP result unavailable")
            return result
        except Exception:
            self.close()
            raise


def http_read(port, route, token):
    request = urllib.request.Request("http://127.0.0.1:" + str(port) + route,
                                     headers={"Authorization": "Bearer " + token})
    # A redirect must not carry the credential to a different endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError("HTTP health unavailable")
        body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise RuntimeError("HTTP health oversized")
        return body


def socket_health(record):
    request_id = str(uuid.uuid4())
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(10)
        connection.connect(record["socket"])
        connection.sendall((json.dumps({"id": request_id, "method": "runtime-host-health", "params": {}}) + "\n").encode())
        data = b""
        while b"\n" not in data:
            chunk = connection.recv(65536)
            if not chunk or len(data) + len(chunk) > 1024 * 1024:
                raise RuntimeError("runtime health unavailable")
            data += chunk
    response = json.loads(data.split(b"\n", 1)[0])
    health = response.get("result", {})
    entry = record["runtimeHost"]
    phases = ["fence-waiting", "fence-acquired", "journal-open", "handoff-cleanup-complete",
              "consumers-recovered", "socket-listening", "ready"]
    if (response.get("id") != request_id or response.get("ok") is not True or health.get("pid") != entry["pid"]
            or str(health.get("startIdentity", "")).split(":")[-1] != entry["startIdentity"]
            or [p["phase"] for p in health.get("phases", [])] != phases):
        raise RuntimeError("runtime health identity or readiness mismatch")
    return health


class Checkout:
    """Linux checkout adapter. All installation paths come from the private plan."""
    clock = Clock()

    def __init__(self, config, run_id=None, *, process_read=proc_field, http=http_read,
                 runtime=socket_health, execute=command, clock=None, mcp_factory=Mcp,
                 cgroup_root="/sys/fs/cgroup", signal_process=pidfd_signal,
                 census=protected_host_census, epoch=boot_epoch):
        self.clock = clock or Clock()
        self.signal_process = signal_process
        self.census_adapter = census
        self.relocation = None
        self.switch_mode = None
        self.cgroup_root = pathlib.Path(cgroup_root)
        self.agents = {}
        self.retirement_roots = {}
        self.viewer_group = None
        self.leftovers_found = []
        self.helper_custody = {}
        self.custody_rows = []
        self.boot_epoch = epoch()
        self.process_read, self.http, self.runtime, self.command = process_read, http, runtime, execute
        self.config_file = pathlib.Path(config).resolve()
        self.plan = json.loads(self.config_file.read_text())
        if self.config_file.stat().st_mode & 0o077:
            raise RuntimeError("plan must be private")
        self.state = pathlib.Path(os.environ.get("LLV_STATE_DIR") or "").resolve()
        if not os.environ.get("LLV_STATE_DIR") or str(self.state) != str(pathlib.Path(self.plan["stateDir"]).resolve()):
            raise RuntimeError("LLV_STATE_DIR must explicitly match the plan")
        self.target = self.plan["target"]
        self.install = self.plan["installId"]
        if not re.fullmatch(r"[0-9a-f]{40}", self.target) or not re.fullmatch(r"[0-9a-f]{16}", self.install):
            raise RuntimeError("full target SHA and install id required")
        self.unit = self.plan["unit"]
        if not re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", self.unit):
            raise RuntimeError("one named service required")
        self.checkout = pathlib.Path(self.plan["checkout"]).resolve()
        self.release = pathlib.Path(self.plan["releaseDir"]).resolve()
        for key in ["stateDir", "checkout", "releaseDir", "tokenFile", "verificationFile", "bun"]:
            if not pathlib.Path(self.plan[key]).is_absolute():
                raise RuntimeError("plan paths must be absolute")
        self.pointer = self.state / "self-update" / ("release-" + self.install + ".json")
        self.record_file = self.pointer.with_name("launcher-" + self.install + ".json")
        self.request_file = self.pointer.with_name("request-" + self.install + ".json")
        self.trial_file = self.pointer.with_name("trial-" + self.install + ".json")
        self.result_file = self.request_file.with_suffix(".json.result.json")
        environment = {}
        for line in pathlib.Path(self.plan["tokenFile"]).read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, raw = line.strip().split("=", 1)
                values = shlex.split(raw)
                if len(values) == 1:
                    environment[key] = values[0]
        self.token = environment.get("DELEGATUS_TOKEN") or environment.get("LLV_TOKEN")
        if not self.token:
            raise RuntimeError("access credential unavailable")
        self.mcp = mcp_factory(self.checkout, self.state, self.token, self.plan["bun"])
        self.run_dir = self.state / "deploy-verdicts" / run_id if run_id else None
        self.baseline = self.plan["baselinePointer"]

    def close(self):
        self.mcp.close()

    def census(self, timeout=30):
        return self.census_adapter(self.release, self.plan["bun"], self.state, self.target, timeout)

    def process(self, entry):
        return read_process(entry, self.process_read)

    def interrupted(self, since, hosts):
        return interrupted_conversations(self.state, since, hosts)

    def head(self, directory):
        sha = self.command(["git", "rev-parse", "HEAD"], cwd=directory)
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise RuntimeError("release HEAD unavailable")
        return sha

    def jobs(self):
        output = self.command(["systemctl", "--user", "list-jobs", "--no-legend", "--no-pager", "--plain"])
        return [line for line in output.splitlines() if self.unit in line.split()]

    def show(self, units, *properties):
        return self.command(["systemctl", "--user", "show", *units,
                             *[part for name in properties for part in ("-p", name)]])

    def show_units(self, units, *properties):
        if not units:
            return {}
        result = {}
        for block in self.show(sorted(units), "Id", *properties).split("\n\n"):
            values = systemd_properties(block)
            name = values.pop("Id", None)
            if name not in units or name in result or any(key not in values for key in properties):
                raise RuntimeError("unit properties unreadable")
            result[name] = values
        if result.keys() != set(units):
            raise RuntimeError("unit properties incomplete")
        return result

    def require_relocation_safe(self):
        bound = systemd_properties(self.show([self.unit], "BoundBy")).get("BoundBy")
        if bound is None:
            raise SwitchRefused("bound units unreadable")
        units = self.show_units(set(bound.split()), "ActiveState")
        # An activating or reloading unit can already have members and can
        # become active before systemd applies the dependency transaction.
        active = sum(unit["ActiveState"] not in {"inactive", "failed"} for unit in units.values())
        if active:
            raise SwitchRefused("relocation would stop " + str(active) + " bound units")
        if systemd_properties(self.show([self.unit], "BoundBy")).get("BoundBy") != bound:
            raise SwitchRefused("bound units changed before relocation")

    def require_relaunch_ready(self, record):
        launcher = record["launcher"]
        if type(launcher.get("relaunch")) is not int or launcher["relaunch"] != 1 or launcher.get("protocol") != RELAUNCH_PROTOCOL:
            raise SwitchRefused("launcher cannot relaunch in place")
        if pathlib.Path(record.get("requestFile") or "").resolve() != self.request_file:
            raise SwitchRefused("checkout launcher topology differs from plan")
        try:
            supported = (RELAUNCH_PROTOCOL in (self.release / "bin/launcher-relaunch.mjs").read_text()
                         and CHECKOUT_HANDOFF in (self.release / "bin/cli.mjs").read_text())
        except (OSError, UnicodeError):
            supported = False
        if not supported:
            raise SwitchRefused("target release cannot take a relaunch")
        if (path_present(self.request_file) or path_present(self.trial_file)
                or self.pending_update()):
            raise SwitchRefused("launcher request or update already pending")
        if launcher.get("state") != "healthy":
            raise SwitchRefused("launcher not idle")
        if self.target == self.baseline["sha"] or self.release == pathlib.Path(self.baseline["dir"]).resolve():
            raise SwitchRefused("target already serving")

    def pending_update(self):
        try:
            apply = optional_json(self.pointer.with_name("apply.json"))
            gate = optional_json(self.pointer.with_name("auto-admission.json"))
            return (apply is not None and (not isinstance(apply.get("state"), str)
                                           or apply["state"] in {"building", "ready", "switching"})
                    or gate is not None and (type(gate.get("until")) not in {int, float}
                                             or not 0 <= gate["until"] < float("inf")
                                             or not isinstance(gate.get("id"), str)
                                             or gate["until"] > time.time() * 1000))
        except (OSError, ValueError):
            return True

    def preflight(self):
        if sys.platform != "linux":
            raise RuntimeError("this checkout procedure requires Linux user systemd")
        if self.head(self.checkout) != self.plan["checkoutHead"] or self.head(self.release) != self.target:
            raise RuntimeError("checkout or target moved")
        if not (self.release / ".next/BUILD_ID").is_file() or self.command(["git", "status", "--porcelain", "--untracked-files=no"], cwd=self.release):
            raise RuntimeError("clean exact built release required")
        evidence = json.loads(pathlib.Path(self.plan["verificationFile"]).read_text())
        if evidence.get("sha") != self.target or evidence.get("runtimeHost") != "pass" or evidence.get("viewer") != "pass":
            raise RuntimeError("both isolated runtime rehearsals required")
        self.baseline_text = self.pointer.read_bytes().decode("utf-8")
        if json.loads(self.baseline_text) != self.baseline:
            raise RuntimeError("baseline pointer changed")
        record = json.loads(self.record_file.read_text())
        if (pathlib.Path(record["checkout"]).resolve() != self.checkout
                or pathlib.Path(record["releasePointer"]).resolve() != self.pointer
                or pathlib.Path(record["releasesDir"]).resolve() / self.target[:12] != self.release):
            raise RuntimeError("checkout launcher topology differs from plan")
        properties = self.command(["systemctl", "--user", "show", self.unit, "-p", "KillMode", "-p", "ActiveState"])
        if "KillMode=process" not in properties.splitlines() or "ActiveState=active" not in properties.splitlines() or self.jobs():
            raise RuntimeError("agent preservation or idle service fence unavailable")
        def baseline_ready():
            serving = self.serving()
            if not ready(serving, self.baseline["sha"], placement=False):
                raise BaselineReadinessError(serving, self.baseline["sha"])
        retry(baseline_ready, self.clock, 30)
        capture_deadline = self.clock.now() + 30
        def capture():
            answer = self.census(max(0, capture_deadline - self.clock.now()))
            return complete_activity(answer)
        rows = retry(capture, self.clock, 30)
        hosts = self.capture_hosts(rows)
        placement = self.placement()
        self.switch_mode = "relaunch" if placement["actual"] == placement["expected"] else "relocation"
        if self.switch_mode == "relaunch":
            self.require_relaunch_ready(record)
        else:
            self.require_relocation_safe()
        # Last, so the inventory is read immediately before publication.
        self.fence()
        return [record[role] for role in ["launcher", "web", "runtimeHost"]], hosts

    def capture_hosts(self, rows):
        self.custody_rows = rows
        hosts = []
        self.agents = {}
        for row in rows:
            host, pipeline = row.get("host") or {}, row.get("pipeline")
            if host.get("state") == "alive" and isinstance(host.get("pid"), int):
                proc = self.process({"pid": host["pid"]})
                if proc:
                    self.agents[host["pid"]] = proc["startIdentity"]
            if pipeline and host.get("state") == "alive" and row.get("turnState") == "busy":
                entry = {"pid": host["pid"]}
                proc = self.process(entry)
                hosts.append({**entry, "startIdentity": proc["startIdentity"] if proc else None,
                              "conversationId": row["conversationId"], "pipelineId": pipeline["pipelineId"],
                              "stageId": pipeline["stageId"], "attempt": pipeline["attempt"]})
        return hosts

    def placement(self):
        """Observed configuration and cgroup, against the required CPU slice.
        A missing value is unreadable, never a match."""
        unit = systemd_properties(self.command(["systemctl", "--user", "show", self.unit,
                                                "-p", "Slice", "-p", "ControlGroup", "-p", "CPUWeight"]))
        configured, actual = unit.get("Slice"), unit.get("ControlGroup")
        if not configured or not actual:
            raise RuntimeError("service placement unreadable")
        parent = systemd_properties(self.command(["systemctl", "--user", "show", CPU_SLICE, "-p", "ControlGroup"])).get("ControlGroup")
        if not parent or not parent.endswith("/" + CPU_SLICE):
            raise RuntimeError("slice placement unreadable")
        return {"slice": configured, "expected": parent.rstrip("/") + "/" + self.unit, "actual": actual,
                "weight": unit.get("CPUWeight")}

    def members(self, group):
        """Every PID in the cgroup subtree. A subtree that cannot be read whole
        is refused rather than read as empty."""
        root = self.cgroup_root / group.lstrip("/")
        if not root.is_dir():
            raise RuntimeError("service cgroup unreadable")
        def refuse(error):
            raise error
        pids = set()
        try:
            for directory, _, _ in os.walk(root, onerror=refuse):
                pids.update(int(pid) for pid in (pathlib.Path(directory) / "cgroup.procs").read_text().split())
        except (OSError, ValueError):
            raise RuntimeError("service cgroup unreadable") from None
        return sorted(pids)

    def owner(self, pid, owners):
        """Walks the parents of a process to the serving generation or an agent
        host, each matched by its start identity. A process re-parented to the
        user manager reaches neither."""
        seen = set()
        while pid > 1 and pid not in seen and len(seen) < 64:
            seen.add(pid)
            stat = self.process_read(pid, "stat")
            if owners.get(pid, (None, None))[1] == start_identity(stat):
                return owners[pid][0]
            pid = parent_pid(stat)
        return None

    def launcher_ancestors(self, record, group):
        """Exact identities on the recorded launcher's path up to MainPID.
        These are exemptions for those processes only: making the bootstrap
        an ownership root would also admit its surviving older children."""
        def unit_process():
            values = systemd_properties(self.command([
                "systemctl", "--user", "show", self.unit, "-p", "MainPID", "-p", "ControlGroup"]))
            main = values.get("MainPID", "")
            if not re.fullmatch(r"[1-9][0-9]*", main) or int(main) <= 1 or values.get("ControlGroup") != group:
                raise RuntimeError("service MainPID or cgroup unreadable or changed")
            return int(main)
        main = unit_process()
        launcher = record["launcher"]
        pid = launcher["pid"]
        chain = {}
        while pid > 1 and pid not in chain and len(chain) < 64:
            stat = self.process_read(pid, "stat")
            identity, parent = start_identity(stat), parent_pid(stat)
            if pid == launcher["pid"] and identity != launcher.get("startIdentity"):
                raise RuntimeError("recorded launcher identity changed")
            if not within(kernel_cgroup(self.process_read(pid, "cgroup")), group):
                raise RuntimeError("launcher ancestor outside the service cgroup")
            chain[pid] = (identity, parent)
            if pid == main:
                break
            pid = parent
        if pid != main:
            raise RuntimeError("recorded launcher does not reach the service MainPID")
        for pid, expected in chain.items():
            stat = self.process_read(pid, "stat")
            if ((start_identity(stat), parent_pid(stat)) != expected
                    or not within(kernel_cgroup(self.process_read(pid, "cgroup")), group)):
                raise RuntimeError("launcher ancestor changed while it was read")
        if unit_process() != main:
            raise RuntimeError("service MainPID changed while it was read")
        return chain

    def older_release(self, record, args, cwd):
        """A serving descendant executing from a different release directory.
        Agent-owned tools may intentionally use other release checkouts."""
        releases = pathlib.Path(record["releasesDir"]).resolve()
        for value in [*args[:2], cwd]:
            path = pathlib.Path(value)
            if not path.is_absolute():
                path = pathlib.Path(cwd) / path
            try:
                relative = path.resolve().relative_to(releases)
            except ValueError:
                continue
            if (relative.parts and re.fullmatch(r"[0-9a-f]{12}", relative.parts[0])
                    and not relative.parts[0].startswith(record["launcher"]["revision"][:12])):
                return True
        return False

    def custody(self, group, candidates):
        """Require custody links to survive a fresh proof before admission.

        Process identities alone do not preserve the FIFO, host scope, or
        private exit binding used by the first proof. Keep only members whose
        complete proof is identical on two consecutive reads. If the second
        read loses any link, that member remains in ``found`` and the normal
        LeftoverProcesses fence refuses preflight.
        """
        try:
            first = self._custody_once(group, candidates)
        except (OSError, RuntimeError, ValueError, TypeError, KeyError):
            first = {}
            for member in candidates:
                member["reason"] = "custody evidence changed before final admission"
        if not first:
            return first
        try:
            second = self._custody_once(group, candidates)
        except (OSError, RuntimeError, ValueError, TypeError, KeyError):
            second = {}
        stable = {pid: evidence for pid, evidence in first.items()
                  if second.get(pid) == evidence}
        changed = set(first) - set(stable)
        for member in candidates:
            if member["pid"] in changed:
                member["reason"] = "custody evidence changed before final admission"
        return {pid: {key: value for key, value in evidence.items() if key != "proof"}
                for pid, evidence in stable.items()}

    def _custody_once(self, group, candidates):
        """Read-only, bidirectional proof for otherwise unowned members.
        Fixed diagnostics deliberately contain neither argv nor private paths.
        No custody member can become a retirement root.
        """
        admitted, waiters, processes, observed_hosts = {}, {}, {}, {}
        for member in candidates:
            if member["reason"] == "older release in service cgroup":
                continue
            pid = member["pid"]
            stat = self.process_read(pid, "stat")
            processes[pid] = {"stat": stat, "args": [arg for arg in self.process_read(pid, "cmdline").decode().split("\0") if arg],
                              "member": member}
        if not processes:
            return admitted

        def unchanged(pid, identity):
            current = self.process_read(pid, "stat")
            before = processes.get(pid, {}).get("stat", observed_hosts.get(pid))
            if (start_identity(current) != identity or before is not None
                    and (parent_pid(current), process_group(current), process_session(current))
                    != (parent_pid(before), process_group(before), process_session(before))):
                raise RuntimeError("service cgroup member changed while it was read")

        def admit(pid, role, host, proof=None):
            unchanged(pid, processes[pid]["member"]["startIdentity"])
            admitted[pid] = {"pid": pid, "startIdentity": processes[pid]["member"]["startIdentity"],
                             "role": role, "hostPid": host["pid"], "hostStartIdentity": host["startIdentity"],
                             "proof": {"parentPid": parent_pid(processes[pid]["stat"]),
                                       "processGroup": process_group(processes[pid]["stat"]),
                                       "session": process_session(processes[pid]["stat"]), **(proof or {})}}

        # Scope properties are read together, once per inventory. Missing or
        # contradictory blocks grant nothing.
        scopes = {}
        scope_names = set()
        for row in self.custody_rows:
            host = row.get("host", {})
            if host.get("state") != "alive":
                continue
            try:
                host_group = kernel_cgroup(self.process_read(host["pid"], "cgroup"))
                match = re.fullmatch(r"(.+/(delegatus-agent-[A-Za-z0-9_.@-]+\.scope))(?:/agent)?", host_group)
                if match:
                    scope_names.add(match[2])
            except (OSError, KeyError, RuntimeError):
                pass
        if scope_names:
            try:
                output = self.command(["systemctl", "--user", "show", *sorted(scope_names),
                                       "-p", "Id", "-p", "BindsTo", "-p", "After", "-p", "ControlGroup", "-p", "ActiveState"])
            except (OSError, RuntimeError, subprocess.SubprocessError):
                output = ""
            for block in output.strip().split("\n\n"):
                values = systemd_properties(block)
                name = values.get("Id")
                if name in scopes:
                    scopes[name] = {}
                else:
                    scopes[name] = values

        for pid, proc in processes.items():
            args, member = proc["args"], proc["member"]
            # Accept both native launch formats, without comparing source text.
            try:
                index = args.index("-e")
                if args[index + 2] != "--" or len(args) != index + 4:
                    continue
                launch = json.loads(args[-1])
                command = launch.get("command") if isinstance(launch, dict) else launch
                if not isinstance(command, list) or not command or not isinstance(command[0], str) or not os.path.isabs(command[0]):
                    continue
                directory = pathlib.Path(command[0])
            except (ValueError, IndexError, TypeError):
                continue
            rows = [row for row in self.custody_rows if row.get("host", {}).get("state") == "alive"
                    and (row["host"].get("exitWriter") or {}).get("process", {}).get("pid") == pid
                    and row["host"]["exitWriter"]["process"].get("startIdentity") == str(pid) + ":" + member["startIdentity"]
                    and row["host"]["exitWriter"]["process"].get("bootEpoch") == self.boot_epoch]
            member["reason"] = "wait owner: no registry writer record names it"
            if len(rows) != 1:
                continue
            host = rows[0]["host"]
            identity = host.get("process")
            member["reason"] = "wait owner: host identity differs from registry"
            if not census_identity(identity) or identity["pid"] != host["pid"] or identity.get("bootEpoch") != self.boot_epoch:
                continue
            try:
                host_stat = self.process_read(host["pid"], "stat")
                if identity["startIdentity"] != str(host["pid"]) + ":" + start_identity(host_stat):
                    continue
                observed_hosts[host["pid"]] = host_stat
                member["reason"] = "wait owner: host is not its child"
                if parent_pid(host_stat) != pid:
                    continue
                member["reason"] = "wait owner: host not in an agent scope outside the service"
                host_group = kernel_cgroup(self.process_read(host["pid"], "cgroup"))
                match = re.fullmatch(r"(.+/(delegatus-agent-[A-Za-z0-9_.@-]+\.scope))(?:/agent)?", host_group)
                if within(host_group, group) or not match:
                    continue
                member["reason"] = "wait owner: host scope not bound to the unit"
                scope = scopes.get(match[2], {})
                if (self.unit not in scope.get("BindsTo", "").split() or self.unit not in scope.get("After", "").split()
                        or scope.get("ActiveState") != "active" or scope.get("ControlGroup") != match[1]):
                    continue
                member["reason"] = "wait owner: launch directory does not name the host's exit record"
                # Hold the verified directory across the binding read; a
                # pathname replacement cannot substitute another launch.
                directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    launch_info = os.fstat(directory_fd)
                    if launch_info.st_uid != os.getuid() or launch_info.st_mode & 0o077:
                        continue
                    fd = os.open("host-exit.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    try:
                        info = os.fstat(fd)
                        if not stat_mode.S_ISREG(info.st_mode) or info.st_size > 4096:
                            continue
                        data = os.read(fd, 4097)
                        if len(data) > 4096:
                            continue
                        binding = json.loads(data)
                    finally:
                        os.close(fd)
                    current = directory.lstat()
                    if (current.st_dev, current.st_ino, current.st_mode, current.st_uid) != (
                            launch_info.st_dev, launch_info.st_ino, launch_info.st_mode, launch_info.st_uid):
                        continue
                finally:
                    os.close(directory_fd)
                exit_file = host["exitWriter"]["exitFile"]
                expected = self.state / "host-exits"
                if (not isinstance(binding, dict) or "discard" in binding or not isinstance(binding.get("file"), str)
                        or not os.path.isabs(binding["file"]) or not os.path.isabs(exit_file)
                        or pathlib.Path(binding["file"]).name != pathlib.Path(exit_file).name
                        or pathlib.Path(binding["file"]).parent.resolve() != expected.resolve()
                        or pathlib.Path(exit_file).parent.resolve() != expected.resolve()):
                    continue
            except (OSError, ValueError, TypeError, KeyError):
                continue
            unchanged(host["pid"], start_identity(host_stat))
            host_identity = {"pid": host["pid"], "startIdentity": start_identity(host_stat)}
            wait_proof = {"hostCgroup": host_group, "scope": dict(scope),
                          "directoryPath": str(directory),
                          "directory": [launch_info.st_dev, launch_info.st_ino, launch_info.st_mode, launch_info.st_uid],
                          "exitBindingFile": [info.st_dev, info.st_ino, info.st_mode, info.st_uid],
                          "exitBinding": binding}
            admit(pid, "wait-owner", host_identity, wait_proof)
            waiters[pid] = {"directory": directory, "host": host_identity, "proof": wait_proof}

        # The fd table is bounded, and a failed read grants no drain custody.
        if not waiters:
            return admitted
        fds = {}
        for pid in processes:
            try:
                fds[pid] = self.process_read(pid, "fds")
            except (OSError, RuntimeError):
                fds[pid] = []
        fifo_owners = {}
        for pid in waiters:
            for fd, dev, inode, fifo in fds[pid]:
                if fd == 2 and fifo:
                    fifo_owners.setdefault((dev, inode), []).append(pid)
                    waiters[pid]["proof"]["fifo"] = [fd, dev, inode, fifo]
                    admitted[pid]["proof"]["fifo"] = [fd, dev, inode, fifo]
        holders = {pid: {(dev, inode) for _, dev, inode, fifo in descriptors if fifo and (dev, inode) in fifo_owners}
                   for pid, descriptors in fds.items() if pid not in admitted}
        for fifo, owners in fifo_owners.items():
            members = {pid: processes[pid] for pid in holders if fifo in holders[pid]}
            if not members:
                continue
            if len(owners) != 1:
                for proc in members.values():
                    proc["member"]["reason"] = "stderr drain: ambiguous FIFO"
                continue
            waiter = waiters[owners[0]]
            leaders = []
            for pid, proc in members.items():
                args, stat = proc["args"], proc["stat"]
                if (process_group(stat) == process_session(stat) == pid and len(args) == 7
                        and os.path.basename(args[0]) == "sh" and args[1] == "-c" and args[3] == "sh"
                        and pathlib.Path(args[4]) == waiter["directory"] / "startup.fifo"
                        and pathlib.Path(args[5]) == waiter["directory"] / "startup.stderr"):
                    leaders.append(pid)
            if len(leaders) != 1:
                for proc in members.values():
                    proc["member"]["reason"] = "stderr drain: no single leader for the owner's FIFO"
                continue
            leader = leaders[0]
            subshells = [pid for pid, proc in members.items() if pid != leader
                         and parent_pid(proc["stat"]) == leader and proc["args"] == members[leader]["args"]
                         and process_group(proc["stat"]) == process_session(proc["stat"]) == leader]
            for pid, proc in members.items():
                stat, args, member = proc["stat"], proc["args"], proc["member"]
                if len(holders[pid]) != 1:
                    member["reason"] = "stderr drain: ambiguous FIFO"
                elif process_group(stat) != leader or process_session(stat) != leader:
                    member["reason"] = "stderr drain: process group differs from its leader"
                elif pid != leader and (len(subshells) > 1 or parent_pid(stat) not in [leader, *subshells]):
                    member["reason"] = "stderr drain: parent link outside the group"
                elif pid != leader and pid not in subshells and (not args or os.path.basename(args[0]) not in ["dd", "tee", "wc", "cat"]):
                    member["reason"] = "stderr drain: unexpected program"
                else:
                    admit(pid, "stderr-drain", waiter["host"],
                          {"fifo": list(fifo), "waiterProof": waiter["proof"]})
        # Recheck every admitted identity after the final filesystem/systemd
        # read, so an earlier member cannot change while later proof runs.
        # Mutable custody links receive their own complete reread here, after
        # all candidates have been scanned. The initial and scan-time reads
        # alone leave a window in which an earlier FIFO, scope or receipt can
        # change while this proof is still processing later members.
        self._validate_custody_links(admitted)
        for pid, evidence in admitted.items():
            unchanged(pid, evidence["startIdentity"])
            unchanged(evidence["hostPid"], evidence["hostStartIdentity"])
        return admitted

    def _validate_custody_links(self, admitted):
        """Re-read mutable external links at the completed proof boundary."""
        owners = {}
        expected_scopes = {}
        for pid, evidence in admitted.items():
            proof = evidence["proof"]
            waiter = proof if evidence["role"] == "wait-owner" else proof.get("waiterProof")
            if waiter is None:
                raise RuntimeError("custody owner proof unavailable")
            owners[pid] = proof.get("fifo")
            if evidence["role"] == "wait-owner":
                expected_scopes[waiter["scope"].get("Id")] = waiter["scope"]
                try:
                    host_group = kernel_cgroup(self.process_read(evidence["hostPid"], "cgroup"))
                except (OSError, RuntimeError, KeyError):
                    raise RuntimeError("custody host cgroup changed before final admission") from None
                if host_group != waiter["hostCgroup"]:
                    raise RuntimeError("custody host cgroup changed before final admission")
                directory = pathlib.Path(waiter["directoryPath"])
                try:
                    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        directory_info = os.fstat(directory_fd)
                        directory_identity = [directory_info.st_dev, directory_info.st_ino,
                                              directory_info.st_mode, directory_info.st_uid]
                        if directory_identity != waiter["directory"]:
                            raise RuntimeError("custody launch directory changed before final admission")
                        fd = os.open("host-exit.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=directory_fd)
                        try:
                            info = os.fstat(fd)
                            if [info.st_dev, info.st_ino, info.st_mode, info.st_uid] != waiter["exitBindingFile"]:
                                raise RuntimeError("custody exit receipt changed before final admission")
                            data = os.read(fd, 4097)
                            if len(data) > 4096 or json.loads(data) != waiter["exitBinding"]:
                                raise RuntimeError("custody exit receipt changed before final admission")
                        finally:
                            os.close(fd)
                    finally:
                        os.close(directory_fd)
                except (OSError, ValueError, TypeError, KeyError, IndexError):
                    raise RuntimeError("custody launch binding unreadable before final admission") from None
        if expected_scopes:
            try:
                output = self.command(["systemctl", "--user", "show", *sorted(expected_scopes),
                                       "-p", "Id", "-p", "BindsTo", "-p", "After", "-p",
                                       "ControlGroup", "-p", "ActiveState"])
            except (OSError, RuntimeError, subprocess.SubprocessError):
                raise RuntimeError("custody host scope unreadable before final admission") from None
            observed = {}
            for block in output.strip().split("\n\n"):
                value = systemd_properties(block)
                name = value.get("Id")
                if name in observed:
                    raise RuntimeError("custody host scope ambiguous before final admission")
                observed[name] = value
            if observed != expected_scopes:
                raise RuntimeError("custody host scope changed before final admission")
        for pid, expected in owners.items():
            if expected is None:
                continue
            try:
                descriptors = self.process_read(pid, "fds")
            except (OSError, RuntimeError):
                raise RuntimeError("custody FIFO unreadable before final admission") from None
            expected = tuple(expected)
            matches = (expected in descriptors if len(expected) == 4 else
                       any(fifo and (dev, inode) == expected for _, dev, inode, fifo in descriptors))
            if not matches:
                raise RuntimeError("custody FIFO changed before final admission")

    def leftovers(self, group):
        record = json.loads(self.record_file.read_text())
        owners = {pid: ("agent", identity) for pid, identity in self.agents.items()}
        for key in ["launcher", "web", "runtimeHost"]:
            owners[record[key]["pid"]] = ("current", record[key].get("startIdentity"))
        ancestors = self.launcher_ancestors(record, group)
        found = []
        for pid in self.members(group):
            try:
                stat = self.process_read(pid, "stat")
                ancestor = ancestors.get(pid)
                owned = self.owner(pid, owners) if ancestor is None else None
                args = self.process_read(pid, "cmdline").decode().split("\0")
                older = owned == "current" and pid not in owners and self.older_release(
                    record, args, self.process_read(pid, "cwd"))
                if start_identity(self.process_read(pid, "stat")) != start_identity(stat):
                    raise RuntimeError("service cgroup member changed while it was read")
                if ancestor is not None:
                    if (start_identity(stat), parent_pid(stat)) != ancestor:
                        raise RuntimeError("launcher ancestor changed during cgroup inventory")
                    continue
                if owned is not None and not older:
                    continue
            except FileNotFoundError:
                # Exited since the cgroup was listed, or a parent left mid-walk:
                # a recheck must classify it again.
                if self.process({"pid": pid}) is None:
                    continue
                raise RuntimeError("service cgroup member moved while it was read")
            identity = start_identity(stat)
            found.append({"pid": pid, "startIdentity": identity, "name": process_name(args),
                          "parentPid": parent_pid(stat), "since": self.clock.process_since(identity),
                          "reason": "older release in service cgroup" if older else "no current serving or agent owner"})
        self.helper_custody = self.custody(group, found)
        found = [member for member in found if member["pid"] not in self.helper_custody]
        if self.launcher_ancestors(record, group) != ancestors or json.loads(self.record_file.read_text()) != record:
            raise RuntimeError("launcher ownership changed during cgroup inventory")
        return found

    def fence(self):
        """Refuses, naming them, while the service cgroup holds a process that
        is neither an agent nor the serving generation. Nothing is signalled."""
        group = self.placement()["actual"]
        self.leftovers_found = retry(lambda: self.leftovers(group), self.clock, 10)
        if self.leftovers_found:
            self.emit({"leftovers": self.leftovers_found})
            raise LeftoverProcesses(self.leftovers_found)
        if self.helper_custody:
            self.emit({"custody": list(self.helper_custody.values())})

    def publish(self):
        # Repeat the immutability fences immediately before the atomic write.
        if (self.head(self.checkout) != self.plan["checkoutHead"] or self.head(self.release) != self.target
                or self.pointer.read_bytes() != self.baseline_text.encode("utf-8")):
            raise RuntimeError("publication inputs changed")
        write_json(self.pointer, {"sha": self.target, "dir": str(self.release),
                                  "checkoutHead": self.plan["checkoutHead"], "publishedAt": utc()})
        if self.switch_mode != "relaunch":
            self.emit({"published": self.target})

    def unit_facts(self):
        unit = systemd_properties(self.show([self.unit], *UNIT_FENCE_PROPERTIES))
        jobs = self.jobs()
        if any(key not in unit for key in UNIT_FENCE_PROPERTIES) or any(
                not re.fullmatch(r"[0-9]+", unit[key])
                for key in ("MainPID", "NRestarts", "InactiveEnterTimestampMonotonic")):
            raise RuntimeError("service continuity properties unreadable")
        if unit["ActiveState"] == "active" and not re.fullmatch(r"[0-9a-f]{32}", unit["InvocationID"]):
            raise RuntimeError("active service invocation unreadable")
        pid = int(unit["MainPID"])
        try:
            identity = start_identity(self.process_read(pid, "stat")) if pid else None
        except (FileNotFoundError, ProcessLookupError):
            identity = None
        return {**unit, "MainPID": pid, "startIdentity": identity, "bootEpoch": self.boot_epoch, "jobs": jobs}

    def poll_relaunch_unit(self):
        evidence = self.relaunch_evidence
        try:
            fact = self.unit_facts()
            changed = fact != evidence["unitBefore"]
            # Losing the stat read alone does not prove an identity change.
            unknown = fact["ActiveState"] == "active" and fact["startIdentity"] is None
            if unknown:
                changed = {**fact, "startIdentity": evidence["unitBefore"]["startIdentity"]} != evidence["unitBefore"]
            evidence["unitAfter"] = fact
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            fact, changed, unknown = None, False, True
        poll = {"at": utc(), "unit": fact}
        evidence["polls"].append(poll)
        if changed and not evidence["unitLeftActive"]:
            evidence["unitLeftActive"] = poll
        if unknown and not evidence["unitUnknown"]:
            evidence["unitUnknown"] = poll
        return not changed and not unknown

    def capture_relaunch(self, hosts):
        placement = self.placement()
        if placement["actual"] != placement["expected"]:
            raise SwitchRefused("service placement changed before relaunch")
        unit = self.unit_facts()
        if unit["ActiveState"] != "active" or unit["jobs"] or not unit["startIdentity"]:
            raise SwitchRefused("agent preservation or idle service fence unavailable")
        group = placement["actual"]
        record = json.loads(self.record_file.read_bytes())
        self.require_relaunch_ready(record)
        ancestors = self.launcher_ancestors(record, group)
        if ancestors.get(unit["MainPID"], (None,))[0] != unit["startIdentity"]:
            raise SwitchRefused("service MainPID changed before relaunch")
        captured = self.generation(group)
        if json.loads(self.record_file.read_bytes()) != record:
            raise SwitchRefused("launcher ownership changed before relaunch")
        self.require_relaunch_ready(record)
        self.relaunch_record = record
        self.relaunch_hosts = self.relaunch_host_inventory()
        scopes = self.show_units({entry["scope"] for entry in self.relaunch_hosts.values() if entry["scope"]},
                                 "LoadState", "ActiveState", "InvocationID")
        if any(scope["LoadState"] != "loaded" or scope["ActiveState"] != "active"
               or not re.fullmatch(r"[0-9a-f]{32}", scope["InvocationID"]) for scope in scopes.values()):
            raise SwitchRefused("host scope continuity unavailable")
        # Repeat the last preflight fence against the refreshed census.
        custody = self.helper_custody.copy()
        self.fence()
        self.helper_custody = {**custody, **self.helper_custody}
        self.relaunch_evidence = {
            "requestId": uuid.uuid4().hex, "result": "unsettled", "unitBefore": unit,
            "unitAfter": unit, "unitLeftActive": None, "unitUnknown": None, "polls": [],
            "scopes": {name: {"before": scope} for name, scope in scopes.items()},
            "scopeStopped": [], "generationSurvivors": [], "signalled": [],
            "custodyChanged": False, "custodyUnknown": False,
            "launcherBefore": {"pid": record["launcher"]["pid"],
                               "startIdentity": record["launcher"]["startIdentity"], "bootEpoch": self.boot_epoch},
        }
        # Include work admitted during the census refresh, retaining the
        # original identity of work that had already been captured.
        refreshed = {(entry["pid"], entry["startIdentity"]): entry for entry in self.refreshed_hosts}
        refreshed.update({(entry["pid"], entry["startIdentity"]): entry for entry in hosts})
        generation = [{"pid": pid, "startIdentity": identity} for pid, identity in captured.items()
                      if pid not in ancestors]
        if any({"pid": child["pid"], "startIdentity": child["startIdentity"]} not in generation
               for child in (record["web"], record["runtimeHost"])):
            raise SwitchRefused("serving generation changed before relaunch")
        return generation, list(refreshed.values())

    def relaunch(self, generation):
        evidence = self.relaunch_evidence
        request = {"requestId": evidence["requestId"], "role": "relaunch", "target": self.target,
                   "rollbackPointer": self.baseline_text, "requestedAt": utc()}
        with deferred_termination():
            if not self.poll_relaunch_unit():
                return
            record = json.loads(self.record_file.read_bytes())
            self.require_relaunch_ready(record)
            if record != self.relaunch_record:
                raise SwitchRefused("launcher ownership changed before relaunch")
            self.publish()
            try:
                write_json(self.request_file, request, exclusive=True)
            except FileExistsError:
                evidence["result"] = "request-refused"
                return
        with contextlib.suppress(OSError):
            self.emit({"published": self.target, "relaunchRequestId": request["requestId"]})
        self.await_relaunch(request)
        if evidence["result"] != "done":
            return
        deadline = self.clock.now() + RELEASE_WAIT
        while True:
            evidence["generationSurvivors"] = [
                {**entry, "reason": "generation survivor"} for entry in generation
                if self.identity_alive(entry)
            ]
            self.poll_relaunch_unit()
            if not evidence["generationSurvivors"] or self.clock.now() >= deadline:
                break
            self.clock.sleep(min(1, deadline - self.clock.now()))

    def await_relaunch(self, request):
        evidence = self.relaunch_evidence
        started = self.clock.now()
        deadline = started + REQUEST_WAIT
        wall_start = time.time()
        owner = evidence["launcherBefore"]
        while True:
            self.poll_relaunch_unit()
            try:
                result = optional_json(self.result_file)
                trial = optional_json(self.trial_file)
                record = optional_json(self.record_file)
                result = result if result and result.get("requestId") == request["requestId"] else {}
                if result.get("state") == "rejected":
                    evidence["lastRejectedReceipt"] = result
                if (result.get("target") == self.target
                        and result.get("launcherPid") == owner["pid"]
                        and result.get("launcherIdentity") == owner["startIdentity"]):
                    state = result.get("state")
                    if state == "rolled-back" or state == "done" and result.get("revision") == self.target:
                        evidence.update(result=state, receipt=result)
                        return
                if trial and trial.get("requestId") == request["requestId"] and trial.get("target") == self.target:
                    # Translate the launcher's wall deadline once against the
                    # dispatch clock. Neither torn reads nor restarts can
                    # turn a trial into an unlimited wait.
                    rollback = trial.get("state") == "rolled-back"
                    bound = started + REQUEST_WAIT + SWITCH_TIMEOUT + RELAUNCH_SETTLE + (ROLLBACK_TIMEOUT if rollback else 0)
                    expires = trial.get("switchDeadlineAt")
                    if type(expires) in {int, float} and 0 < expires < float("inf"):
                        deadline = max(deadline, min(bound, started + expires / 1000 - wall_start
                                                     + RELAUNCH_SETTLE + (ROLLBACK_TIMEOUT if rollback else 0)))
                launcher = (record or {}).get("launcher", {})
                if (launcher.get("requestId") == request["requestId"]
                        and launcher.get("pid") == owner["pid"]
                        and launcher.get("startIdentity") == owner["startIdentity"]):
                    error_kind = (launcher.get("error") or {}).get("kind")
                    if error_kind == "message" and not trial and not path_present(self.request_file):
                        evidence["result"] = "refused"
                        return
                    if (error_kind == "fell-back" and not trial and not path_present(self.request_file)
                            and self.pointer.read_bytes() == self.baseline_text.encode("utf-8")):
                        # The rollback receipt precedes removal of the trial.
                        # Re-read if the first result read raced that removal.
                        terminal = optional_json(self.result_file)
                        if not terminal or terminal.get("requestId") != request["requestId"]:
                            evidence["result"] = "fell-back"
                            return
            except (OSError, ValueError, TypeError, AttributeError):
                pass
            remaining = deadline - self.clock.now()
            if remaining <= 0 or evidence["unitLeftActive"]:
                return
            self.clock.sleep(min(1, remaining))

    def identity_alive(self, entry):
        try:
            stat = self.process_read(entry["pid"], "stat")
            return start_identity(stat) == entry["startIdentity"] and stat[stat.rfind(")") + 2] not in "ZX"
        except (FileNotFoundError, ProcessLookupError):
            return False

    def relaunch_host_inventory(self):
        evidence = {}
        for row in self.custody_rows:
            host = row["host"]
            if host["state"] != "alive":
                continue
            pid = host["pid"]
            identity = self.agents.get(pid)
            if not identity:
                raise SwitchRefused("host identity unavailable before relaunch")
            key = (pid, identity)
            if key in evidence:
                continue
            entry = {"pid": pid, "startIdentity": identity, "bootEpoch": self.boot_epoch}
            native = host.get("process")
            if native and (native["startIdentity"] != str(pid) + ":" + identity
                           or native.get("bootEpoch") not in {None, self.boot_epoch}):
                raise SwitchRefused("host identity changed before relaunch")
            group = kernel_cgroup(self.process_read(pid, "cgroup"))
            if not self.identity_alive(entry):
                raise SwitchRefused("host identity changed before relaunch")
            scope = next((segment for segment in reversed(group.split("/")) if segment.endswith(".scope")), None)
            # This is the host-exits slot key used by hostExit.ts. A legacy
            # census row can lack its registry identity, so no slot is guessed.
            slots = {}
            writer = host.get("exitWriter")
            if native:
                name = hashlib.sha256(json.dumps([pid, native["startIdentity"], native.get("bootEpoch")],
                                                 separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
                slots = {kind: self.state / "host-exits" / (name + "." + kind + ".json")
                         for kind in ("writer", "exit", "stop")}
            if writer and (not slots or pathlib.Path(writer["exitFile"]).resolve() != slots["exit"]
                           or optional_json(slots["writer"]) != writer["process"]):
                raise SwitchRefused("host exit writer changed before relaunch")
            helpers = [{key: member[key] for key in ("pid", "startIdentity", "role")}
                       for member in self.helper_custody.values() if member["hostPid"] == pid
                       and member["hostStartIdentity"] == identity]
            # A current Viewer's descendants may not yet need W1–W8 to pass
            # the inventory. Keep their custody proof when generation found it.
            work = {field: row.get(field) for field in ("conversationId", "pipeline", "turnState")}
            evidence[key] = {"process": entry, "scope": scope, "cgroup": group, "slots": slots, "work": work,
                             "writer": writer["process"] if writer else None, "helpers": helpers}
        return evidence

    def finish_relaunch(self, hosts, protected):
        evidence = self.relaunch_evidence
        scopes = evidence["scopes"]
        try:
            current = self.show_units(scopes, "LoadState", "ActiveState", "InvocationID")
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            current = {}
            evidence["custodyUnknown"] = True
        for name, fact in current.items():
            scopes[name]["after"] = fact
        host_evidence = {}
        for key, before in self.relaunch_hosts.items():
            process, scope, slots = before["process"], before["scope"], before["slots"]
            detail = {"process": process, "scope": scope, "cgroup": before["cgroup"],
                      "writerBefore": before["writer"], "helpersBefore": before["helpers"], "work": before["work"]}
            host_evidence[key] = detail
            try:
                alive = self.identity_alive(process)
                detail["alive"] = alive
                after = current.get(scope)
                if after is not None and (after["LoadState"] == "loaded" and (
                        after["InvocationID"] and after["InvocationID"] != scopes[scope]["before"]["InvocationID"]
                        or alive and (after["ActiveState"] != "active" or not after["InvocationID"]))
                        or after["LoadState"] == "not-found" and alive):
                    if scope not in evidence["scopeStopped"]:
                        evidence["scopeStopped"].append(scope)
                elif after is not None and after["LoadState"] not in {"loaded", "not-found"}:
                    evidence["custodyUnknown"] = True
                if alive and kernel_cgroup(self.process_read(process["pid"], "cgroup")) != before["cgroup"]:
                    evidence["custodyChanged"] = True
                detail["helpersAfter"] = [p for p in before["helpers"] if self.identity_alive(p)]
                detail["writerAfter"] = optional_json(slots["writer"]) if slots else None
                if alive:
                    writer = before["writer"]
                    writer_live = not writer or (writer.get("bootEpoch") in {None, self.boot_epoch}
                        and writer["startIdentity"].startswith(str(writer["pid"]) + ":")
                        and self.identity_alive({"pid": writer["pid"],
                                                 "startIdentity": writer["startIdentity"].split(":", 1)[1]}))
                    if (detail["helpersAfter"] != before["helpers"] or detail["writerAfter"] != writer
                            or not writer_live or slots and optional_json(slots["exit"]) is not None):
                        evidence["custodyChanged"] = True
                    continue
                exit_record = optional_json(slots["exit"]) if slots else None
                stop = optional_json(slots["stop"]) if slots else None
                if stop and stop.get("active") == 0:
                    stop = stop.get("prior")
                if (exit_record is None or not (type(exit_record.get("code")) is int
                                               or isinstance(exit_record.get("signal"), str))):
                    evidence["custodyUnknown"] = True
                    continue
                detail["exit"] = {"code": exit_record.get("code"), "signal": exit_record.get("signal"),
                                  "stopPath": (stop or {}).get("path")}
                exit_signal = detail["exit"]["signal"]
                signal_exit = (isinstance(exit_signal, str) and exit_signal.upper() != "EOF"
                               or type(exit_record.get("code")) is int
                               and 128 < exit_record["code"] < 128 + signal.NSIG)
                captured_turn = before["work"].get("turnState")
                if signal_exit:
                    # Every signal-shaped host exit needs the durable product
                    # stop receipt. The exit code alone is not evidence that
                    # an idle host was intentionally cleaned up.
                    if not detail["exit"]["stopPath"]:
                        evidence["custodyChanged"] = True
                    elif captured_turn == "busy":
                        evidence["custodyChanged"] = True
                    elif captured_turn != "idle":
                        # The cleanup is receipted, but its effect on work we
                        # could not classify is still uncertain.
                        evidence["custodyUnknown"] = True
                if (isinstance(detail["exit"]["signal"], str) and detail["exit"]["signal"].upper() != "EOF"
                        and not detail["exit"]["stopPath"]):
                    evidence["custodyChanged"] = True
                    if scope and evidence["unitLeftActive"] and scope not in evidence["scopeStopped"]:
                        evidence["scopeStopped"].append(scope)
            except (OSError, ValueError, RuntimeError, KeyError, IndexError):
                evidence["custodyUnknown"] = True
        evidence["hosts"] = list(host_evidence.values())
        for entry, outcome in zip(hosts, protected):
            custody = host_evidence.get((entry["pid"], entry["startIdentity"]))
            if custody:
                outcome["custody"] = custody
            elif outcome["outcome"] == "preserved":
                evidence["custodyUnknown"] = True
        self.poll_relaunch_unit()
        return evidence

    def active_state(self):
        return systemd_properties(self.command(["systemctl", "--user", "show", self.unit, "-p", "ActiveState"])).get("ActiveState")

    def generation(self, group):
        """The serving generation's members of the service cgroup, read
        immediately before the stop: the recorded launcher, Viewer and runtime
        host, the launcher's verified ancestors up to MainPID, and helpers
        in the Viewer's process group. Detached descendants are never admitted
        by ancestry alone: a runtime host may have just started an agent.
        Each is held as PID and start identity; only these, and processes
        whose parents still reach them, can later be proven leftovers."""
        record = json.loads(self.record_file.read_text())
        rows = complete_activity(self.census())
        previous_agents = self.agents
        self.refreshed_hosts = self.capture_hosts(rows)
        self.agents = {**previous_agents, **self.agents}
        owners = {pid: ("agent", identity) for pid, identity in self.agents.items()}
        for key in ["launcher", "web", "runtimeHost"]:
            owners[record[key]["pid"]] = ("current", record[key].get("startIdentity"))
        try:
            ancestors = self.launcher_ancestors(record, group)
        except Exception:
            ancestors = {}
        self.retirement_roots = {record[key]["pid"]: record[key].get("startIdentity")
                                 for key in ["launcher", "web", "runtimeHost"]}
        self.retirement_roots.update({pid: link[0] for pid, link in ancestors.items()})
        viewer = record["web"]
        viewer_stat = self.process_read(viewer["pid"], "stat")
        self.viewer_group = viewer["pid"] if (start_identity(viewer_stat) == viewer.get("startIdentity")
                                               and process_group(viewer_stat) == viewer["pid"]) else None
        captured = {}
        for pid in self.members(group):
            try:
                stat = self.process_read(pid, "stat")
                identity = start_identity(stat)
                if self.helper_custody.get(pid, {}).get("startIdentity") == identity:
                    continue
                if self.agents.get(pid) == identity:
                    continue
                if (self.retirement_roots.get(pid) == identity
                        or (self.viewer_group is not None and process_group(stat) == self.viewer_group
                            and self.owner(pid, owners) == "current")):
                    captured[pid] = identity
            except (FileNotFoundError, ProcessLookupError):
                continue
        candidates = []
        for pid in self.members(group):
            if pid in captured:
                continue
            try:
                stat = self.process_read(pid, "stat")
                candidates.append({"pid": pid, "startIdentity": start_identity(stat), "reason": "no current serving or agent owner"})
            except (FileNotFoundError, ProcessLookupError):
                continue
        # Keep earlier custody even if its host just ended. It must never
        # acquire permission to be signalled during this switch.
        self.helper_custody.update(self.custody(group, candidates))
        if self.helper_custody:
            self.emit({"custody": list(self.helper_custody.values())})
        return captured

    def group_state(self, group):
        """Whether the old cgroup path holds no process, and whether it is
        released: its directory is gone, or systemd no longer names it."""
        root = self.cgroup_root / group.lstrip("/")
        if not root.is_dir():
            return {"empty": True, "released": True}
        try:
            empty = not self.members(group)
        except RuntimeError:
            if root.is_dir():
                raise
            return {"empty": True, "released": True}
        named = systemd_properties(self.command(["systemctl", "--user", "show", self.unit, "-p", "ControlGroup"])).get("ControlGroup")
        if named is None:
            raise RuntimeError("old cgroup release unreadable")
        return {"empty": empty, "released": not root.is_dir() or named != group}

    def await_release(self, group, bound):
        """Polls until the old cgroup is empty and released, within bound."""
        deadline = self.clock.now() + bound
        while True:
            try:
                state = self.group_state(group)
                if state["empty"] and state["released"]:
                    return True
            except Exception:
                pass
            if self.clock.now() >= deadline:
                return False
            self.clock.sleep(min(1, deadline - self.clock.now()))

    def survivors(self, group, captured):
        """Every process still in the old cgroup, with the evidence that does
        or does not tie it to the stopped generation. A survivor is proven
        when it, or a parent its chain still reaches, is a captured member
        with the same start identity. A chain that reaches an agent host, the
        user manager or a process that has exited proves nothing."""
        try:
            pids = self.members(group)
        except RuntimeError:
            if (self.cgroup_root / group.lstrip("/")).is_dir():
                raise
            pids = []
        found = []
        for pid in pids:
            stat, identity, args = None, None, []
            try:
                stat = self.process_read(pid, "stat")
                identity = start_identity(stat)
                args = self.process_read(pid, "cmdline").decode().split("\0")
                custody = self.helper_custody.get(pid)
                if custody and custody["startIdentity"] == identity:
                    host = self.process({"pid": custody["hostPid"], "startIdentity": custody["hostStartIdentity"]})
                    proven, reason = False, "protected helper custody; host " + ("alive" if host else "ended")
                else:
                    proven, reason = self.proof(pid, stat, captured)
                if start_identity(self.process_read(pid, "stat")) != identity:
                    proven, reason = False, "identity changed while read"
            except (FileNotFoundError, ProcessLookupError):
                if self.process({"pid": pid}) is None:
                    continue
                proven, reason = False, "parent chain unreadable"
            found.append({"pid": pid, "startIdentity": identity, "parentPid": parent_pid(stat) if stat else None,
                          "args": [arg for arg in args if arg], "name": process_name(args),
                          "proven": proven, "reason": reason})
        return found

    def proof(self, pid, stat, captured):
        # Helpers stay in the Viewer's group; agents and their children lead
        # detached groups. This remains evidence after a parent exits, and
        # excludes agents admitted after the activity read.
        if (self.retirement_roots.get(pid) != start_identity(stat)
                and process_group(stat) != self.viewer_group):
            owners = {pid: ("agent", identity) for pid, identity in self.agents.items()}
            return False, "agent host or its descendant" if self.owner(pid, owners) == "agent" else "no captured owner"
        current, seen = pid, set()
        while current > 1 and current not in seen and len(seen) < 64:
            seen.add(current)
            link = stat if current == pid else self.process_read(current, "stat")
            identity = start_identity(link)
            if self.agents.get(current) == identity:
                return False, "agent host or its descendant"
            if captured.get(current) == identity:
                return True, "captured serving generation" if current == pid else "descends from captured serving generation"
            current = parent_pid(link)
        return False, "no captured owner"

    def lingering(self, survivor, group):
        process = self.process({"pid": survivor["pid"], "startIdentity": survivor["startIdentity"]})
        if process is None:
            return False
        try:
            return within(kernel_cgroup(self.process_read(survivor["pid"], "cgroup")), group)
        except (FileNotFoundError, ProcessLookupError):
            return False

    def retire(self, proven, group):
        """Terminates, then kills, the proven survivors, each by PID through a
        descriptor validated against its start identity and cgroup."""
        # Keep each survivor's proof after its parent is retired. The final
        # pidfd read still requires its identity and Viewer process group.
        captured = {**self.retirement_capture,
                    **{entry["pid"]: entry["startIdentity"] for entry in proven}}
        signalled = []
        for signum in [signal.SIGTERM, signal.SIGKILL]:
            alive = [survivor for survivor in proven if self.lingering(survivor, group)]
            if not alive:
                break
            for survivor in alive:
                with contextlib.suppress(Exception):
                    def verified_read(pid, field):
                        value = self.process_read(pid, field)
                        if field == "stat" and pid == survivor["pid"] and not self.proof(pid, value, captured)[0]:
                            raise RuntimeError("retirement ownership changed")
                        return value
                    if self.signal_process(survivor, signum, group, verified_read):
                        signalled.append({"pid": survivor["pid"], "startIdentity": survivor["startIdentity"],
                                          "signal": signal.Signals(signum).name})
            deadline = self.clock.now() + SIGNAL_WAIT
            while any(self.lingering(survivor, group) for survivor in alive) and self.clock.now() < deadline:
                self.clock.sleep(min(0.2, deadline - self.clock.now()))
        return signalled

    def start(self, relocation, attempts=START_ATTEMPTS):
        """Starts the unit, retrying a refused or failed start. Whatever the
        relocation found, this always runs once a stop was submitted."""
        for attempt in range(attempts):
            if attempt:
                self.clock.sleep(5)
            try:
                relocation["startAttempts"] += 1
                self.command(["systemctl", "--user", "--no-block", "start", self.unit])
                def settled():
                    if self.jobs():
                        raise RuntimeError("named start pending")
                retry(settled, self.clock, STOP_SETTLE)
                state = self.active_state()
                if state == "active":
                    relocation["started"] = True
                    relocation["outcome"] = relocation["stopOutcome"]
                    return
            except Exception as error:
                diagnostic = "start:" + type(error).__name__
                if diagnostic not in relocation["diagnostics"]:
                    relocation["diagnostics"].append(diagnostic)
        relocation["started"] = False
        relocation["outcome"] = "start-failed"

    def recover_start(self, attempts=1):
        relocation = self.relocation
        try:
            if not self.jobs() and self.active_state() == "active":
                relocation["started"] = True
                relocation["outcome"] = relocation["stopOutcome"]
                return
        except Exception:
            pass
        self.start(relocation, attempts)
        with contextlib.suppress(Exception):
            observed = self.placement()
            relocation["placement"] = "placed" if observed["actual"] == observed["expected"] else "failed"
            relocation["to"] = observed["actual"]

    def restart(self):
        """Stop, wait for the old cgroup to empty and be released, then start.
        A plain restart cannot move the unit: systemd keeps a populated
        cgroup's path and starts the replacement in it, so one old descendant
        alive during the stop pins the service outside its configured slice
        (2026-10-11). Submission can time out while systemd continues its
        named job. No rollback or second switch is issued by this procedure,
        and once the stop is submitted the start always follows."""
        with deferred_termination():
            return self.relocate()

    def relocate(self):
        placement = self.placement()
        group = placement["actual"]
        relocation = {"from": group, "stopSubmitted": False, "released": False, "survivors": [],
                      "signalled": [], "started": False, "startAttempts": 0,
                      "outcome": None, "placement": None, "diagnostics": []}
        self.relocation = relocation
        try:
            try:
                captured = self.generation(group)
            except Exception as error:
                # Without the capture no survivor can be proven, so none is signalled.
                captured = {}
                relocation["diagnostics"].append("generation:" + type(error).__name__)
            relocation["captured"] = len(captured)
            self.retirement_capture = captured
            if self.switch_mode == "relocation":
                if group == placement["expected"] or self.placement()["actual"] != group:
                    raise SwitchRefused("service placement changed before relocation")
                self.require_relocation_safe()
            # Marked before submission: a submission that times out may still stop.
            relocation["stopSubmitted"] = True
            self.command(["systemctl", "--user", "--no-block", "stop", self.unit])
            def stopped():
                if self.jobs() or self.active_state() not in ["inactive", "failed"]:
                    raise RuntimeError("named stop pending")
            retry(stopped, self.clock, STOP_SETTLE)
            if self.await_release(group, RELEASE_WAIT):
                relocation["released"], relocation["outcome"] = True, "released"
            else:
                survivors = self.survivors(group, captured)
                relocation["survivors"] = survivors
                if any(not survivor["proven"] for survivor in survivors):
                    # Signalling the proven ones could not release the path.
                    relocation["outcome"] = "unproven-survivors"
                elif not survivors:
                    # Emptied since the bound passed, or systemd still names
                    # the empty path it would reuse.
                    relocation["released"] = self.await_release(group, 0)
                    relocation["outcome"] = "released" if relocation["released"] else "not-released"
                else:
                    relocation["signalled"] = self.retire(survivors, group)
                    relocation["released"] = self.await_release(group, RELEASE_WAIT)
                    relocation["outcome"] = "released-after-retirement" if relocation["released"] else "not-released"
        except SwitchRefused as error:
            relocation["diagnostics"].append(str(error))
            relocation["outcome"] = "stop-refused"
        except Exception as error:
            relocation["diagnostics"].append("relocation:" + type(error).__name__)
            relocation["outcome"] = relocation["outcome"] or "stop-incomplete"
        finally:
            if relocation["stopSubmitted"]:
                relocation["stopOutcome"] = relocation["outcome"]
                self.start(relocation)
            with contextlib.suppress(Exception):
                observed = self.placement()
                relocation["placement"] = "placed" if observed["actual"] == observed["expected"] else "failed"
                relocation["to"] = observed["actual"]
            with contextlib.suppress(Exception):
                self.emit({"relocation": relocation})
        if not relocation["started"]:
            raise RuntimeError("named service start refused")
        return relocation

    def stage(self, host):
        answer = self.mcp.call("get_pipeline", {"pipelineId": host["pipelineId"], "full": True})
        pipeline = answer["pipeline"]
        run = next((r for r in pipeline["runs"] if r["stageId"] == host["stageId"]), None)
        attempts = run["attempts"] if run else []
        current = max((a for a in attempts if not a.get("historical")), key=lambda a: a["n"], default={})
        activity = {}
        if current.get("conversationId") and current.get("state") in ["running", "reviewing", "committing"]:
            result = self.mcp.call("agent_activity", {"conversationId": current["conversationId"], "compact": False, "includeGone": True})
            rows = complete_activity(result)
            if len(rows) == 1 and rows[0].get("conversationId") == current["conversationId"]:
                activity = rows[0]
                live = activity.get("host") or {}
                if live.get("state") == "alive" and self.process({"pid": live.get("pid")}) is None:
                    activity = {**activity, "host": {"state": "gone"}}
        outcome = stage_outcome(host, attempts, activity)
        if outcome["outcome"] == "unknown":
            raise RuntimeError("protected stage recovery pending")
        return {"pipelineId": host["pipelineId"], **outcome}

    def serving(self):
        record = json.loads(self.record_file.read_text())
        result = {"checks": {}, "observedAt": utc()}
        for role, key in [("launcher", "launcher"), ("viewer", "web"), ("runtimeHost", "runtimeHost")]:
            entry = record[key]
            observed = {"sha": None, "since": None, "healthy": False}
            result[role] = observed
            try:
                proc = self.process(entry)
                if proc is None or not entry.get("startIdentity"):
                    continue
                root = pathlib.Path(proc["cwd"])
                if role == "launcher":
                    cli = next(arg for arg in proc["args"] if arg.endswith("/bin/cli.mjs"))
                    root = pathlib.Path(cli).parent.parent
                sha = self.head(root)
                if entry.get("revision") not in [sha, sha[:7]]:
                    continue
                observed["sha"] = sha
                if role == "launcher":
                    observed["since"] = self.clock.process_since(proc["startIdentity"])
                else:
                    observed["since"] = entry["startedAt"]
                    datetime.datetime.fromisoformat(entry["startedAt"].replace("Z", "+00:00"))
                observed["healthy"] = entry.get("state", "healthy") == "healthy"
            except Exception:
                observed["healthy"] = False
        def check(name, read):
            try:
                read()
                result["checks"][name] = True
            except Exception:
                result["checks"][name] = False
        def web():
            port = record["port"]
            page = self.http(port, "/", self.token).decode()
            chunks = re.findall(r'["\x27](/_next/static/[^"\x27?#]+\.js)["\x27]', page)
            if not chunks or not self.http(port, chunks[0], self.token):
                raise RuntimeError("page script unavailable")
            # Tasks require a nonempty project. The empty-project filter still
            # loads the board store, but its answer is independent of board size.
            if not isinstance(json.loads(self.http(port, "/api/tasks?project=", self.token)).get("tasks"), list):
                raise RuntimeError("board read unavailable")
            # Serving identity and auto-update state need only the installation snapshot.
            update = json.loads(self.http(port, "/api/self-update?work=0&readOnly=1", self.token))
            if update["auto"]["enabled"] or update["auto"].get("drain"):
                raise RuntimeError("automatic update competes with external switch")
            for role, key in [("viewer", "web"), ("runtimeHost", "runtimeHost")]:
                if (update["serving"][key]["sha"] != result[role]["sha"]
                        or update["processes"][key]["state"] != "healthy"):
                    raise RuntimeError("HTTP serving identity mismatch")
        check("http", web)
        check("runtimeSocket", lambda: self.runtime(record))
        check("mcp", lambda: self.mcp.call("agent_activity", {"liveOnly": True, "limit": 1}))
        def service():
            if self.command(["systemctl", "--user", "show", self.unit, "-p", "ActiveState"]) != "ActiveState=active" or self.jobs():
                raise RuntimeError("named service not settled")
            listeners = self.command(["ss", "-ltnp", "sport = :" + str(record["port"])])
            if set(re.findall(r"pid=(\d+)", listeners)) != {str(record["web"]["pid"])}:
                raise RuntimeError("Viewer listener identity mismatch")
        check("service", service)
        def placement():
            observed = self.placement()
            result["placement"] = observed
            if observed["slice"] != CPU_SLICE or observed["actual"] != observed["expected"]:
                with contextlib.suppress(Exception):
                    observed["leftovers"] = self.leftovers(observed["actual"])
                raise RuntimeError("required CPU slice not in effect")
            for key in ["launcher", "web", "runtimeHost"]:
                if not within(kernel_cgroup(self.process_read(record[key]["pid"], "cgroup")), observed["actual"]):
                    raise RuntimeError("serving process outside the service cgroup")
            # The unit accepts CPUWeight= even where its parent never enabled
            # the cpu controller; only the kernel file says it is in effect.
            try:
                observed["effectiveWeight"] = (self.cgroup_root / observed["actual"].lstrip("/") / "cpu.weight").read_text().strip()
            except OSError:
                observed["effectiveWeight"] = None
            if observed["weight"] != CPU_WEIGHT or observed["effectiveWeight"] != CPU_WEIGHT:
                raise RuntimeError("required CPU weight not in effect")
        check("placement", placement)
        return result

    def emit(self, event):
        if self.run_dir is None:
            return
        event = {"at": utc(), **event}
        with open(self.run_dir / "switch.log", "a", opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
            stream.write(json.dumps(event) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        if "verdict" in event:
            write_json(self.run_dir / "verdict.json", event)
            serving = " ".join(role + "=" + str(event["serving"].get(role, {}).get("sha"))
                               + " since=" + str(event["serving"].get(role, {}).get("since"))
                               for role in ["launcher", "viewer", "runtimeHost"])
            placement = event["serving"].get("placement")
            if placement and event["serving"].get("checks", {}).get("placement") is False:
                serving += " placement=FAILED expected=" + placement["expected"] + " actual=" + placement["actual"]
                serving += " Slice=" + placement["slice"] + "/" + CPU_SLICE
                serving += " cpu.weight=" + str(placement.get("effectiveWeight")) + "/" + CPU_WEIGHT
                serving += " CPUWeight=" + str(placement.get("weight"))
            relocation = event.get("relocation")
            if relocation:
                serving += " relocation=" + str(relocation.get("outcome"))
            if event.get("relaunch"):
                serving += " relaunch=" + event["relaunch"]["result"]
            recovery = event.get("recovery")
            if recovery:
                serving += " recovery=" + recovery["state"] + " ownerPid=" + str(recovery["ownerPid"])
            with open(self.run_dir / "switch.log", "a") as stream:
                stream.write("Verdict: " + event["verdict"] + " " + serving + "\n")
            write_json(self.run_dir.parent / ("latest-" + self.install + ".json"),
                       {"run": self.run_dir.name, "verdict": event["verdict"],
                        ("observedAt" if recovery and recovery["state"] == "pending" else "finishedAt"): event["at"],
                        **({"recovery": recovery} if recovery else {})})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="private, explicit checkout deploy plan")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--preflight", action="store_true", help="read-only validation")
    modes.add_argument("--start", action="store_true", help="schedule the approved switch in a separate user unit")
    modes.add_argument("--worker", help=argparse.SUPPRESS)
    parser.add_argument("--approved", action="store_true", help="the named pointer publication and restart have operator approval")
    args = parser.parse_args()
    if not args.config or ((args.start or args.worker) and not args.approved):
        parser.error("a plan and explicit switch approval are required")
    if args.worker and not re.fullmatch(r"[0-9a-f]{32}", args.worker):
        parser.error("invalid worker id")
    adapter = None
    result = None
    try:
        adapter = Checkout(args.config, args.worker)
        if args.preflight:
            adapter.preflight()
            if adapter.helper_custody:
                waiters = sum(member["role"] == "wait-owner" for member in adapter.helper_custody.values())
                print("Protected helper custody: " + str(waiters) + " wait owners and "
                      + str(len(adapter.helper_custody) - waiters) + " helpers of live agent hosts")
            print("Switch mode: " + ("relaunch in place" if adapter.switch_mode == "relaunch" else "relocation (stop and start)"))
            print("Preflight: pass; no switch performed")
            return 0
        if args.start:
            adapter.preflight()
            run_id = uuid.uuid4().hex
            directory = adapter.state / "deploy-verdicts" / run_id
            directory.mkdir(parents=True, mode=0o700)
            plan = directory / "plan.json"
            write_json(plan, adapter.plan)
            write_json(directory / "status.json", {"phase": "scheduled", "at": utc()})
            command(detached_command(str(pathlib.Path(__file__).resolve()), str(plan), str(adapter.state), run_id))
            print("Detached switch scheduled; verdict: " + str(directory / "verdict.json"))
            return 0
        # Verify that this worker is outside the installation service's cgroup.
        expected = command(["systemctl", "--user", "show", "delegatus-deploy-" + args.worker + ".service", "-p", "MainPID", "--value"])
        if expected != str(os.getpid()):
            raise RuntimeError("worker must run in its own detached unit")
        import fcntl
        with open(adapter.run_dir.parent / ("lock-" + adapter.install), "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            write_json(adapter.run_dir / "status.json", {"phase": "running", "at": utc(), "pid": os.getpid()})
            result = run_switch(adapter, adapter.target)
            write_json(adapter.run_dir / "status.json", {"phase": "finished", "at": utc(), "verdict": result["verdict"]})
            return {"pass": 0, "fail": 1, "needs_decision": 2}[result["verdict"]]
    except Exception as error:
        # Public console output never carries arbitrary exception text.
        leftovers = error.members if isinstance(error, LeftoverProcesses) else None
        if adapter and adapter.run_dir:
            observed = result or getattr(adapter, "last_result", None)
            if observed is None:
                diagnostic = str(error) if isinstance(error, SwitchRefused) else type(error).__name__
                adapter.emit({"verdict": "needs_decision", "serving": {}, "diagnostics": [diagnostic],
                              "phase": "before-switch", **({"leftovers": leftovers} if leftovers else {})})
        for line in leftover_lines(leftovers or []):
            print(line, file=sys.stderr)
        if isinstance(error, BaselineReadinessError):
            print("Procedure stopped: " + ", ".join(error.checks), file=sys.stderr)
        elif isinstance(error, SwitchRefused):
            print("Procedure stopped: " + str(error), file=sys.stderr)
        else:
            print("Procedure stopped: " + type(error).__name__, file=sys.stderr)
        return 2
    finally:
        if adapter:
            adapter.close()


if __name__ == "__main__":
    sys.exit(main())
