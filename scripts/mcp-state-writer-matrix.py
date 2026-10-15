"""Replay immutable product revisions through the existing state-writer driver.

Each sample takes its own owned-runner admission. Interrupted samples stay on
disk; rerunning the same command resumes only samples with complete reports.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import time

REPO = pathlib.Path(__file__).resolve().parents[1]
HARNESS = ["scripts/mcp-call-cost-benchmark.ts", "scripts/mcp-state-writer-benchmark.ts",
           "scripts/mcp-state-writer-report.ts", "scripts/sqlite-observer.ts",
           "scripts/sqlite-observer.c", "scripts/mcp-state-writer-matrix.py",
           "src/lib/mcp/writerConcurrencyChild.ts", "src/lib/mcp/ownedFixtureChildren.ts"]


def digest(filename):
    with open(filename, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()


def environment(root):
    env = {k: v for k, v in os.environ.items() if not k.startswith(
        ("LLV_", "DELEGATUS_", "MCP_SQL_", "MCP_BENCH_", "NEXT_PUBLIC_", "TMUX"))}
    for key in ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR", "LLV_CODEX_HOME",
                "LLV_CLAUDE_HOME", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "GH_CONFIG_DIR", "TMUX_TMPDIR"]:
        folder = root / key
        folder.mkdir(parents=True, exist_ok=True)
        env[key] = str(folder)
    env.update(CODEX_HOME=env["LLV_CODEX_HOME"], CLAUDE_CONFIG_DIR=env["LLV_CLAUDE_HOME"],
               LLV_VIEWER_CONTROL_URL="http://127.0.0.1:1", NODE_ENV="test", LLV_STRUCTURED_HOSTS="0")
    return env


def quotas():
    relative = next(line[3:] for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    leaf = pathlib.Path("/sys/fs/cgroup") / relative.lstrip("/")
    return [{name: (parent / name).read_text().strip() for name in
             ["cpu.max", "memory.max", "cpuset.cpus.effective"] if (parent / name).exists()}
            for parent in [leaf, *leaf.parents] if str(parent).startswith("/sys/fs/cgroup")]


def run(gate, command, cwd, env, log):
    with open(log, "w") as output, open(str(log) + ".stderr", "w") as errors:
        child = subprocess.Popen(["bash", str(gate), *command], cwd=cwd, env=env,
                                 stdout=output, stderr=errors)
        pathlib.Path(str(log) + ".pid").write_text(str(child.pid))
        code = child.wait()
    if code:
        raise RuntimeError(f"owned command exited {code}; see {pathlib.Path(log).name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["output", "gate", "observer", "seed", "capabilities"]:
        parser.add_argument("--" + name, required=True, type=pathlib.Path)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--audit", default="45d25ac")
    parser.add_argument("--candidate", default="HEAD")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--clients", nargs="+", type=int, choices=[1, 19, 37], default=[1, 19, 37])
    parser.add_argument("--modes", nargs="+", choices=["stdio-independent", "stdio-shared", "http-independent", "http-shared"],
                        default=["stdio-independent", "stdio-shared", "http-independent", "http-shared"])
    parser.add_argument("--sides", nargs="+", choices=["audit", "main", "candidate"], default=["audit", "main", "candidate"])
    parser.add_argument("--repeats", type=int, choices=[1, 2, 3], default=3)
    args = parser.parse_args()
    if git("status", "--porcelain"):
        raise RuntimeError("freeze requires a clean source checkout")
    root = args.output.resolve()
    if not str(root).startswith("/tmp/"):
        raise RuntimeError("samples require an explicit temp-root sandbox")
    root.mkdir(parents=True, exist_ok=True)
    bun = pathlib.Path(shutil.which("bun"))
    observer = args.observer.resolve()
    seed = args.seed.resolve()
    checksum = hashlib.sha256()
    for filename in sorted(seed.rglob("*")):
        if filename.is_file():
            checksum.update(str(pathlib.Path("LLV_STATE_DIR") / filename.relative_to(seed)).encode())
            checksum.update(filename.read_bytes())
    seed_hash = checksum.hexdigest()
    head = git("rev-parse", args.candidate)
    exports = {}
    for side, ref in [("audit", args.audit), ("main", args.baseline), ("candidate", head)]:
        revision = git("rev-parse", ref)
        target = root / side
        manifest_path = root / (side + ".manifest.json")
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            if manifest["sourceRevision"] != revision or manifest["harnessRevision"] != head:
                raise RuntimeError("resume cannot replace an immutable export")
        else:
            target.mkdir()
            archive = root / (side + ".tar")
            with archive.open("wb") as output:
                subprocess.run(["git", "archive", revision], cwd=REPO, stdout=output, check=True)
            subprocess.run(["tar", "-xf", str(archive), "-C", str(target)], check=True)
            for filename in HARNESS:
                shutil.copy2(REPO / filename, target / filename)
            (target / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
            manifest = {"sourceRevision": revision, "sourceArchiveSha256": digest(archive),
                        "harnessRevision": head, "harnessFiles": {f: digest(REPO / f) for f in HARNESS},
                        "observerSha256": digest(observer), "bunVersion": subprocess.check_output([str(bun), "--version"], text=True).strip(),
                        "bunSha256": digest(bun), "nodeVersion": subprocess.check_output(["node", "--version"], text=True).strip(),
                        "kernel": platform.release(), "quotaHierarchyLeafFirst": quotas(), "seedSha256": seed_hash}
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        exports[side] = (target, manifest)
    records = []
    # Each repeat reverses the order, including the original audit control.
    for clients in args.clients:
        for scenario in args.modes:
            mode, sharing = scenario.split("-")
            shared = sharing == "shared"
            for repeat in range(1 if args.smoke else args.repeats):
                for side in (args.sides if repeat % 2 == 0 else list(reversed(args.sides))):
                    sample = root / f"{side}-{clients}-{mode}-{'shared' if shared else 'independent'}-{repeat + 1}"
                    target, manifest = exports[side]
                    if not (sample / "report.json").exists():
                        if sample.exists():
                            raise RuntimeError(f"partial sample retained: {sample.name}; choose a new output directory")
                        sample.mkdir()
                        env = environment(sample / "controller")
                        env.update(MCP_BENCH_OUTPUT=str(sample), MCP_BENCH_SEED=str(seed),
                                   MCP_BENCH_CAPABILITIES=str(args.capabilities.resolve()), MCP_BENCH_SEED_CHECKSUM=seed_hash,
                                   MCP_SQL_OBSERVER=str(observer), MCP_BENCH_CLIENTS=str(clients),
                                   MCP_BENCH_TRANSPORT=mode, MCP_BENCH_SHARED="1" if shared else "0",
                                   MCP_BENCH_HOST_NAMESPACE=os.readlink("/proc/self/ns/pid"))
                        if args.smoke:
                            env.update(MCP_BENCH_WARM_SECONDS="1", MCP_BENCH_SECONDS="10")
                        sample_manifest = {**manifest, "clients": clients, "transport": mode, "shared": shared,
                                           "repeat": repeat + 1, "startedAt": time.time(), "smoke": args.smoke}
                        (sample / "manifest.json").write_text(json.dumps(sample_manifest, indent=2) + "\n")
                        command = ["unshare", "--user", f"--map-user={os.getuid()}", f"--map-group={os.getgid()}",
                                   "--pid", "--fork", "--kill-child", "--mount-proc", "sh", "-c", '"$@"; exit $?', "sh",
                                   str(bun), "scripts/mcp-call-cost-benchmark.ts", "--state-writer-sample"]
                        print("START", sample.name, flush=True)
                        run(args.gate, command, target, env, sample / "run.log")
                        run(args.gate, [str(bun), "scripts/mcp-call-cost-benchmark.ts", "--state-writer-report", str(sample)],
                            target, environment(sample / "analysis"), sample / "report-output.log")
                        (sample / "report.json").write_text((sample / "report-output.log").read_text())
                    records.append({"sample": sample.name, "manifest": json.loads((sample / "manifest.json").read_text()),
                                    "report": json.loads((sample / "report.json").read_text())})
                    (root / "matrix.json").write_text(json.dumps({"samples": records}, indent=2) + "\n")
                    print("COMPLETE", sample.name, flush=True)


if __name__ == "__main__":
    main()
