"""Bounded saturation control. No child ever forks; every child lives <=3 s."""
import errno
import os
from pathlib import Path
import re
import signal
import sys
import time


def main():
    if sys.platform != "linux":
        raise RuntimeError("fixture requires a limited Linux gate unit")
    group = next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    if not re.search(r"/delegatus-gate-[0-9a-f-]{36}\.service$", group):
        raise RuntimeError("fixture refuses to fork outside a limited gate unit")
    if os.environ.get("LLV_OWNED_TEST_RUN_CGROUP") != group:
        raise RuntimeError("fixture has no verified gate admission")
    directory = Path("/sys/fs/cgroup") / group.lstrip("/")
    maximum = (directory / "pids.max").read_text().strip()
    if not maximum.isdigit() or not 32 <= int(maximum) <= 4096:
        raise RuntimeError("fixture requires a finite pids.max between 32 and 4096")
    if not re.search(r"^max 0$", (directory / "pids.events").read_text(), re.M):
        raise RuntimeError("fixture requires a fresh denial counter")

    # The guard above runs before the first fork. Count and wall-clock bounds
    # also hold if the runner's event observer fails. Children do no work.
    signal.alarm(5)
    if "--stop-supervisor" in sys.argv[1:]:
        supervisor = os.getppid()
        if f"0::{group}" not in Path(f"/proc/{supervisor}/cgroup").read_text().splitlines():
            raise RuntimeError("fixture supervisor is outside its owned gate")
        os.kill(supervisor, signal.SIGSTOP)
    deadline = time.monotonic() + 2
    children = []
    denied = False
    try:
        for _ in range(int(maximum) + 1):
            if time.monotonic() >= deadline:
                break
            try:
                pid = os.fork()
            except OSError as error:
                if error.errno != errno.EAGAIN:
                    raise
                denied = True
                print("bounded fixture: fork refused by the task limit", flush=True)
                break
            if pid == 0:
                signal.alarm(3)
                time.sleep(3)
                os._exit(0)
            children.append(pid)
        # Even a successful command status must become the runner's named
        # failure after a denial. Hold briefly so the live observer sees it.
        if denied and "--exit-on-denial" not in sys.argv[1:]:
            time.sleep(0.2)
        elif not denied:
            raise RuntimeError("bounded fixture did not reach the task limit")
    finally:
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for pid in children:
            os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
