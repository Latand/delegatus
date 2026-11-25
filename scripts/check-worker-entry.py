"""Linux open-time admission through a seccomp user-notification listener.

The supervisor leaves ptrace available to the command and its debuggers.
Linux 5.5+, host Python and descendant memory access are required. Ordinary
strace and gdb work; seccomp TRACE optimizations (including rr) cannot observe
calls held by USER_NOTIF. Admission relies on cooperative callers.
The broker retains ticket, deadline and cleanup authority.
"""
import array
import ctypes as c
import errno
import json
import os
import platform
import select
import selectors
import signal
import socket
import stat
import sys
import time

libc = c.CDLL(None, use_errno=True)
libc.process_vm_readv.restype = c.c_ssize_t
# audit architecture, seccomp syscall, open syscalls, exec syscalls
MACHINES = {"x86_64": (0xC000003E, 317, (2, 257, 437), (59, 322)),
            "aarch64": (0xC00000B7, 277, (56, 437), (221, 281))}
RECV, SEND, ID_VALID = 0xC0502100, 0xC0182101, 0x40082102


class Filter(c.Structure):
    _fields_ = [("code", c.c_ushort), ("jt", c.c_ubyte), ("jf", c.c_ubyte), ("k", c.c_uint)]


class Program(c.Structure):
    _fields_ = [("len", c.c_ushort), ("filter", c.POINTER(Filter))]


class IOVec(c.Structure):
    _fields_ = [("base", c.c_void_p), ("size", c.c_size_t)]


class Syscall(c.Structure):
    _fields_ = [("nr", c.c_int), ("arch", c.c_uint), ("ip", c.c_ulonglong),
                ("args", c.c_ulonglong * 6)]


class Notification(c.Structure):
    _fields_ = [("id", c.c_ulonglong), ("pid", c.c_uint), ("flags", c.c_uint), ("data", Syscall)]


class Response(c.Structure):
    _fields_ = [("id", c.c_ulonglong), ("val", c.c_longlong), ("error", c.c_int), ("flags", c.c_uint)]


def process_memory(pid, address, size):
    buffer = c.create_string_buffer(size)
    local = IOVec(c.cast(buffer, c.c_void_p), size)
    remote = IOVec(c.c_void_p(address), size)
    count = libc.process_vm_readv(pid, c.byref(local), 1, c.byref(remote), 1, 0)
    if count >= 0:
        return buffer.raw[:count]
    # Some containment profiles allow the descendant's proc handle instead.
    with open(f"/proc/{pid}/mem", "rb", buffering=0) as memory:
        memory.seek(address)
        return memory.read(size)


def install_filter():
    arch, syscall, opens, execs = MACHINES[platform.machine()]
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0)]
    for number in (*opens, *execs):
        body = []
        if number in opens and number != 437:
            # These opens cannot return existing compiler bytes. Keep O_PATH
            # observed: a caller can hand that descriptor to an interpreter.
            offset = 24 if number == 2 else 32
            body = [(0x20, 0, 0, offset),
                    (0x45, 0, 1, os.O_PATH),
                    (0x06, 0, 0, 0x7FC00000),
                    (0x45, 0, 1, os.O_DIRECTORY | os.O_TRUNC),
                    (0x06, 0, 0, 0x7FFF0000),
                    (0x54, 0, 0, os.O_ACCMODE),
                    (0x15, 0, 1, os.O_WRONLY),
                    (0x06, 0, 0, 0x7FFF0000)]
        body += [(0x06, 0, 0, 0x7FC00000)]
        instructions += [(0x15, 0, len(body), number), *body]
    instructions += [(0x06, 0, 0, 0x7FFF0000)]
    filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    program = Program(len(filters), filters)
    if libc.prctl(38, 1, 0, 0, 0):
        raise OSError(c.get_errno(), "worker entry no_new_privs refused")
    # NEW_LISTENER only. WAIT_KILLABLE_RECV would put waiters in D state and
    # prevent the broker's SIGSTOP lending from suspending their open.
    listener = libc.syscall(syscall, 1, 8, c.byref(program))
    if listener < 0:
        message = "worker entry seccomp refused"
        if c.get_errno() == errno.EBUSY:
            message = "worker entry cannot reuse an unrelated seccomp listener"
        raise OSError(c.get_errno(), message)
    return listener


def ioctl(fd, operation, value):
    if libc.ioctl(fd, operation, c.byref(value)) < 0:
        error = c.get_errno()
        if error in (errno.ENOENT, errno.EINTR):
            return False
        raise OSError(error, "worker entry notification refused")
    return True


