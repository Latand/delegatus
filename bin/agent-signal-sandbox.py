#!/usr/bin/env python3
"""Enter a managed invocation's signal domain before executing its engine."""
import argparse
import ctypes
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

POLICY = 1
# The Viewer passes its own budgets; a terminal launch has no Viewer waiting.
READINESS = int(os.environ.get("LLV_SIGNAL_READINESS_MS") or 10_000) / 1000
ACK = int(os.environ.get("LLV_SIGNAL_ACK_MS") or 15_000) / 1000
LAUNCH_ENV = ("LLV_SIGNAL_LAUNCHER", "LLV_SIGNAL_RECEIPT", "LLV_SIGNAL_AUTOMATIC", "LLV_SIGNAL_DIAGNOSTIC",
              "LLV_SIGNAL_IGNORE_NATIVE_STDIO", "LLV_SIGNAL_READINESS_MS", "LLV_SIGNAL_ACK_MS")


class Unavailable(Exception):
    """The boundary cannot be established and the engine has not executed."""


class Committed(Exception):
    """The receipt was published; the engine may run and is never relaunched."""


def read(file):
    return Path(file).read_text()


def atomic(file, value):
    target = Path(str(file) + ".new")
    target.write_text(json.dumps(value))
    target.chmod(0o600)
    target.replace(file)


def start(pid):
    try:
        fields = read(f"/proc/{pid}/stat").rsplit(")", 1)[1].split()
        return None if fields[0] in ("Z", "X", "x") else f"{pid}:{fields[19]}"
    except (OSError, IndexError):
        return None


def identity(pid, epoch):
    token = start(pid)
    if not token:
        raise RuntimeError("process start identity is unavailable")
    return {"pid": pid, "startIdentity": token, "bootEpoch": epoch}


def send(record, sig):
    if record and start(record["pid"]) == record["startIdentity"]:
        try:
            os.kill(record["pid"], sig)
        except ProcessLookupError:
            pass


def group():
    return next(line[3:] for line in read("/proc/self/cgroup").splitlines() if line.startswith("0::"))


def wait_file(file, child=None, end=None):
    end = end if end is not None else time.monotonic() + READINESS
    while time.monotonic() < end:
        if Path(file).exists():
            try:
                return json.loads(read(file))
            except json.JSONDecodeError:
                # Bubblewrap writes its info FD directly; the other receipts
                # use atomic rename. A partial info write is not readiness.
                pass
        if child and child.poll() is not None:
            raise RuntimeError("namespace setup ended before readiness")
        time.sleep(0.01)
    raise RuntimeError("namespace readiness deadline expired")


def inner(directory, command):
    hostproc = directory / "proc"
    status = dict(line.split(":", 1) for line in read("/proc/self/status").splitlines() if ":" in line)
    ready = {
        "pid": int(os.readlink(hostproc / "self")),
        "localPid": os.getpid(),
        "pidNamespace": os.readlink("/proc/self/ns/pid"),
        "userNamespace": os.readlink("/proc/self/ns/user"),
        "uid": os.getuid(), "gid": os.getgid(),
        "caps": status["CapEff"].strip(), "noNewPrivileges": status["NoNewPrivs"].strip(),
        "cgroup": group(),
        "parentHostPid": int(next(line.split(':', 1)[1] for line in read(hostproc / 'self/status').splitlines() if line.startswith('PPid:'))),
    }
    if ready["localPid"] <= 1 or int(ready["caps"], 16) or ready["noNewPrivileges"] != "1":
        raise RuntimeError("namespace privilege proof failed")
    # A proc mount made in this namespace reports only its local PID here.
    if status["NSpid"].split() != [str(os.getpid())]:
        raise RuntimeError("normal proc is not private")
    atomic(directory / "inner.json", ready)
    # The Viewer acknowledges a receipt up to readiness plus ACK after it
    # started; this side started later and waits one ACK beyond that.
    wait_file(directory / "exec.json", end=time.monotonic() + READINESS + 2 * ACK)
    os.environ["LLV_SIGNAL_SANDBOX"] = read(directory / "context.json")
    execute(command)


def execute(command):
    # Socket engines outlive their Viewer and inherit no Viewer pipes. Only
    # pre-exec setup writes the owned diagnostic file; native output is ignored.
    if os.environ.get("LLV_SIGNAL_IGNORE_NATIVE_STDIO") == "1":
        with open(os.devnull, "r+b", buffering=0) as null:
            for descriptor in (0, 1, 2):
                os.dup2(null.fileno(), descriptor)
    for name in LAUNCH_ENV:
        os.environ.pop(name, None)
    os.execvp(command[0], command)


def unprotected(options, command, reason):
    """Run the engine as main does and report that the boundary is off."""
    reason = str(reason)[:500] or "the boundary could not be established"
    if options.receipt:
        Path(options.receipt).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic(options.receipt, {"policyVersion": POLICY, "boundary": "off", "reason": reason})
    if options.terminal or options.automatic or not options.receipt:
        # Terminal panes and headless logs carry the report; structured hosts
        # record the receipt instead of engine stderr.
        print(f"agent signal sandbox: boundary off, running unprotected: {reason}", file=sys.stderr, flush=True)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGWINCH):
        signal.signal(sig, signal.SIG_DFL)
    try:
        execute(command)
    except OSError as error:
        print(f"agent engine could not start: {error}", file=sys.stderr, flush=True)
        os._exit(127)


