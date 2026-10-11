"""Detached, observable checkout switch. Importing this module performs no I/O."""
import argparse
import contextlib
import datetime
import json
import os
import pathlib
import re
import select
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid


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
    # Keep termination deferred through recovery and the final cleanup, too.
    with deferred_termination():
        result = None
        try:
            result = observe_switch(adapter, target, samples, interval, timeout)
        finally:
            relocation = getattr(adapter, "relocation", None)
            if relocation and relocation["stopSubmitted"]:
                attempts = relocation["startAttempts"]
                adapter.recover_start(attempts=START_ATTEMPTS)
                if result is not None and relocation["startAttempts"] != attempts:
                    # The last health sample predates this recovery operation.
                    result["verdict"] = "fail"
                    result["diagnostics"].append("exit-recovery:health-unverified")
        adapter.emit(result)
        return result


def observe_switch(adapter, target, samples, interval, timeout):
    old, hosts = adapter.preflight()
    started = utc()
    diagnostics = []
    serving = {}
    protected = []
    relocation = None
    # Even a publication call which raises after its atomic rename owes samples.
    try:
        adapter.publish()
        relocation = adapter.restart()
    except Exception as error:
        diagnostics.append(type(error).__name__)
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
                retry(read_serving, adapter.clock, timeout)
            except Exception as error:
                diagnostics.append(type(error).__name__)
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
    verdict = "fail" if not healthy or "lost" in outcomes else "needs_decision" if unknown else "pass"
    result = {"verdict": verdict, "target": target, "serving": serving,
              "protected": protected, "interrupted": interrupted,
              "interruptedUnreadable": unreadable, "relocation": relocation, "diagnostics": diagnostics}
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


def obligation_places(directory, pending):
    """Every place a record can be, by what would change if one moved: the
    pending journal and each import claim by file identity, the record
    directory by its names. A rename, an append, a publication and a deleted
    claim each change one of them."""
    try:
        beside = sorted(os.listdir(directory.parent))
    except FileNotFoundError:
        beside = []
    claims = tuple((name, file_identity(directory.parent / name))
                   for name in beside if name.startswith(PENDING_JOURNAL + ".claim-"))
    names = tuple(sorted(os.listdir(directory))) if os.path.lexists(directory) else ()
    return file_identity(pending), claims, names


def read_obligations(directory, pending, claims):
    journaled = {}
    unreadable = []
    read_journal(pending, journaled, unreadable)
    for name in claims:
        read_journal(directory.parent / name, journaled, unreadable)
    records = {}
    names = sorted(os.listdir(directory)) if os.path.lexists(directory) else []
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
    directory, returns the ones the directory refused to the journal and only
    then deletes the claim. A later import takes over a claim one died holding
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


