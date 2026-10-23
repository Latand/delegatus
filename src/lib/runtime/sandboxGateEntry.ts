import type { ProcessIdentity } from "@/lib/processIdentity";

/** Runs inside a gate service, in the host PID namespace, and moves the
 * gate's command into the recorded caller's user, PID and mount namespaces
 * before it executes. The service's cgroup, and so its memory and CPU limits,
 * stay with the command; the signal boundary stays with it too, because the
 * command and its descendants see and signal only the caller's namespace.
 *
 * Python, because a user namespace admits only a single-threaded process and
 * Bun is never one. Bubblewrap nests the caller's user namespace inside the
 * one that owns its PID and mount namespaces, so each user namespace on the
 * chain is entered from the outside in, and each other namespace right after
 * the user namespace that owns it. Every refusal comes before the fork, so the
 * command either runs inside the caller's namespaces or not at all. */
const ENTRY = String.raw`
import ctypes, fcntl, json, os, signal, sys
NEWNS, NEWUSER, NEWPID = 0x00020000, 0x10000000, 0x20000000
GET_USERNS, GET_PARENT = 0xb701, 0xb702
libc = ctypes.CDLL(None, use_errno=True)

def refuse(reason):
    print("gate-slot: the gate service could not enter the caller's signal namespace: " + reason + "; the command did not run", file=sys.stderr, flush=True)
    os._exit(69)

def start(pid):
    try:
        text = open("/proc/%s/stat" % pid).read()
    except OSError:
        return None
    fields = text[text.rindex(")") + 2:].split()
    return None if fields[0] in ("Z", "X", "x") else "%s:%s" % (text.split()[0], fields[19])

def same(a, b):
    first, second = os.fstat(a), os.fstat(b)
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)

def enter(descriptor, kind):
    if libc.setns(descriptor, kind) != 0:
        refuse("setns: " + os.strerror(ctypes.get_errno()))

pid, identity, cwd, command = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4:]
# The command's ancestry proof names this process; read it before any entry.
entry = start("self")
cgroup = next(line[3:] for line in open("/proc/self/cgroup").read().splitlines() if line.startswith("0::"))
try:
    target = {kind: os.open("/proc/%d/ns/%s" % (pid, kind), os.O_RDONLY | os.O_CLOEXEC) for kind in ("user", "pid", "mnt")}
    own = {kind: os.open("/proc/self/ns/" + kind, os.O_RDONLY | os.O_CLOEXEC) for kind in ("user", "pid")}
except OSError as error:
    refuse("its namespaces are unreadable (" + error.strerror + ")")
# Opened before this check, the descriptors belong to the recorded caller.
if start(pid) != identity:
    refuse("the caller ended before entry")
if same(target["pid"], own["pid"]) or same(target["user"], own["user"]):
    refuse("the caller shares this service's namespaces")
chain = [target["user"]]
while not same(chain[-1], own["user"]):
    try:
        if len(chain) > 32:
            raise OSError()
        chain.append(fcntl.ioctl(chain[-1], GET_PARENT))
    except OSError:
        refuse("the caller's user namespace does not descend from the service's")
owners = {kind: fcntl.ioctl(target[kind], GET_USERNS) for kind in ("pid", "mnt")}
pending = {"pid": NEWPID, "mnt": NEWNS}
for user in reversed(chain[:-1]):
    enter(user, NEWUSER)
    for kind in [kind for kind in pending if same(owners[kind], user)]:
        enter(target[kind], pending.pop(kind))
if pending:
    refuse("the caller's " + " and ".join(pending) + " namespace is owned outside its user namespace chain")
if os.getuid() == 0:
    refuse("the caller's namespace maps this user to root")
context = json.loads(os.environ["LLV_SIGNAL_SANDBOX"])
context["gate"] = {"cgroup": cgroup, "entry": entry}
os.environ["LLV_SIGNAL_SANDBOX"] = json.dumps(context)
child = os.fork()
if child == 0:
    try:
        for number in (signal.SIGPIPE, signal.SIGXFSZ):
            signal.signal(number, signal.SIG_DFL)
        if libc.prctl(38, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "no_new_privs was refused")
        os.chdir(cwd)
        os.execvp(command[0], command)
    except BaseException as error:
        print("gate-slot: the command could not start: %s" % error, file=sys.stderr, flush=True)
    os._exit(127)

def forward(number, _frame):
    try:
        os.kill(child, number)
    except ProcessLookupError:
        pass

for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(number, forward)
_, status = os.waitpid(child, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;

/** The argv that enters `owner`'s namespaces and then executes `command`.
 * `owner` is a host-namespace identity (`cpuOwnerIdentity`). */
export function sandboxGateEntryCommand(owner: ProcessIdentity, cwd: string, command: string[]): string[] {
  if (!owner.startIdentity) throw new Error("owned runner has no verifiable namespace owner");
  return ["python3", "-I", "-c", ENTRY, String(owner.pid), owner.startIdentity, cwd, ...command];
}
