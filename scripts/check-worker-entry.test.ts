import { expect, test } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";

const entry = path.join(import.meta.dir, "check-worker-entry.py");
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
if int(sys.argv[3]): assert "surviving owned processes" in result.stderr,result.stderr
`;
  const result = spawnSync("python3", ["-I", "-c", source, entry, command, live ? "1" : "0"], { encoding: "utf8", timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
});