def nested_domain():
    """An engine launched from inside a domain stays inside that domain."""
    try:
        context = json.loads(os.environ.get("LLV_SIGNAL_SANDBOX") or "null")
        return bool(context) and os.readlink("/proc/self/ns/pid") != context["hostPidNamespace"]
    except (OSError, ValueError, KeyError, TypeError):
        return False


def launch(options, command):
    if os.getuid() == 0:
        return unprotected(options, command, "managed signal domains require a non-root user")
    if os.environ.get("LLV_GATE_SLOT_LEASE"):
        return unprotected(options, command, "an inherited gate slot lease cannot cross a user namespace")
    if nested_domain():
        # Its PID namespace, scope and context still bind this engine.
        return unprotected(options, command, "launched inside an existing agent signal domain, whose boundary still applies")
    for binary in ("bwrap", "python3", "systemd-run"):
        if not shutil.which(binary):
            return unprotected(options, command, f"required host dependency is missing: {binary}")
    if not options.scope:
        try:
            argv = scope_command(options)
        except Exception as error:
            return unprotected(options, command, f"transient scope is unavailable: {error}")
        try:
            os.execvp(argv[0], argv + ["--"] + command)
        except OSError as error:
            return unprotected(options, command, f"transient scope could not start: {error}")
    try:
        return protected(options, command)
    except Unavailable as error:
        return unprotected(options, command, error)


