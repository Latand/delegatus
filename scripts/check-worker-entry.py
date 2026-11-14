"""Linux file-entry barrier for owned gate workers.

Seccomp reports opens only; ptrace keeps forks/threads inside the barrier.
Admission precedes reading the compiler implementation, including API imports.
The existing broker owns every ticket, its deadline and cleanup authority.
Installed bytes, Bun settings and interpreter options are left intact.
"""
import ctypes as c
import errno
import json
import os
import platform
import selectors
import signal
import socket
import stat
import sys
import time

libc = c.CDLL(None, use_errno=True)
libc.ptrace.restype = c.c_long
WALL = 0x40000000
CONT, GETEVENTMSG, SEIZE, LISTEN = 7, 0x4201, 0x4206, 0x4208
OPTIONS = 2 | 4 | 8 | 16 | 0x80 | 0x100000
MACHINES = {"x86_64": (0xC000003E, [2, 257, 437]), "aarch64": (0xC00000B7, [56, 437])}


class Filter(c.Structure):
    _fields_ = [("code", c.c_ushort), ("jt", c.c_ubyte), ("jf", c.c_ubyte), ("k", c.c_uint)]


class Program(c.Structure):
    _fields_ = [("len", c.c_ushort), ("filter", c.POINTER(Filter))]


class Syscall(c.Structure):
    _fields_ = [("op", c.c_ubyte), ("pad", c.c_ubyte * 3), ("arch", c.c_uint),
                ("ip", c.c_ulonglong), ("sp", c.c_ulonglong),
                ("nr", c.c_ulonglong), ("args", c.c_ulonglong * 6), ("ret_data", c.c_uint)]


class TaskSet(set):
    """Match kernel birth and exit receipts delivered in either order."""
    def __init__(self, root):
        super().__init__([root])
        self.announced = {root}
        self.early_exits = set()

    def born(self, pid):
        if pid in self.early_exits:
            self.early_exits.remove(pid)
            return False
        self.announced.add(pid)
        self.add(pid)
        return True

    def departed(self, pid):
        self.discard(pid)
        if pid in self.announced:
            self.announced.remove(pid)
        else:
            self.early_exits.add(pid)


def ptrace(request, pid, address=0, data=0):
    result = libc.ptrace(request, pid, c.c_void_p(address), data)
    if result == -1:
        if c.get_errno() == errno.ESRCH:
            return None
        raise OSError(c.get_errno(), "worker entry ptrace refused")
    return result


def install_filter():
    arch, numbers = MACHINES[platform.machine()]
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0)]
    for number in numbers:
        instructions += [(0x15, 0, 1, number), (0x06, 0, 0, 0x7FF00000)]
    instructions += [(0x06, 0, 0, 0x7FFF0000)]
    filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    program = Program(len(filters), filters)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, c.byref(program), 0, 0):
        raise OSError(c.get_errno(), "worker entry seccomp refused")


def environment(pid):
    with open(f"/proc/{pid}/environ", "rb") as file:
        return dict(os.fsdecode(item).split("=", 1) for item in file.read().split(b"\0") if b"=" in item)


def process_id(tid):
    with open(f"/proc/{tid}/status") as file:
        return int(next(row.split()[1] for row in file if row.startswith("Tgid:")))


def inherited_policy(parent, observed):
    env = {**parent, **observed}
    # An explicit alias selects this child's pool/policy. Restore the whole
    # inherited family only when the child has supplied none of its aliases.
    for family in [("LLV_CHECK_ADMISSION_FILE", "LLV_GATE_CHECK_ADMISSION_FILE"),
                   ("DELEGATUS_GATE_CPU_HEADROOM", "LLV_GATE_CPU_HEADROOM"),
                   ("LLV_CHECK_BROKER", "DELEGATUS_CHECK_BROKER")]:
        if any(key in observed for key in family):
            for key in family:
                if key not in observed:
                    env.pop(key, None)
    return env


