"""Detached, observable checkout switch. Importing this module performs no I/O."""
import argparse
import datetime
import json
import os
import pathlib
import re
import select
import shlex
import socket
import subprocess
import sys
import tempfile
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


def ready(serving, target):
    return all(serving.get(role, {}).get("sha") == target
               and serving.get(role, {}).get("healthy") is True
               for role in ["launcher", "viewer", "runtimeHost"]) and all(serving.get("checks", {}).values())


def run_switch(adapter, target, samples=21, interval=15, timeout=180):
    old, hosts = adapter.preflight()
    started = utc()
    diagnostics = []
    serving = {}
    protected = []
    # Even a publication call which raises after its atomic rename owes samples.
    try:
        adapter.publish()
        adapter.restart()
    except Exception as error:
        diagnostics.append(type(error).__name__)
    finally:
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
    # before it re-hosts anything, long before the last sample.
    interrupted = []
    try:
        interrupted = adapter.interrupted(started, hosts)
    except Exception as error:
        diagnostics.append("interrupted:" + type(error).__name__)
    healthy = ready(serving, target)
    outcomes = {entry["outcome"] for entry in protected}
    verdict = "fail" if not healthy or "lost" in outcomes else "needs_decision" if "unknown" in outcomes else "pass"
    result = {"verdict": verdict, "target": target, "serving": serving,
              "protected": protected, "interrupted": interrupted, "diagnostics": diagnostics}
    adapter.last_result = result
    adapter.emit(result)
    return result


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def parse_time(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def interrupted_conversations(state, since, hosts=()):
    """The conversations whose turn this switch cut, as the Viewers recorded
    them: an incumbent at release, the booting successor at restart. Each names
    its pipeline stage when it ran one; a stage the preflight protected names it
    from that capture when the record does not."""
    directory = pathlib.Path(state) / "interruption-obligations"
    records = {}
    sources = sorted(directory.glob("interruption-continuation-*.json")) if directory.is_dir() else []
    for source in sources:
        try:
            record = json.loads(source.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and isinstance(record.get("id"), str):
            records[record["id"]] = record
    pending = directory.with_name(directory.name + ".pending.jsonl")
    if pending.is_file():
        for line in pending.read_text().splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and isinstance(record.get("id"), str):
                records.setdefault(record["id"], record)
    boundary = parse_time(since)
    protected = {host.get("conversationId"): host for host in hosts if host.get("conversationId")}
    listed = []
    for record in records.values():
        try:
            if parse_time(record["recordedAt"]) < boundary:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        conversation = record.get("conversationId")
        stage = record.get("stage")
        host = protected.get(conversation)
        if not stage and host:
            stage = {"pipelineId": host.get("pipelineId"), "stageId": host.get("stageId"), "attempt": host.get("attempt")}
        checkpoint = record.get("checkpoint") or {}
        listed.append({"conversationId": conversation, "recordedAt": record["recordedAt"],
                       "reason": record.get("reason"), "state": record.get("state"),
                       "resolution": record.get("resolution"), "stage": stage or None,
                       "backgroundTasks": checkpoint.get("backgroundTasks") or []})
    return sorted(listed, key=lambda entry: (entry["recordedAt"], entry["conversationId"] or ""))


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
                 runtime=socket_health, execute=command, clock=None, mcp_factory=Mcp):
        self.clock = clock or Clock()
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
            if not ready(self.serving(), self.baseline["sha"]):
                raise RuntimeError("baseline serving health unavailable")
        retry(baseline_ready, self.clock, 30)
        def capture():
            answer = self.mcp.call("agent_activity", {"liveOnly": True, "compact": False, "limit": 200})
            return complete_activity(answer)
        rows = retry(capture, self.clock, 30)
        hosts = []
        for row in rows:
            host, pipeline = row.get("host") or {}, row.get("pipeline")
            if pipeline and host.get("state") == "alive" and row.get("turnState") == "busy":
                entry = {"pid": host["pid"]}
                proc = self.process(entry)
                hosts.append({**entry, "startIdentity": proc["startIdentity"] if proc else None,
                              "conversationId": row["conversationId"], "pipelineId": pipeline["pipelineId"],
                              "stageId": pipeline["stageId"], "attempt": pipeline["attempt"]})
        return [record[role] for role in ["launcher", "web", "runtimeHost"]], hosts

    def publish(self):
        # Repeat the immutability fences immediately before the atomic write.
        if (json.loads(self.pointer.read_text()) != self.baseline
                or self.head(self.checkout) != self.plan["checkoutHead"] or self.head(self.release) != self.target):
            raise RuntimeError("publication inputs changed")
        write_json(self.pointer, {"sha": self.target, "dir": str(self.release),
                                  "checkoutHead": self.plan["checkoutHead"], "publishedAt": utc()})
        self.emit({"published": self.target})

    def restart(self):
        # Submission can time out while systemd continues its named job.
        # No rollback or second restart is issued by this procedure.
        self.command(["systemctl", "--user", "--no-block", "restart", self.unit])
        def settled():
            if self.jobs():
                raise RuntimeError("named restart pending")
        retry(settled, self.clock, 300)

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
            if not isinstance(json.loads(self.http(port, "/api/tasks", self.token)).get("tasks"), list):
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
        if adapter and adapter.run_dir:
            observed = result or getattr(adapter, "last_result", None)
            if observed is None:
                adapter.emit({"verdict": "needs_decision", "serving": {}, "diagnostics": [type(error).__name__], "phase": "before-switch"})
        print("Procedure stopped: " + type(error).__name__, file=sys.stderr)
        return 2
    finally:
        if adapter:
            adapter.close()


if __name__ == "__main__":
    sys.exit(main())
