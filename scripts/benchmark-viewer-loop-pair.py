"""Pair compiled Viewer slice servers in two scratch exports; no live state is read."""
import argparse
import hashlib
import json
import os
import pathlib
import selectors
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("before", type=pathlib.Path)
parser.add_argument("after", type=pathlib.Path)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
scratch = pathlib.Path(os.environ["TMPDIR"]).resolve()
before, after, output = args.before.resolve(), args.after.resolve(), args.output.resolve()
for checkout in (before, after):
    if not checkout.is_relative_to(scratch) or (checkout / ".git").exists():
        raise SystemExit("use scratch exports under TMPDIR")
if not output.is_relative_to(scratch):
    raise SystemExit("keep raw measurement output under TMPDIR")
owned = pathlib.Path(tempfile.mkdtemp(prefix="viewer-loop-pair-", dir=scratch))
driver = pathlib.Path(__file__).with_name("benchmark-viewer-loop.ts").read_bytes()
children = []
origins = {}
result = {"conditions": {}, "runs": [], "method": {"sampleIntervalUs": 1000, "repeats": 3, "order": "alternating", "concurrentRequests": 1}}


def digest_source(checkout):
    digest = hashlib.sha256()
    for file in sorted((checkout / "src").rglob("*")):
        if file.is_file() and ".test." not in file.name:
            digest.update(file.relative_to(checkout).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def resources():
    rows = []
    try:
        group = pathlib.Path("/sys/fs/cgroup" + pathlib.Path("/proc/self/cgroup").read_text().split("0::")[1].strip())
        while group.is_relative_to("/sys/fs/cgroup"):
            rows.append({key: (group / file).read_text().strip() for key, file in (("cpuMax", "cpu.max"), ("memoryMax", "memory.max")) if (group / file).exists()})
            if group == pathlib.Path("/sys/fs/cgroup"):
                break
            group = group.parent
    except (OSError, IndexError):
        pass
    return rows


def ready(child):
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        if not selector.select(180):
            raise RuntimeError("benchmark readiness deadline")
        line = child.stdout.readline()
        if not line:
            raise RuntimeError("benchmark server exited before readiness; inspect its scratch log")
        return json.loads(line)
    finally:
        selector.close()


try:
    result["resources"] = resources()
    for arm, checkout in (("before", before), ("after", after)):
        # The exact same driver is compiled against each export's production code.
        (checkout / "scripts/benchmark-viewer-loop.ts").write_bytes(driver)
        bundle = owned / (arm + "-server.js")
        with (owned / (arm + "-build.log")).open("w") as log:
            subprocess.run(["bun", "build", "scripts/benchmark-viewer-loop.ts", "--target=bun", "--outfile=" + str(bundle)], cwd=checkout, stdout=log, stderr=log, check=True)
        private = owned / ("arm-a" if arm == "before" else "arm-b")
        env = os.environ.copy()
        for key, part in {"HOME": "home", "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache", "TMPDIR": "tmp", "LLV_STATE_DIR": "state", "LLV_CLAUDE_HOME": "claude", "CLAUDE_CONFIG_DIR": "claude", "LLV_CODEX_HOME": "state/codex", "CODEX_HOME": "state/codex", "OPENCLAW_STATE_DIR": "openclaw"}.items():
            folder = private / part
            folder.mkdir(parents=True, exist_ok=True)
            env[key] = str(folder)
        env.update(LLV_VIEWER_CONTROL_URL="http://127.0.0.1:1", LLV_STATE_OWNER="viewer", LLV_LOOP_BENCHMARK="1", NODE_ENV="production")
        errors = (owned / (arm + "-server.log")).open("w")
        child = subprocess.Popen(["bun", str(bundle), "--serve"], cwd=checkout, env=env, stdout=subprocess.PIPE, stderr=errors, text=True)
        children.append((child, errors))
        (owned / (arm + "-server.pid")).write_text(str(child.pid))
        handshake = ready(child)
        origins[arm] = handshake["ready"]
        result["conditions"][arm] = {**handshake["conditions"], "sourceSha256": digest_source(checkout), "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(), "packageSha256": hashlib.sha256((checkout / "package.json").read_bytes()).hexdigest(), "lockSha256": hashlib.sha256((checkout / "bun.lock").read_bytes()).hexdigest()}
    if result["conditions"]["before"]["synthetic"] != result["conditions"]["after"]["synthetic"]:
        output.write_text(json.dumps(result, indent=2) + "\n")
        raise RuntimeError("the paired synthetic corpora differ")
    for repeat in range(3):
        for case in ("memory", "seat", "merge", "registry", "session"):
            for arm in (("before", "after") if repeat % 2 == 0 else ("after", "before")):
                with urllib.request.urlopen(origins[arm] + "/" + case, timeout=180) as response:
                    row = json.load(response)
                result["runs"].append({"arm": arm, "repeat": repeat, **row})
                print(json.dumps({"arm": arm, "repeat": repeat, "case": case, "sampledMs": row["profiledSyncMs"], "gapP95": row["gapP95"], "gapMax": row["gapMax"]}), flush=True)
    result["utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
finally:
    for child, errors in children:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        errors.close()