def scope_command(options):
    version = subprocess.check_output(["systemd-run", "--version"], text=True, timeout=5).split()[1]
    expand = ["--expand-environment=no"] if int(version) >= 254 else []
    # systemd-run replaces this process, so a manager that refuses the scope
    # would end the launch without the engine. Probe the same request first.
    probe = subprocess.run(["systemd-run", "--user", "--scope", "--quiet", "--collect", *expand, "-p", "Delegate=yes", "--", "true"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=5)
    if probe.returncode != 0:
        raise RuntimeError(probe.stderr.strip()[-300:] or f"systemd-run exited {probe.returncode}")
    unit = f"delegatus-signal-{uuid.uuid4().hex}.scope"
    parent_unit = Path(group()).name
    resource_args = []
    if options.terminal and re.fullmatch(r"delegatus-agent-[a-z]+-pane-[a-f0-9-]{12}\.scope", parent_unit):
        parent = Path("/sys/fs/cgroup" + group())
        quota, period = read(parent / "cpu.max").split()
        resource_args = [f"--slice={parent.parent.name}", "-p", f"CPUWeight={read(parent / 'cpu.weight').strip()}"]
        if quota != "max":
            resource_args += ["-p", f"CPUQuota={int(quota) * 100 / int(period)}%", "-p", f"CPUQuotaPeriodSec={int(period)}us"]
        for file, property_name in (("memory.max", "MemoryMax"), ("memory.swap.max", "MemorySwapMax"), ("pids.max", "TasksMax")):
            value = read(parent / file).strip()
            if value != "max":
                resource_args += ["-p", f"{property_name}={value}"]
    argv = ["systemd-run", "--user", "--scope", "--quiet", "--collect", *expand,
            f"--unit={unit}", "-p", "Delegate=yes",
            *resource_args,
            # A regression fixture cannot outlive the admitted test run.
            # Ordinary headless launches remain independent of the Viewer.
            *(["-p", f"BindsTo={parent_unit}", "-p", f"After={parent_unit}"]
              if re.fullmatch(r"delegatus-gate-[a-f0-9-]+\.service", parent_unit) else []),
            "--", sys.executable,
            str(Path(__file__).resolve()), "--scope", unit]
    if options.receipt:
        argv += ["--receipt", options.receipt]
    if options.terminal:
        argv += ["--terminal"]
    if options.automatic:
        argv += ["--automatic"]
    return argv


def protected(options, command):
    """Every failure before the receipt is published leaves the engine
    unexecuted and is reported as Unavailable; nothing is refused."""
    try:
        owned_group = group()
        if Path(owned_group).name != options.scope:
            raise RuntimeError("launcher did not enter its declared invocation scope")
        root = Path("/sys/fs/cgroup" + owned_group)
        leaf = root / "agent"
        # A read-only or foreign cgroup (EROFS, EACCES) is reported here.
        leaf.mkdir()
        (leaf / "cgroup.procs").write_text(str(os.getpid()))
        available = (root / "cgroup.controllers").read_text().split()
        if not all(control in available for control in ("cpu", "memory", "pids")):
            raise RuntimeError("invocation cgroup delegation lacks cpu, memory or pids")
        (root / "cgroup.subtree_control").write_text("+cpu +memory +pids")
        directory = (Path(options.receipt).parent if options.receipt else Path(tempfile.mkdtemp(prefix="delegatus-signal-"))).resolve()
        return domain(options, command, owned_group, root, directory)
    except (Unavailable, Committed):
        raise
    except Exception as error:
        raise Unavailable(error) from error


def domain(options, command, owned_group, root, directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    try:
        return namespace(options, command, owned_group, root, directory)
    finally:
        # Scratch belongs only to this invocation and is removed after reap.
        shutil.rmtree(directory, ignore_errors=True)


def namespace(options, command, owned_group, root, directory):
    (directory / "proc").mkdir(exist_ok=True)
    # Native filesystem sandboxes keep /sys read-only. This alias exposes only
    # the delegated invocation subtree through their writable temporary root.
    cgroup_alias = directory / "cgroup"
    cgroup_alias.mkdir()
    original = os.readlink("/proc/self/ns/pid")
    epoch = f"linux:{read('/proc/sys/kernel/random/boot_id').strip()}:pidns:{original}"
    monitor = identity(os.getpid(), epoch)
    context = {"policyVersion": POLICY, "hostProc": str(directory / "proc"),
               "hostPidNamespace": original, "hostEpoch": epoch,
               "monitor": monitor, "scope": owned_group, "cgroupRoot": str(cgroup_alias)}
    atomic(directory / "context.json", context)
    info = os.open(directory / "bwrap.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    args = ["bwrap", "--unshare-user", "--unshare-pid", "--bind", "/", "/",
            "--proc", "/proc", "--dev", "/dev", "--ro-bind", "/sys", "/sys",
            "--bind", str(root), str(root), "--ro-bind", "/proc", str(directory / "proc"),
            "--bind", str(root), str(cgroup_alias),
            "--cap-drop", "ALL", "--new-session", "--die-with-parent", "--info-fd", str(info), "--"]
    entry = [sys.executable, str(Path(__file__).resolve()), "--inner", str(directory), "--"] + command
    if options.terminal:
        import shlex
        entry = ["script", "--quiet", "--return", "--command", "exec " + shlex.join(entry), "/dev/null"]
    # Only the monitor owns this relationship. Its lifetime is independent of
    # the Viewer; headless work survives loss of the Viewer's process.
    def bind_monitor():
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "monitor lifetime binding was refused")
        if os.getppid() != monitor["pid"]:
            os._exit(137)
    child = subprocess.Popen(args + entry, pass_fds=(info,), preexec_fn=bind_monitor)
    bubblewrap = identity(child.pid, epoch)
    os.close(info)
    init = native = terminal = None
    stopping = None
    published = False
    def stop(sig, _frame):
        nonlocal stopping
        stopping = stopping or time.monotonic()
        send(native, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGWINCH, lambda _sig, _frame: send(terminal, signal.SIGWINCH))
    try:
        end = time.monotonic() + READINESS
        ready = wait_file(directory / "inner.json", child, end)
        data = wait_file(directory / "bwrap.json", child, end)
        init = identity(data["child-pid"], epoch)
        native = identity(ready["pid"], epoch)
        if options.terminal:
            terminal = identity(ready["parentHostPid"], epoch)
            if os.readlink(f"/proc/{terminal['pid']}/ns/pid") != ready["pidNamespace"]:
                raise RuntimeError("terminal adapter is outside the invocation namespace")
        if (ready["pidNamespace"] == original or ready["uid"] != os.getuid()
                or ready["gid"] != os.getgid() or ready["cgroup"] != owned_group + "/agent"
                or os.readlink(f"/proc/{init['pid']}/ns/pid") != ready["pidNamespace"]):
            raise RuntimeError("namespace membership proof failed")
        context.update({"pidNamespace": ready["pidNamespace"], "userNamespace": ready["userNamespace"], "init": init, "native": native})
        atomic(directory / "context.json", context)
        receipt = {"policyVersion": POLICY, "monitor": monitor, "bubblewrap": bubblewrap, "init": init, "native": native,
                   "pidNamespace": ready["pidNamespace"], "userNamespace": ready["userNamespace"],
                   "scope": owned_group, "directory": str(directory)}
        if options.receipt:
            atomic(options.receipt, receipt)
        published = True
        if not options.receipt or options.automatic:
            atomic(directory / "exec.json", True)
        while child.poll() is None:
            if stopping and time.monotonic() - stopping >= 2:
                send(init, signal.SIGKILL)
            time.sleep(0.02)
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    except Exception as error:
        if published:
            raise Committed(error) from error
        failure = error
    finally:
        if child.poll() is None:
            send(init, signal.SIGKILL)
            child.kill()
        # The manager removes the invocation scope after its final member exits.
        child.wait()
    # The namespace never received its exec signal, so the engine never ran.
    if stopping:
        return 143
    raise Unavailable(failure)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope")
    parser.add_argument("--receipt")
    parser.add_argument("--terminal", action="store_true")
    parser.add_argument("--automatic", action="store_true")
    parser.add_argument("--inner")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    if not command:
        raise RuntimeError("engine command is missing")
    if options.inner:
        inner(Path(options.inner), command)
    return launch(options, command)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"agent signal sandbox unavailable: {error}", file=sys.stderr)
        sys.exit(69)