def environment(pid):
    with open(f"/proc/{pid}/environ", "rb") as file:
        return dict(os.fsdecode(item).split("=", 1) for item in file.read().split(b"\0") if b"=" in item)


def parent_id(pid):
    with open(f"/proc/{pid}/stat") as file:
        return int(file.read().rsplit(")", 1)[1].split()[1])


def process_id(tid):
    with open(f"/proc/{tid}/status") as file:
        return int(next(row.split()[1] for row in file if row.startswith("Tgid:")))


def granted_process(tid, tickets, groups):
    ticket = tickets.get(tid)
    if ticket:
        return ticket[1] and not select.select([ticket[5]], [], [], 0)[0]
    pid = groups.get(tid)
    if pid is None:
        pid = process_id(tid)
        if len(groups) >= 4096:
            groups.clear()
        groups[tid] = pid
    ticket = tickets.get(pid)
    if not ticket or not ticket[1] or select.select([ticket[5]], [], [], 0)[0]:
        return False
    # A cached TID can be reused while its former process remains alive.
    # Signal zero proves current kernel membership without sending a signal.
    tgkill = 234 if platform.machine() == "x86_64" else 131
    return libc.syscall(tgkill, pid, tid, 0) == 0


def ancestor_supervisor():
    parent, seen = os.getppid(), set()
    while parent > 1 and parent not in seen:
        seen.add(parent)
        with open(f"/proc/{parent}/cmdline", "rb") as file:
            args = file.read().split(b"\0")
        if len(args) >= 3 and b"python" in os.path.basename(args[0]):
            candidate = os.fsdecode(args[2] if args[1] == b"-I" else args[1])
            if os.path.basename(candidate) == "check-worker-entry.py":
                return parent
            try:
                with open(candidate, "rb") as source, open(__file__, "rb") as current:
                    if source.read() == current.read():
                        return parent
            except OSError:
                pass
        parent = parent_id(parent)
    return None


def inherited_policy(parent, observed):
    env = {**parent, **observed}
    for family in [("LLV_CHECK_ADMISSION_FILE", "LLV_GATE_CHECK_ADMISSION_FILE"),
                   ("DELEGATUS_GATE_CPU_HEADROOM", "LLV_GATE_CPU_HEADROOM"),
                   ("LLV_CHECK_BROKER", "DELEGATUS_CHECK_BROKER")]:
        if any(key in observed for key in family):
            for key in family:
                if key not in observed:
                    env.pop(key, None)
    return env


def command_identity(supervisor):
    os.environ["LLV_CHECK_ENTRY_PID"] = "0" * 20
    service = "LLV_OWNED_TEST_RUNNER_PID" in os.environ
    os.environ["LLV_PORTABLE_TEST_RUNNER_PID"] = "0" * 20 if service else str(os.getpid()).zfill(20)
    if service:
        os.environ["LLV_OWNED_TEST_RUNNER_PID"] = str(os.getpid()).zfill(20)
    os.environ["LLV_CHECK_ENTRY_SUPERVISOR"] = str(supervisor)


def child_pids(pid):
    while True:
        try:
            return read_child_pids(pid)
        except InterruptedError:
            # Cancellation and reaping can interrupt proc directory iteration.
            # Retry the kernel snapshot while retaining the same parent fence.
            continue


def read_child_pids(pid):
    children = set()
    try:
        for tid in os.listdir(f"/proc/{pid}/task"):
            try:
                with open(f"/proc/{pid}/task/{tid}/children") as file:
                    children.update(map(int, file.read().split()))
            except (FileNotFoundError, ProcessLookupError):
                pass
    except (FileNotFoundError, ProcessLookupError):
        pass
    return children