def write_json(destination, body):
    """Private atomic results remain readable if the launching turn disappears."""
    destination = pathlib.Path(destination)
    fd, name = tempfile.mkstemp(prefix=".deploy-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(body, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, destination)
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def proc_field(pid, field):
    proc = pathlib.Path("/proc") / str(pid)
    if field == "cwd":
        return os.readlink(proc / field)
    if field == "cmdline":
        return (proc / field).read_bytes()
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
                 cgroup_root="/sys/fs/cgroup", signal_process=pidfd_signal):
        self.clock = clock or Clock()
        self.signal_process = signal_process
        self.relocation = None
        self.cgroup_root = pathlib.Path(cgroup_root)
        self.agents = {}
        self.retirement_roots = {}
        self.viewer_group = None
        self.leftovers_found = []
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
        if json.loads(self.pointer.read_text()) != self.baseline:
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
            if not ready(self.serving(), self.baseline["sha"], placement=False):
                raise RuntimeError("baseline serving health unavailable")
        retry(baseline_ready, self.clock, 30)
        def capture():
            answer = self.mcp.call("agent_activity", {"liveOnly": True, "compact": False, "limit": 200})
            return complete_activity(answer)
        rows = retry(capture, self.clock, 30)
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
        # Last, so the inventory is read immediately before publication.
        self.fence()
        return [record[role] for role in ["launcher", "web", "runtimeHost"]], hosts

    def placement(self):
        """The slice the unit configures and the cgroup it actually runs in.
        A missing value is unreadable, never a match."""
        unit = systemd_properties(self.command(["systemctl", "--user", "show", self.unit,
                                                "-p", "Slice", "-p", "ControlGroup", "-p", "CPUWeight"]))
        configured, actual = unit.get("Slice"), unit.get("ControlGroup")
        if not configured or not actual:
            raise RuntimeError("service placement unreadable")
        parent = systemd_properties(self.command(["systemctl", "--user", "show", configured, "-p", "ControlGroup"])).get("ControlGroup")
        if not parent:
            raise RuntimeError("slice placement unreadable")
        # "[not set]" leaves the kernel default; only a configured weight is owed.
        weight = unit.get("CPUWeight", "")
        return {"slice": configured, "expected": parent.rstrip("/") + "/" + self.unit, "actual": actual,
                "weight": weight if re.fullmatch(r"[0-9]+", weight) else None}

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

    def publish(self):
        # Repeat the immutability fences immediately before the atomic write.
        if (json.loads(self.pointer.read_text()) != self.baseline
                or self.head(self.checkout) != self.plan["checkoutHead"] or self.head(self.release) != self.target):
            raise RuntimeError("publication inputs changed")
        write_json(self.pointer, {"sha": self.target, "dir": str(self.release),
                                  "checkoutHead": self.plan["checkoutHead"], "publishedAt": utc()})
        self.emit({"published": self.target})

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
        rows = complete_activity(self.mcp.call("agent_activity", {"liveOnly": True, "compact": False, "limit": 200}))
        for row in rows:
            host = row.get("host") or {}
            if host.get("state") == "alive" and isinstance(host.get("pid"), int):
                proc = self.process({"pid": host["pid"]})
                if proc:
                    self.agents[host["pid"]] = proc["startIdentity"]
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
                if self.agents.get(pid) == identity:
                    continue
                if (self.retirement_roots.get(pid) == identity
                        or (self.viewer_group is not None and process_group(stat) == self.viewer_group
                            and self.owner(pid, owners) == "current")):
                    captured[pid] = identity
            except (FileNotFoundError, ProcessLookupError):
                continue
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
                if state in ["active", "activating", "reloading"]:
                    relocation["started"] = True
                    relocation["outcome"] = relocation["stopOutcome"]
                    return
            except Exception as error:
                relocation["diagnostics"].append("start:" + type(error).__name__)
        relocation["started"] = False
        relocation["outcome"] = "start-failed"

    def recover_start(self, attempts=1):
        relocation = self.relocation
        try:
            if self.active_state() in ["active", "activating", "reloading"]:
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
        group = self.placement()["actual"]
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
            update = json.loads(self.http(port, "/api/self-update", self.token))
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
            if observed["actual"] != observed["expected"]:
                with contextlib.suppress(Exception):
                    observed["leftovers"] = self.leftovers(observed["actual"])
                raise RuntimeError("service runs outside its configured slice")
            for key in ["launcher", "web", "runtimeHost"]:
                if not within(kernel_cgroup(self.process_read(record[key]["pid"], "cgroup")), observed["actual"]):
                    raise RuntimeError("serving process outside the service cgroup")
            if observed["weight"] is not None:
                # The unit accepts CPUWeight= even where its parent never enabled
                # the cpu controller; only the kernel file says it is in effect.
                try:
                    observed["effectiveWeight"] = (self.cgroup_root / observed["actual"].lstrip("/") / "cpu.weight").read_text().strip()
                except OSError:
                    observed["effectiveWeight"] = None
                if observed["effectiveWeight"] != observed["weight"]:
                    raise RuntimeError("configured CPU weight not in effect")
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
                if placement.get("weight") is not None:
                    serving += " cpu.weight=" + str(placement.get("effectiveWeight")) + "/" + placement["weight"]
            relocation = event.get("relocation")
            if relocation:
                serving += " relocation=" + str(relocation.get("outcome"))
            with open(self.run_dir / "switch.log", "a") as stream:
                stream.write("Verdict: " + event["verdict"] + " " + serving + "\n")
            write_json(self.run_dir.parent / ("latest-" + self.install + ".json"),
                       {"run": self.run_dir.name, "verdict": event["verdict"], "finishedAt": event["at"]})


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
                adapter.emit({"verdict": "needs_decision", "serving": {}, "diagnostics": [type(error).__name__],
                              "phase": "before-switch", **({"leftovers": leftovers} if leftovers else {})})
        for line in leftover_lines(leftovers or []):
            print(line, file=sys.stderr)
        print("Procedure stopped: " + type(error).__name__, file=sys.stderr)
        return 2
    finally:
        if adapter:
            adapter.close()


if __name__ == "__main__":
    sys.exit(main())
