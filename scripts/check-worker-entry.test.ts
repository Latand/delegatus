import { expect, test } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";

const entry = path.join(import.meta.dir, "check-worker-entry.py");
for (const mode of ["member", "foreign", "exited", "queued", "cache-bound"]) test.skipIf(process.platform !== "linux")(`granted process reuse verifies kernel thread membership: ${mode}`, () => {
  const source = String.raw`import os,runpy,subprocess,sys,threading
entry=runpy.run_path(sys.argv[1]);mode=sys.argv[2]
held=threading.Event();thread=threading.Thread(target=held.wait);thread.start()
child=subprocess.Popen(["sleep","300"])
fd=os.pidfd_open(child.pid if mode == "exited" else os.getpid())
try:
 pid=child.pid if mode == "exited" else os.getpid()
 tickets={pid:[None,mode != "queued",None,None,None,fd]}
 groups={child.pid:os.getpid()} if mode == "foreign" else ({-n:0 for n in range(1,4097)} if mode == "cache-bound" else {})
 tid=child.pid if mode in ("foreign","exited") else thread.native_id
 if mode == "exited": child.terminate();child.wait()
 assert entry["granted_process"](tid,tickets,groups) is (mode in ("member","cache-bound"))
 if mode == "cache-bound": assert len(groups) == 1
finally:
 os.close(fd);held.set();thread.join()
 if child.poll() is None:child.terminate()
 child.wait()
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry, mode], { encoding: "utf8", timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
});

for (const call of ["open", "openat"]) for (const [flags, admitted] of [
  ["os.O_WRONLY", false],
  ["os.O_RDWR | os.O_TRUNC", false],
  ["os.O_RDONLY", true],
  ["os.O_RDWR", true],
  ["os.O_PATH", true],
  ["os.O_PATH | os.O_WRONLY", true],
  ["os.O_PATH | os.O_TRUNC", true],
] as const) test.skipIf(process.platform !== "linux" || call === "open" && process.arch !== "x64")(`${call} preserves compiler admission for ${flags}`, () => {
  const source = String.raw`import ctypes,os,platform,subprocess,sys,tempfile
with tempfile.TemporaryDirectory() as root:
 filename=os.path.join(root,"compiler")
 with open(filename,"w") as file: file.write("Micro"+"soft Corporation\nfunction cre"+"ateProgram(")
 command='''import ctypes,os,sys
libc=ctypes.CDLL(None,use_errno=True)
name=ctypes.c_char_p(os.fsencode(sys.argv[1]))
flags=eval(sys.argv[2])
number=2 if sys.argv[3] == "open" else (257 if sys.argv[4] == "x86_64" else 56)
print("opening",flush=True)
fd=libc.syscall(number,name,flags,0) if number == 2 else libc.syscall(number,-100,name,flags,0)
assert fd >= 0,ctypes.get_errno()
os.close(fd)
'''
 env={**os.environ,"LLV_CHECK_BROKER":'{"port":1,"nonce":"fixture"}'}
 result=subprocess.run(["python3","-I",sys.argv[1],"python3","-I","-c",command,filename,sys.argv[2],sys.argv[3],platform.machine()],env=env,capture_output=True,text=True,timeout=5)
 assert result.stdout == "opening\n",result
 if sys.argv[4] == "true":
  assert result.returncode == 137,result
 else:
  assert result.returncode == 0,result.stderr
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry, flags, call, String(admitted)], { encoding: "utf8", timeout: 8_000 });
  expect(result.status, result.stderr).toBe(0);
});