def main():
    if platform.machine() not in MACHINES:
        raise RuntimeError("worker entry unsupported Linux architecture; command did not run")
    for key in ["LLV_CHECK_ENTRY_PID", "LLV_PORTABLE_TEST_RUNNER_PID"]:
        os.environ[key] = "0" * 20
    if "LLV_OWNED_TEST_RUNNER_PID" in os.environ:
        os.environ["LLV_OWNED_TEST_RUNNER_PID"] = "0" * 20
    with open("/proc/self/status") as file:
        tracer = int(next(row.split()[1] for row in file if row.startswith("TracerPid:")))
    if tracer:
        with open(f"/proc/{tracer}/cmdline", "rb") as file:
            tracer_args = file.read().split(b"\0")
        known = len(tracer_args) >= 3 and os.path.samefile(os.fsdecode(tracer_args[2]), __file__)
        if not known and len(tracer_args) >= 3:
            # Bundled gates and separate checkouts carry identical helper
            # bytes at different paths. They share the active barrier.
            with open(os.fsdecode(tracer_args[2]), "rb") as parent, open(__file__, "rb") as current:
                known = os.fstat(parent.fileno()).st_size == os.fstat(current.fileno()).st_size and parent.read() == current.read()
        if not known:
            raise RuntimeError("worker entry cannot reuse an unrelated tracer")
        os.environ["LLV_CHECK_ENTRY_TRACER"] = str(tracer)
        os.execvp(sys.argv[1], sys.argv[1:])
    group = os.environ.get("LLV_OWNED_TEST_RUN_CGROUP")
    # A signal namespace already hides the service supervisor from its test
    # process view, and keeps the service cgroup mount read-only. On the host
    # an entry subtree supplies that same supervisor/worker scope.
    if group and not os.environ.get("LLV_SIGNAL_SANDBOX"):
        with open("/proc/self/cgroup") as file:
            if f"0::{group}\n" not in file.read():
                raise RuntimeError("worker entry owning cgroup mismatch")
        # Keep the test scope's established two-process contract: its direct
        # supervisor and its worker. The service owns this delegated subtree
        # and retains the same TasksMax and control-group cleanup above it.
        group += f"/entry-{os.getpid()}"
        os.mkdir("/sys/fs/cgroup" + group)
        with open("/sys/fs/cgroup" + group + "/cgroup.procs", "w") as file:
            file.write(str(os.getpid()))
        os.environ["LLV_OWNED_TEST_RUN_CGROUP"] = group
    ready, release = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(release)
        if os.read(ready, 1) != b"1":
            os._exit(69)
        os.close(ready)
        # Reserve room for the per-process proof expected by older preloads.
        os.environ["LLV_CHECK_ENTRY_TRACER"] = str(os.getppid())
        install_filter()
        os.execvp(sys.argv[1], sys.argv[1:])
    os.close(ready)
    child_fd = os.pidfd_open(child)
    wake_read, wake_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
    signal.signal(signal.SIGCHLD, lambda *_: None)
    signal.set_wakeup_fd(wake_write)
    ptrace(SEIZE, child, 0, OPTIONS)
    def forward(sig, _frame):
        try:
            signal.pidfd_send_signal(child_fd, sig)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    os.write(release, b"1")
    os.close(release)
    selector = selectors.DefaultSelector()
    selector.register(wake_read, selectors.EVENT_READ, None)
    tracees = TaskSet(child)
    entry_env = dict(os.environ)
    policies = {child: entry_env}
    newborn = set()
    initial = set()
    tickets = {}
    waiting = {}
    implementations = {}
    result = None

    def refuse(pid, error):
        print(f"worker entry: stopping owned worker: {error}", file=sys.stderr)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def close_ticket(pid):
        sock = tickets[pid][0]
        try:
            selector.unregister(sock)
        except (KeyError, ValueError):
            pass
        sock.close()

    def resume(tid, sig=0):
        try:
            ptrace(CONT, tid, 0, sig)
        except OSError as error:
            if error.errno != errno.ESRCH:
                raise

    def proof(pid):
        # Exec is complete but no user instruction has run. Update only our
        # reserved fields, retaining all caller options and Bun configuration.
        with open(f"/proc/{pid}/stat") as file:
            fields = file.read().rsplit(")", 1)[1].split()
        start, end = int(fields[47]), int(fields[48])
        with open(f"/proc/{pid}/mem", "r+b", buffering=0) as file:
            file.seek(start)
            data = file.read(end - start)
            def replace(key, value, numeric=False):
                prefix = key + b"="
                offset = 0 if data.startswith(prefix) else data.find(b"\0" + prefix) + 1
                if offset == 0 and not data.startswith(prefix):
                    raise RuntimeError("worker entry admission proof missing")
                begin = offset + len(prefix)
                size = data.index(b"\0", begin) - begin
                if len(value) > size:
                    raise RuntimeError("worker entry admission proof has no room")
                file.seek(start + begin)
                file.write(value.rjust(size, b"0") if numeric else value.ljust(size, b"\0"))

            env = environment(pid)
            group = env.get("LLV_OWNED_TEST_RUN_CGROUP")
            if group and not env.get("LLV_SIGNAL_SANDBOX"):
                with open(f"/proc/{pid}/cgroup") as current:
                    if f"0::{group}\n" not in current.read():
                        raise RuntimeError("test entry owning cgroup mismatch")
                # A test launched by a script has additional ancestors in the
                # command's scope. Its own scope contains only that test and
                # its descendants, so teardown cannot mistake an ancestor for
                # a leaked child. Fixed-width names fit inherited env storage.
                scope = os.path.dirname(group) + f"/w{pid:06x}"
                os.makedirs("/sys/fs/cgroup" + scope, exist_ok=True)
                with open("/sys/fs/cgroup" + scope + "/cgroup.procs", "w") as members:
                    members.write(str(pid))
                replace(b"LLV_OWNED_TEST_RUN_CGROUP", os.fsencode(scope))
            keys = [b"LLV_CHECK_ENTRY_PID", b"LLV_PORTABLE_TEST_RUNNER_PID"]
            if data.startswith(b"LLV_OWNED_TEST_RUNNER_PID=") or b"\0LLV_OWNED_TEST_RUNNER_PID=" in data:
                keys.append(b"LLV_OWNED_TEST_RUNNER_PID")
            for key in keys:
                replace(key, str(pid).encode(), True)

    def enroll(tid, kind, exec_stop=False):
        pid = process_id(tid)
        if pid in tickets:
            if tickets[pid][1]:
                if exec_stop:
                    proof(tid)
                resume(tid)
            else:
                waiting[pid].append((tid, exec_stop))
            return
        inherited = policies.get(pid, entry_env)
        env = inherited_policy(inherited, environment(pid))
        address = (env.get("LLV_CHECK_BROKER") or env.get("DELEGATUS_CHECK_BROKER")
                   or inherited.get("LLV_CHECK_BROKER") or inherited.get("DELEGATUS_CHECK_BROKER"))
        broker = json.loads(address or "null")
        if not broker:
            raise RuntimeError("worker entry requires an owned admission broker")
        sock = socket.socket()
        sock.setblocking(False)
        connected = sock.connect_ex(("127.0.0.1", broker["port"]))
        if connected not in (0, errno.EINPROGRESS):
            sock.close()
            raise OSError(connected, "worker entry admission connect refused")
        boundary = json.loads(env.get("LLV_SIGNAL_SANDBOX", "null"))
        host_pid = None
        if boundary:
            namespace = os.readlink(f"/proc/{pid}/ns/pid")
            for name in os.listdir(boundary["hostProc"]):
                if not name.isdecimal():
                    continue
                try:
                    outer = f"{boundary['hostProc']}/{name}"
                    if os.readlink(outer + "/ns/pid") != namespace:
                        continue
                    with open(outer + "/status") as file:
                        pids = next(row.split()[1:] for row in file if row.startswith("NSpid:"))
                    if int(pids[-1]) == pid:
                        host_pid = int(name)
                        break
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue
            if host_pid is None:
                raise RuntimeError("worker entry cannot resolve the host PID")
        policy = {key: value for key, value in env.items() if key in [
            "LLV_CHECK_ADMISSION_FILE", "LLV_GATE_CHECK_ADMISSION_FILE", "DELEGATUS_GATE_CPU_HEADROOM",
            "LLV_GATE_CPU_HEADROOM", "LLV_CPU_WAIT_ROOTS", "LLV_RECORDED_CHECK_WAIT_ROOT"]}
        request = dict(nonce=broker["nonce"], pid=pid, kind=kind, env=policy)
        if host_pid is not None:
            request["hostPid"] = host_pid
        tickets[pid] = [sock, False, b"", (json.dumps(request) + "\n").encode(), time.monotonic() + 5]
        waiting[pid] = [(tid, exec_stop)]
        selector.register(sock, selectors.EVENT_WRITE, pid)

    def admit(tid, kind, exec_stop=False):
        try:
            enroll(tid, kind, exec_stop)
        except (OSError, ValueError, RuntimeError) as error:
            try:
                refuse(process_id(tid), error)
            except (FileNotFoundError, ProcessLookupError):
                pass

    def compiler_open(tid):
        info = Syscall()
        if ptrace(0x420E, tid, c.sizeof(info), c.byref(info)) is None:
            return False
        address = info.args[0] if info.nr == 2 else info.args[1]
        try:
            with open(f"/proc/{tid}/mem", "rb", buffering=0) as memory:
                memory.seek(address)
                name = os.fsdecode(memory.read(4096).split(b"\0", 1)[0])
            base = f"/proc/{tid}/root" if name.startswith("/") else (
                f"/proc/{tid}/cwd" if c.c_int(info.args[0]).value == -100 or info.nr == 2
                else f"/proc/{tid}/fd/{info.args[0]}")
            file = base + "/" + name.lstrip("/")
            attributes = os.stat(file)
            if not stat.S_ISREG(attributes.st_mode):
                return False
            identity = (attributes.st_dev, attributes.st_ino, attributes.st_size, attributes.st_mtime_ns)
            if identity not in implementations:
                if len(implementations) >= 4096:
                    implementations.clear()
                with open(file, "rb") as source:
                    header = source.read(4096)
                    implementations[identity] = (b"Microsoft Corporation" in header and
                        b"function createProgram(" in (header + source.read()))
            return implementations[identity]
        except (OSError, UnicodeError, OverflowError):
            return False

    def executed(tid):
        env = environment(tid)
        policies[tid] = inherited_policy(policies.get(tid, entry_env), env)
        with open(f"/proc/{tid}/cmdline", "rb") as file:
            argv = file.read().split(b"\0")[:-1]
        executable = os.path.realpath(f"/proc/{tid}/exe")
        if os.path.basename(executable) == "bun":
            # A raw test may deliberately clear its inherited runner. Its
            # checkout preload establishes a new owner before tests load.
            if not (env.get("LLV_CHECK_BROKER") or env.get("DELEGATUS_CHECK_BROKER")) or not all(
                    key in env for key in ["LLV_CHECK_ENTRY_PID", "LLV_PORTABLE_TEST_RUNNER_PID"]):
                resume(tid)
                return
            arguments = iter(argv[1:])
            for argument in arguments:
                if argument in (b"-e", b"--eval", b"-p", b"--print"):
                    break
                if argument in (b"-r", b"--preload", b"--require", b"--import", b"--cwd", b"-c",
                                b"--config", b"--env-file", b"--tsconfig-override", b"-d", b"--define",
                                b"-l", b"--loader"):
                    next(arguments, None)
                    continue
                if argument.startswith(b"-"):
                    continue
                if argument == b"test":
                    admit(tid, "test", True)
                    return
                if argument != b"run":
                    break
        resume(tid)

    try:
        while tracees:
            deadlines = [ticket[4] for ticket in tickets.values() if ticket[3]]
            timeout = max(0, min(deadlines) - time.monotonic()) if deadlines else None
            for key, mask in selector.select(timeout):
                if key.data is None:
                    while True:
                        try:
                            os.read(wake_read, 4096)
                        except BlockingIOError:
                            break
                    continue
                pid = key.data
                ticket = tickets[pid]
                if mask & selectors.EVENT_WRITE:
                    try:
                        error = ticket[0].getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                        if error:
                            raise OSError(error, "worker entry admission connect refused")
                        count = ticket[0].send(ticket[3])
                        ticket[3] = ticket[3][count:]
                        if not ticket[3]:
                            selector.modify(ticket[0], selectors.EVENT_READ, pid)
                    except BlockingIOError:
                        pass
                    except OSError as error:
                        ticket[3] = b""
                        close_ticket(pid)
                        refuse(pid, error)
                    continue
                try:
                    data = ticket[0].recv(64000)
                except BlockingIOError:
                    continue
                except OSError as error:
                    close_ticket(pid)
                    refuse(pid, error)
                    continue
                if not data:
                    close_ticket(pid)
                    refuse(pid, "admission broker closed")
                    continue
                ticket[2] += data
                if len(ticket[2]) > 64000:
                    close_ticket(pid)
                    refuse(pid, "admission broker reply too large")
                    continue
                if b"\n" in ticket[2] and not ticket[1]:
                    try:
                        answer = json.loads(ticket[2])
                    except ValueError as error:
                        close_ticket(pid)
                        refuse(pid, error)
                        continue
                    if answer.get("admitted") is not True:
                        close_ticket(pid)
                        refuse(pid, answer.get("error", "worker entry admission refused"))
                        continue
                    ticket[1] = True
                    for tid, exec_stop in waiting.pop(pid):
                        if exec_stop:
                            try:
                                proof(tid)
                            except (OSError, RuntimeError) as error:
                                refuse(pid, error)
                                continue
                        resume(tid)
            for pid, ticket in tickets.items():
                if ticket[3] and time.monotonic() >= ticket[4]:
                    ticket[3] = b""
                    close_ticket(pid)
                    refuse(pid, "admission connect deadline expired")
            while True:
                try:
                    tid, status = os.waitpid(-1, WALL | os.WNOHANG)
                except ChildProcessError:
                    break
                if not tid:
                    break
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    tracees.departed(tid)
                    newborn.discard(tid)
                    initial.discard(tid)
                    policies.pop(tid, None)
                    waiting.pop(tid, None)
                    if tid in tickets:
                        close_ticket(tid)
                        tickets.pop(tid)
                    if tid == child:
                        result = os.waitstatus_to_exitcode(status)
                        # The existing owned-runner retains detached-child
                        # cleanup and its surviving-process refusal.
                        for remaining in list(tracees):
                            try:
                                ptrace(0x4207, remaining)
                            except OSError as error:
                                if error.errno != errno.ESRCH:
                                    raise
                elif os.WIFSTOPPED(status):
                    first_stop = tid not in tracees or tid in newborn
                    tracees.add(tid)
                    newborn.discard(tid)
                    initial.add(tid)
                    event, sig = status >> 16, os.WSTOPSIG(status)
                    if result is not None:
                        ptrace(17, tid)
                        tracees.departed(tid)
                    elif event in (1, 2, 3):
                        message = c.c_ulonglong()
                        if ptrace(GETEVENTMSG, tid, 0, c.byref(message)) is None:
                            continue
                        if tracees.born(message.value):
                            policies[message.value] = policies.get(tid, entry_env)
                            if message.value not in initial:
                                newborn.add(message.value)
                            else:
                                resume(message.value)
                        resume(tid)
                    elif event == 4:
                        # Linux gives a non-leader exec the thread-group ID.
                        # Its former TID disappears without another wait exit;
                        # retaining it would keep the supervisor alive forever.
                        former = c.c_ulonglong()
                        if ptrace(GETEVENTMSG, tid, 0, c.byref(former)) is not None and former.value != tid:
                            tracees.departed(former.value)
                            newborn.discard(former.value)
                            initial.discard(former.value)
                            policies[tid] = policies.pop(former.value, policies.get(tid, entry_env))
                        try:
                            executed(tid)
                        except (FileNotFoundError, ProcessLookupError):
                            pass
                    elif event == 7:
                        try:
                            pid = process_id(tid)
                        except (FileNotFoundError, ProcessLookupError):
                            continue
                        if pid in tickets and not tickets[pid][1]:
                            waiting[pid].append((tid, False))
                        elif pid not in tickets and compiler_open(tid):
                            admit(tid, "compiler")
                        else:
                            resume(tid)
                    elif event == 128:
                        if first_stop:
                            # A child stop can arrive before its parent's
                            # birth receipt. Keep it stopped until the inherited
                            # admission policy is bound, even across env -i.
                            if tid in tracees.announced:
                                resume(tid)
                        elif sig in (signal.SIGSTOP, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU):
                            ptrace(LISTEN, tid)
                        else:
                            resume(tid)
                    else:
                        resume(tid, sig)
        return result if result is not None and result >= 0 else 128 - (result or 0)
    finally:
        for ticket in tickets.values():
            ticket[0].close()
        selector.close()
        os.close(child_fd)
        signal.set_wakeup_fd(-1)
        os.close(wake_read)
        os.close(wake_write)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"worker entry refused: {error}", file=sys.stderr)
        sys.exit(69)