def signal_children(sig):
    # Kernel child lists cover forks from every thread without a machine-wide
    # proc scan. Hold a pidfd and verify each parent edge before signalling.
    descriptors, seen, verified = [], set(), set()

    def collect(parent):
        for pid in sorted(child_pids(parent)):
            if pid in seen:
                continue
            seen.add(pid)
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                if parent_id(pid) != parent:
                    os.close(fd)
                    continue
            except (FileNotFoundError, ProcessLookupError):
                os.close(fd)
                continue
            descriptors.append((fd, pid))
            verified.add(pid)
            collect(pid)

    try:
        collect(os.getpid())
        for fd, pid in reversed(descriptors):
            while True:
                try:
                    action = sig
                    if sig in (signal.SIGTERM, signal.SIGINT):
                        with open(f"/proc/{pid}/stat") as file:
                            stopped = file.read().rsplit(")", 1)[1].split()[0] in ("T", "t")
                        # A lent worker has no permit to resume user code.
                        # SIGKILL ends a stopped process without SIGCONT.
                        if stopped:
                            action = signal.SIGKILL
                    signal.pidfd_send_signal(fd, action)
                    break
                except InterruptedError:
                    continue
                except (FileNotFoundError, ProcessLookupError):
                    break
    finally:
        for fd, _pid in descriptors:
            os.close(fd)
    return verified


def cancel_children(sig):
    # The runner escalates against this supervisor after 500 ms. End resistant
    # descendants first, while their subreaper can still reap them and release
    # inherited pipes. Repeated cancellation must not extend that bound.
    if not signal.getitimer(signal.ITIMER_REAL)[0]:
        signal.signal(signal.SIGALRM, lambda *_: signal_children(signal.SIGKILL))
        signal.setitimer(signal.ITIMER_REAL, 0.3)
    return signal_children(sig)


def finish_children(cancelled):
    def reap():
        while True:
            try:
                pid, _status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if not pid:
                return

    settle_deadline = time.monotonic() + 0.02
    while True:
        reap()
        remaining = set()
        for pid in child_pids(os.getpid()):
            try:
                fd = os.pidfd_open(pid)
                try:
                    if parent_id(pid) != os.getpid():
                        continue
                    exited = select.poll()
                    exited.register(fd, select.POLLIN)
                    if not exited.poll(0):
                        remaining.add(pid)
                finally:
                    os.close(fd)
            except (FileNotFoundError, ProcessLookupError):
                pass
        # Terminal parents can have forked another child after our snapshot.
        # Reap them and refresh adoption before certifying an empty tree.
        reap()
        if remaining:
            break
        pending = child_pids(os.getpid())
        if not pending:
            return False
        if time.monotonic() >= settle_deadline:
            remaining = pending
            break
    leaked = not cancelled
    if leaked:
        # This is the owned runner's cleanup verdict even when the subreaper
        # finds the tree first. Keep its diagnostic and kernel identities so
        # the comparator retains ownership refusals across retries and bases.
        identities = []
        for pid in sorted(remaining):
            try:
                with open(f"/proc/{pid}/stat") as file:
                    ticks = file.read().rsplit(")", 1)[1].split()[19]
                identity = f"{pid}:{ticks}"
            except (FileNotFoundError, ProcessLookupError):
                identity = "null"
            identities.append(f"{pid} ({identity})")
        print("owned runner: surviving owned processes: " + ", ".join(identities), file=sys.stderr)
    # Finish before the runner's own TERM escalation. Cancellation already
    # signalled the tree while its main command was shutting down.
    grace = 0.3 if cancelled else 0.1
    for sig, delay in [(signal.SIGTERM, grace), (signal.SIGKILL, 0.1)]:
        signal_children(sig)
        deadline = time.monotonic() + delay
        while True:
            reap()
            if not child_pids(os.getpid()):
                return leaked
            if time.monotonic() >= deadline:
                break
            time.sleep(0.005)
    raise RuntimeError("worker entry owned children survived cleanup")


def reuse_listener():
    # Keep a nested runner's orphans under that runner. Execing the command
    # here would reparent its daemons to the outer listener, beyond the inner
    # broker's ancestry and cancellation authority. No second filter is set.
    if libc.prctl(36, 1, 0, 0, 0):
        raise OSError(c.get_errno(), "worker entry subreaper refused")
    child = os.fork()
    if child == 0:
        command_identity(os.getppid())
        os.execvp(sys.argv[1], sys.argv[1:])
    fd = os.pidfd_open(child)
    cancelled = False

    def forward(sig, _frame):
        nonlocal cancelled
        cancelled = True
        if child in cancel_children(sig):
            return
        try:
            signal.pidfd_send_signal(fd, sig)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    try:
        while True:
            pid, status = os.waitpid(-1, 0)
            if pid == child:
                result = os.waitstatus_to_exitcode(status)
                leaked = finish_children(cancelled)
                return result or int(leaked)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        os.close(fd)