for (const fallback of [false, true]) test.skipIf(process.platform !== "linux")(`stopped-task memory reads preserve bytes through proc fallback=${fallback}`, () => {
  const script = `import runpy,sys,ctypes,os
entry=runpy.run_path(sys.argv[1])
value=ctypes.create_string_buffer(b"compiler path\\0trailing bytes")
${fallback ? 'entry["libc"].process_vm_readv=lambda *args: -1' : ""}
assert entry["process_memory"](os.getpid(),ctypes.addressof(value),len(value)) == value.raw
`;
  const result = spawnSync("python3", ["-I", "-c", script, entry], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});

test.skipIf(process.platform !== "linux")("a cancellation tree walk retries an interrupted proc snapshot", () => {
  const source = String.raw`import os,runpy,subprocess,sys
entry=runpy.run_path(sys.argv[1])
child=subprocess.Popen(["sleep","30"])
original=os.listdir
attempts=0
def interrupted(path):
 global attempts
 attempts+=1
 if attempts == 1: raise InterruptedError("fixture proc interruption")
 return original(path)
try:
 os.listdir=interrupted
 assert child.pid in entry["child_pids"](os.getpid())
 assert attempts == 2
finally:
 os.listdir=original
 child.terminate();child.wait()
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry], { encoding: "utf8", timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
});

for (const nested of [false, true]) test.skipIf(process.platform !== "linux")(`listener preserves command identity and leaves ptrace free nested=${nested}`, () => {
  const source = String.raw`import os,re
status=open("/proc/self/status").read()
assert re.search(r"TracerPid:\s+0\n",status),status
assert int(re.search(r"Seccomp_filters:\s+(\d+)",status)[1]) >= 1
if "LLV_OWNED_TEST_RUNNER_PID" in os.environ:
 assert int(os.environ["LLV_OWNED_TEST_RUNNER_PID"]) == os.getpid()
 assert int(os.environ["LLV_PORTABLE_TEST_RUNNER_PID"]) == 0
else:
 assert int(os.environ["LLV_PORTABLE_TEST_RUNNER_PID"]) == os.getpid()
assert int(os.environ["LLV_CHECK_ENTRY_PID"]) == 0
`;
  const command = ["python3", "-I", "-c", source];
  const result = spawnSync("python3", ["-I", entry, ...(nested ? ["python3", "-I", entry] : []), ...command], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
});

test.skipIf(process.platform !== "linux" || !Bun.which("strace"))("a gated command can trace its child and inject ENOSPC", () => {
  const result = spawnSync("python3", ["-I", entry, "strace", "-f", "-e", "inject=symlinkat:error=ENOSPC:when=1", "ln", "-s", "source", "entry-injected-link"], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("ENOSPC");
  expect(result.stderr).toContain("INJECTED");
});

for (const descendant of [false, true]) test.skipIf(process.platform !== "linux")(`terminal child snapshots retain newly adopted descendants=${descendant}`, () => {
  const command = descendant
    ? "import os,time;os.read(0,1);pid=os.fork();time.sleep(300) if pid==0 else None;os._exit(0)"
    : "import os;os.read(0,1);os._exit(0)";
  const source = String.raw`import os,runpy,select,signal,subprocess,sys,time
entry=runpy.run_path(sys.argv[1])
assert entry["libc"].prctl(36,1,0,0,0) == 0
finish=entry["finish_children"]
original=finish.__globals__["child_pids"]
child=subprocess.Popen(["python3","-I","-c",sys.argv[2]],stdin=subprocess.PIPE)
released=False
def after_reap(parent):
 global released
 observed=original(parent)
 if parent == os.getpid() and not released:
  released=True
  descriptor=os.pidfd_open(child.pid)
  try:
   child.stdin.write(b"1");child.stdin.flush()
   exited=select.poll();exited.register(descriptor,select.POLLIN)
   assert exited.poll(2000),"fixture child did not exit"
  finally: os.close(descriptor)
 return observed
try:
 finish.__globals__["child_pids"]=after_reap
 assert finish(False) is (sys.argv[3] == "true"),"terminal snapshot changed the live-child verdict"
 assert not original(os.getpid()),"owned children were not reaped before the verdict"
finally:
 finish.__globals__["child_pids"]=original
 child.stdin.close()
 deadline=time.monotonic()+2
 while original(os.getpid()):
  for pid in original(os.getpid()):
   try:
    descriptor=os.pidfd_open(pid)
    try:
     if int(open(f"/proc/{pid}/stat").read().rsplit(")",1)[1].split()[1]) == os.getpid(): signal.pidfd_send_signal(descriptor,signal.SIGKILL)
    finally: os.close(descriptor)
   except (FileNotFoundError,ProcessLookupError): pass
  while True:
   try:
    if not os.waitpid(-1,os.WNOHANG)[0]:break
   except ChildProcessError:break
  assert time.monotonic()<deadline,"fixture cleanup did not finish"
  time.sleep(0.005)
 child.wait()
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry, command, String(descendant)], { encoding: "utf8", timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
});

for (const live of [false, true]) test.skipIf(process.platform !== "linux")(`a nested entry reaps adopted children before its verdict live=${live}`, () => {
  const command = live ? String.raw`import os,subprocess
child=subprocess.Popen(["sleep","300"],start_new_session=True)
print(child.pid,flush=True)
os._exit(0)
` : String.raw`import os,select
pid=os.fork()
if pid == 0: os._exit(0)
fd=os.pidfd_open(pid)
poll=select.poll();poll.register(fd,select.POLLIN);poll.poll()
print(pid,flush=True)
os._exit(0)
`;
  // A second real subreaper holds anything the entry leaves behind, making
  // the assertion independent of the outer runner's reaping speed.
  const source = String.raw`import ctypes,os,signal,subprocess,sys,time
assert ctypes.CDLL(None).prctl(36,1,0,0,0) == 0
def children():
 return list(map(int,open(f"/proc/self/task/{os.getpid()}/children").read().split()))
try:
 result=subprocess.run(["python3","-I",sys.argv[1],"python3","-I","-c",sys.argv[2]],capture_output=True,text=True,timeout=8)
 remaining=children()
finally:
 deadline=time.monotonic()+2
 while children():
  for pid in children():
   try:
    fd=os.pidfd_open(pid)
    try:
     parent=int(open(f"/proc/{pid}/stat").read().rsplit(")",1)[1].split()[1])
     if parent == os.getpid(): signal.pidfd_send_signal(fd,signal.SIGKILL)
    finally: os.close(fd)
   except (FileNotFoundError,ProcessLookupError): pass
  while True:
   try:
    if not os.waitpid(-1,os.WNOHANG)[0]: break
   except ChildProcessError: break
  assert time.monotonic()<deadline,"fixture cleanup did not finish"
  time.sleep(0.005)
assert result.returncode == int(sys.argv[3]),result.stderr
assert not remaining,(remaining,result.stderr)
if int(sys.argv[3]):
 import re
 pid=int(result.stdout.strip())
 assert re.search(rf"owned runner: surviving owned processes: {pid} \({pid}:\d+\)",result.stderr),result.stderr
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry, command, live ? "1" : "0"], { encoding: "utf8", timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
});

for (const nested of [false, true]) for (const stopped of [false, true]) test.skipIf(process.platform !== "linux")(`cancellation ends TERM-resistant commands and descendants nested=${nested} stopped=${stopped}`, () => {
  const command = String.raw`import os,signal,subprocess,sys
signal.signal(signal.SIGTERM,signal.SIG_IGN)
signal.signal(signal.SIGCONT,lambda *_:open(sys.argv[1],"w").write("resumed"))
child=subprocess.Popen(["python3","-I","-c","import signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);signal.pause()"],stdout=subprocess.PIPE,text=True,start_new_session=True)
assert child.stdout.readline().strip() == "ready"
print(str(os.getpid())+" "+str(child.pid),flush=True)
signal.pause()
`;
  const source = String.raw`import ctypes,os,select,signal,subprocess,sys,tempfile,time
assert ctypes.CDLL(None).prctl(36,1,0,0,0) == 0
def children():
 return list(map(int,open(f"/proc/self/task/{os.getpid()}/children").read().split()))
args=["python3","-I",sys.argv[1]]
if sys.argv[3] == "true": args += ["python3","-I",sys.argv[1]]
directory=tempfile.TemporaryDirectory()
marker=os.path.join(directory.name,"effect")
runner=subprocess.Popen([*args,"python3","-I","-c",sys.argv[2],marker],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
descriptors=[]
try:
 pids=list(map(int,runner.stdout.readline().split()))
 for pid in pids: descriptors.append(os.pidfd_open(pid))
 assert len(descriptors) == 2
 if sys.argv[4] == "true":
  signal.pidfd_send_signal(descriptors[0],signal.SIGSTOP)
  deadline=time.monotonic()+1
  while open(f"/proc/{pids[0]}/stat").read().rsplit(")",1)[1].split()[0] != "T":
   assert time.monotonic()<deadline,"fixture command did not stop"
   time.sleep(0.005)
 runner.terminate()
 assert runner.wait(timeout=2) in (137,143)
 for fd in descriptors:
  poll=select.poll();poll.register(fd,select.POLLIN)
  assert poll.poll(0),"cancelled descendant still alive at supervisor exit"
 assert not children(),"supervisor left adopted children"
 assert not os.path.exists(marker),"cancellation resumed user code"
finally:
 # A failed assertion still cleans only this fixture's captured descendants.
 for fd in descriptors:
  try: signal.pidfd_send_signal(fd,signal.SIGKILL)
  except ProcessLookupError: pass
  os.close(fd)
 if runner.poll() is None: runner.kill()
 runner.wait()
 deadline=time.monotonic()+2
 while children():
  for pid in children():
   try:
    fd=os.pidfd_open(pid)
    try:
     if int(open(f"/proc/{pid}/stat").read().rsplit(")",1)[1].split()[1]) == os.getpid(): signal.pidfd_send_signal(fd,signal.SIGKILL)
    finally: os.close(fd)
   except (FileNotFoundError,ProcessLookupError): pass
  while True:
   try:
    if not os.waitpid(-1,os.WNOHANG)[0]: break
   except ChildProcessError: break
  assert time.monotonic()<deadline,"fixture cleanup did not finish"
  time.sleep(0.005)
 directory.cleanup()
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry, command, String(nested), String(stopped)], { encoding: "utf8", timeout: 8_000 });
  expect(result.status, result.stderr).toBe(0);
});
