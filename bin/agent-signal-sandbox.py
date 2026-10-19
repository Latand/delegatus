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


def wait_file(file, child=None, timeout=10):
    end = time.monotonic() + timeout
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
    wait_file(directory / "exec.json")
    os.environ["LLV_SIGNAL_SANDBOX"] = read(directory / "context.json")
    # Socket engines outlive their Viewer and inherit no Viewer pipes. Only
    # pre-exec setup writes the owned diagnostic file; native output is ignored.
    if os.environ.get("LLV_SIGNAL_IGNORE_NATIVE_STDIO") == "1":
        with open(os.devnull, "r+b", buffering=0) as null:
            for descriptor in (0, 1, 2):
                os.dup2(null.fileno(), descriptor)
    for name in ("LLV_SIGNAL_LAUNCHER", "LLV_SIGNAL_RECEIPT", "LLV_SIGNAL_AUTOMATIC", "LLV_SIGNAL_DIAGNOSTIC", "LLV_SIGNAL_IGNORE_NATIVE_STDIO"):
        os.environ.pop(name, None)
    os.execvp(command[0], command)


def launch(options, command):
    if os.getuid() == 0:
        raise RuntimeError("managed signal domains require the original non-root user")
    if os.environ.get("LLV_GATE_SLOT_LEASE"):
        raise RuntimeError("cross-user-namespace gate lease transfer is unsupported; launch before acquiring a gate slot")
    for binary in ("bwrap", "python3", "systemd-run"):
        if not shutil.which(binary):
            raise RuntimeError(f"required host dependency is missing: {binary}")
    if not options.scope:
        unit = f"delegatus-signal-{uuid.uuid4().hex}.scope"
        version = subprocess.check_output(["systemd-run", "--version"], text=True).split()[1]
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
        argv = ["systemd-run", "--user", "--scope", "--quiet", "--collect",
                *(["--expand-environment=no"] if int(version) >= 254 else []),
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
        os.execvp(argv[0], argv + ["--"] + command)
    owned_group = group()
    if Path(owned_group).name != options.scope:
        raise RuntimeError("launcher did not enter its declared invocation scope")
    root = Path("/sys/fs/cgroup" + owned_group)
    leaf = root / "agent"
    leaf.mkdir()
    (leaf / "cgroup.procs").write_text(str(os.getpid()))
    available = (root / "cgroup.controllers").read_text().split()
    if not all(control in available for control in ("cpu", "memory", "pids")):
        raise RuntimeError("invocation cgroup delegation lacks cpu, memory or pids")
    (root / "cgroup.subtree_control").write_text("+cpu +memory +pids")
    directory = (Path(options.receipt).parent if options.receipt else Path(tempfile.mkdtemp(prefix="delegatus-signal-"))).resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
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
    def stop(sig, _frame):
        nonlocal stopping
        stopping = stopping or time.monotonic()
        send(native, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGWINCH, lambda _sig, _frame: send(terminal, signal.SIGWINCH))
    try:
        ready = wait_file(directory / "inner.json", child)
        data = wait_file(directory / "bwrap.json", child)
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
        if not options.receipt or options.automatic:
            atomic(directory / "exec.json", True)
        while child.poll() is None:
            if stopping and time.monotonic() - stopping >= 2:
                send(init, signal.SIGKILL)
            time.sleep(0.02)
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    finally:
        if child.poll() is None:
            send(init, signal.SIGKILL)
            child.kill()
        child.wait()
        # The manager removes the invocation scope after its final member exits.
        # Scratch belongs only to this invocation and is removed after reap.
        shutil.rmtree(directory)


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