def main():
    if platform.machine() not in MACHINES:
        raise RuntimeError("worker entry unsupported Linux architecture; command did not run")
    ancestor = ancestor_supervisor()
    if ancestor:
        return reuse_listener()
    group = os.environ.get("LLV_OWNED_TEST_RUN_CGROUP")
    if group and not os.environ.get("LLV_SIGNAL_SANDBOX"):
        with open("/proc/self/cgroup") as file:
            if f"0::{group}\n" not in file.read():
                raise RuntimeError("worker entry owning cgroup mismatch")
        group += f"/entry-{os.getpid()}"
        os.mkdir("/sys/fs/cgroup" + group)
        with open("/sys/fs/cgroup" + group + "/cgroup.procs", "w") as file:
            file.write(str(os.getpid()))
        os.environ["LLV_OWNED_TEST_RUN_CGROUP"] = group
    # Reparented double-fork workers must remain our descendants for Yama's
    # process_vm_readv and /proc/mem checks, and must be reaped on exit.
    if libc.prctl(36, 1, 0, 0, 0):
        raise OSError(c.get_errno(), "worker entry subreaper refused")
    receiver, sender = socket.socketpair()
    child = os.fork()
    if child == 0:
        receiver.close()
        command_identity(os.getppid())
        listener = install_filter()
        # Python 3.14's send_fds imports array on first use. An import here
        # can wait for the very listener the parent is still waiting to receive.
        sender.sendmsg([b"1"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [listener]))])
        os.close(listener)
        sender.close()
        os.execvp(sys.argv[1], sys.argv[1:])
    sender.close()
    _message, descriptors, _flags, _address = socket.recv_fds(receiver, 1, 1)
    receiver.close()
    if len(descriptors) != 1:
        os.waitpid(child, 0)
        raise RuntimeError("worker entry listener did not start; command did not run")
    listener = descriptors[0]
    child_fd = os.pidfd_open(child)
    wake_read, wake_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
    signal.signal(signal.SIGCHLD, lambda *_: None)
    signal.set_wakeup_fd(wake_write)
    cancelled = False

    def forward(sig, _frame):
        nonlocal cancelled
        cancelled = True
        if child in cancel_children(sig):
            return
        try:
            signal.pidfd_send_signal(child_fd, sig)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    selector = selectors.DefaultSelector()
    selector.register(wake_read, selectors.EVENT_READ, ("wake", None))
    selector.register(child_fd, selectors.EVENT_READ, ("root", child))
    selector.register(listener, selectors.EVENT_READ, ("notification", None))
    listener_poll = select.poll()
    listener_poll.register(listener, select.POLLIN)
    entry_env = dict(os.environ)
    tickets, waiting, implementations, groups = {}, {}, {}, {}
    fresh = {}
    proofs = {}
    execs = MACHINES[platform.machine()][3]
    result = None

    def forget_exec(pid):
        fd = fresh.pop(pid, None)
        if fd is not None:
            selector.unregister(fd)
            os.close(fd)

    def worker_pid(tid):
        return process_id(tid)

    def refuse(pid, error, identifier=None):
        ticket = tickets.get(pid)
        fd = None
        try:
            fd = ticket[5] if ticket else os.pidfd_open(pid)
            if identifier is not None and not ioctl(listener, ID_VALID, c.c_ulonglong(identifier)):
                return
            print(f"worker entry: stopping owned worker: {error}", file=sys.stderr)
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        finally:
            if fd is not None and not ticket:
                os.close(fd)

    def close_ticket(pid):
        ticket = tickets.pop(pid)
        for fd in [ticket[0], ticket[5]]:
            try:
                selector.unregister(fd)
            except (KeyError, ValueError):
                pass
        ticket[0].close()
        os.close(ticket[5])
        waiting.pop(pid, None)
        proofs.pop(pid, None)
        forget_exec(pid)

    def resume(identifier):
        ioctl(listener, SEND, Response(identifier, 0, 0, 1))

    def proof(pid, kind):
        # The first open after exec is held. Update only our
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
            if kind == "compiler" and "LLV_CHECK_ENTRY_PID" not in env:
                return
            group = env.get("LLV_OWNED_TEST_RUN_CGROUP")
            if kind == "test" and group and not env.get("LLV_SIGNAL_SANDBOX"):
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
            keys = [b"LLV_CHECK_ENTRY_PID"]
            if kind == "test":
                keys.append(b"LLV_PORTABLE_TEST_RUNNER_PID")
                if "LLV_OWNED_TEST_RUNNER_PID" in env:
                    keys.append(b"LLV_OWNED_TEST_RUNNER_PID")
            for key in keys:
                replace(key, str(pid).encode(), True)

    def admission_environment(pid):
        observed = environment(pid)
        parent, seen = parent_id(pid), set()
        inherited = entry_env
        while parent > 1 and parent not in seen:
            seen.add(parent)
            try:
                env = environment(parent)
                if env.get("LLV_CHECK_BROKER") or env.get("DELEGATUS_CHECK_BROKER"):
                    inherited = inherited_policy(entry_env, env)
                    break
                parent = parent_id(parent)
            except (FileNotFoundError, ProcessLookupError):
                break
        return inherited_policy(inherited, observed)

    def enroll(pid, identifier, kind):
        if not ioctl(listener, ID_VALID, c.c_ulonglong(identifier)):
            return
        if pid in tickets and select.select([tickets[pid][5]], [], [], 0)[0]:
            close_ticket(pid)
        if kind == "test":
            proofs[pid] = "test"
        if pid in tickets:
            forget_exec(pid)
            if tickets[pid][1]:
                if pid in proofs:
                    proof(pid, proofs[pid])
                    proofs.pop(pid, None)
                resume(identifier)
            else:
                waiting[pid] = [(held, held_kind) for held, held_kind in waiting[pid]
                                if ioctl(listener, ID_VALID, c.c_ulonglong(held))]
                waiting[pid].append((identifier, kind))
            return
        env = admission_environment(pid)
        broker = json.loads(env.get("LLV_CHECK_BROKER") or env.get("DELEGATUS_CHECK_BROKER") or "null")
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
        fd = os.pidfd_open(pid)
        tickets[pid] = [sock, False, b"", (json.dumps(request) + "\n").encode(), time.monotonic() + 5, fd]
        forget_exec(pid)
        proofs.setdefault(pid, kind)
        waiting[pid] = [(identifier, kind)]
        selector.register(sock, selectors.EVENT_WRITE, ("broker", pid))
        selector.register(fd, selectors.EVENT_READ, ("exit", pid))

    def compiler_open(info):
        tid, call = info.pid, info.data
        address = call.args[0] if call.nr == 2 else call.args[1]
        try:
            name = os.fsdecode(process_memory(tid, address, 4096).split(b"\0", 1)[0])
            base = f"/proc/{tid}/root" if name.startswith("/") else (
                f"/proc/{tid}/cwd" if c.c_int(call.args[0]).value == -100 or call.nr == 2
                else f"/proc/{tid}/fd/{call.args[0]}")
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

    def test_exec(pid):
        executable = os.path.realpath(f"/proc/{pid}/exe")
        if os.path.basename(executable) != "bun":
            return False
        env = environment(pid)
        if not (env.get("LLV_CHECK_BROKER") or env.get("DELEGATUS_CHECK_BROKER")) or not all(
                key in env for key in ["LLV_CHECK_ENTRY_PID", "LLV_PORTABLE_TEST_RUNNER_PID"]):
            return False
        with open(f"/proc/{pid}/cmdline", "rb") as file:
            argv = file.read().split(b"\0")[:-1]
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
                return True
            if argument != b"run":
                break
        return False

    def notification():
        # selectors maps POLLHUP to readable, but RECV blocks on an empty
        # listener even after its final process exits. Only consume POLLIN.
        if not any(mask & select.POLLIN for _fd, mask in listener_poll.poll(0)):
            return
        info = Notification()
        if not ioctl(listener, RECV, info):
            return
        try:
            if info.data.nr in execs:
                pid = process_id(info.pid)
                # Exec by a non-leader replaces its TID with the group PID.
                if pid in tickets and select.select([tickets[pid][5]], [], [], 0)[0]:
                    close_ticket(pid)
                forget_exec(pid)
                fd = os.pidfd_open(pid)
                fresh[pid] = fd
                selector.register(fd, selectors.EVENT_READ, ("exec-exit", pid))
                resume(info.id)
                return
            kind = None
            if info.pid in fresh:
                if test_exec(info.pid):
                    kind = "test"
                    proofs[info.pid] = "test"
                else:
                    forget_exec(info.pid)
            # Interrupted opens receive fresh IDs. Keep every open from a
            # queued worker held, and retain a test's proof obligation until
            # a live notification can carry it through admission.
            if proofs or waiting:
                pid = worker_pid(info.pid)
                if pid in proofs or pid in tickets and not tickets[pid][1]:
                    enroll(pid, info.id, proofs.get(pid, "compiler"))
                    return
            # A granted ticket counts this process through its exit. Further
            # opens cannot add another process; keep observing execs above
            # and all opens from descendants, which need their own tickets.
            if kind is None and granted_process(info.pid, tickets, groups):
                resume(info.id)
                return
            if kind is None and compiler_open(info):
                kind = "compiler"
            if kind:
                enroll(worker_pid(info.pid), info.id, kind)
            else:
                resume(info.id)
        except (OSError, ValueError, RuntimeError) as error:
            if ioctl(listener, ID_VALID, c.c_ulonglong(info.id)):
                refuse(worker_pid(info.pid), error, info.id)

    try:
        while result is None:
            deadlines = [ticket[4] for ticket in tickets.values() if ticket[3]]
            timeout = max(0, min(deadlines) - time.monotonic()) if deadlines else None
            # Reap the command before consuming listener hangup readiness.
            events = selector.select(timeout)
            events.sort(key=lambda event: event[0].data[0] == "notification")
            for key, mask in events:
                if result is not None:
                    break
                event, pid = key.data
                if event in ("wake", "root"):
                    if event == "wake":
                        try:
                            os.read(wake_read, 4096)
                        except BlockingIOError:
                            pass
                    while True:
                        try:
                            reaped, status = os.waitpid(-1, os.WNOHANG)
                        except ChildProcessError:
                            break
                        if not reaped:
                            break
                        forget_exec(reaped)
                        if reaped not in tickets:
                            proofs.pop(reaped, None)
                        if reaped == child:
                            result = os.waitstatus_to_exitcode(status)
                    continue
                if event == "notification":
                    notification()
                    continue
                if event == "exec-exit":
                    if fresh.get(pid) == key.fd:
                        forget_exec(pid)
                        if pid not in tickets:
                            proofs.pop(pid, None)
                    continue
                if pid not in tickets:
                    continue
                if event == "exit":
                    close_ticket(pid)
                    continue
                ticket = tickets[pid]
                try:
                    if mask & selectors.EVENT_WRITE:
                        error = ticket[0].getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                        if error:
                            raise OSError(error, "worker entry admission connect refused")
                        count = ticket[0].send(ticket[3])
                        ticket[3] = ticket[3][count:]
                        if not ticket[3]:
                            selector.modify(ticket[0], selectors.EVENT_READ, ("broker", pid))
                        continue
                    data = ticket[0].recv(64000)
                    if not data:
                        raise RuntimeError("admission broker closed")
                    ticket[2] += data
                    if len(ticket[2]) > 64000:
                        raise RuntimeError("admission broker reply too large")
                    if b"\n" in ticket[2] and not ticket[1]:
                        answer = json.loads(ticket[2])
                        if answer.get("admitted") is not True:
                            raise RuntimeError(answer.get("error", "worker entry admission refused"))
                        ticket[1] = True
                        for identifier, kind in waiting.pop(pid):
                            if not ioctl(listener, ID_VALID, c.c_ulonglong(identifier)):
                                continue
                            if pid in proofs:
                                proof(pid, proofs[pid])
                                proofs.pop(pid, None)
                            resume(identifier)
                except BlockingIOError:
                    pass
                except (OSError, ValueError, RuntimeError) as error:
                    refuse(pid, error)
                    close_ticket(pid)
            for pid, ticket in list(tickets.items()):
                if ticket[3] and time.monotonic() >= ticket[4]:
                    refuse(pid, "admission connect deadline expired")
                    close_ticket(pid)
        leaked = finish_children(cancelled)
        return result or int(leaked)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for pid in list(tickets):
            close_ticket(pid)
        for pid in list(fresh):
            forget_exec(pid)
        selector.close()
        os.close(listener)
        os.close(child_fd)
        signal.set_wakeup_fd(-1)
        os.close(wake_read)
        os.close(wake_write)


def exit_with_command_status(result):
    if result >= 0:
        sys.exit(result)
    # Cleanup is complete. Mirror the kernel wait status so the owner can
    # distinguish a signal from a command that explicitly exited with 128+N.
    sig = -result
    if sig != signal.SIGKILL:
        libc.prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE: avoid a second core dump.
        signal.signal(sig, signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {sig})
    os.kill(os.getpid(), sig)
    sys.exit(128 + sig)


if __name__ == "__main__":
    try:
        exit_with_command_status(main())
    except Exception as error:
        print(f"worker entry refused: {error}", file=sys.stderr)
        sys.exit(69)
