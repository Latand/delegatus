"""Run a check with private homes, provider roots, state and temporary paths.

Scratch is removed after success or failure. Pass --keep to retain it for
inspection. --root or the caller's TMPDIR overrides the persistent Unix default.
Only Bun's package cache is shared; operator state and provider homes stay private.
"""
import argparse
import datetime
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile


def scratch_parent(explicit):
    if explicit:
        return explicit
    for key in ("TMPDIR", "TMP", "TEMP"):
        if os.environ.get(key):
            return os.environ[key]
    return "/var/tmp" if os.name == "posix" else None


def package_cache():
    explicit = os.environ.get("BUN_INSTALL_CACHE_DIR")
    base = pathlib.Path(os.environ.get("XDG_CACHE_HOME") or pathlib.Path.home() / ".cache")
    cache = pathlib.Path(explicit) if explicit else base / "delegatus" / "performance-bun"
    cache = cache.expanduser().absolute()
    cache.mkdir(parents=True, exist_ok=True)
    return str(cache)


def diagnostic(message):
    # A closed diagnostic pipe must not change the command's result or cleanup.
    try:
        os.write(2, (message + "\n").encode("utf-8", "backslashreplace"))
    except OSError:
        pass


def remove_scratch(root):
    pending = [root]
    while pending:
        directory = pending.pop()
        current = directory.lstat()
        if not stat.S_ISDIR(current.st_mode):
            continue
        # Private directories need owner write/search permission for removal.
        # Keep symlink targets and file modes (including hardlinks) untouched.
        os.chmod(directory, current.st_mode | stat.S_IRWXU, follow_symlinks=False)
        with os.scandir(directory) as entries:
            pending.extend(pathlib.Path(entry.path) for entry in entries
                           if entry.is_dir(follow_symlinks=False))
    shutil.rmtree(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="retain this run's scratch directory")
    parser.add_argument("--root", help="existing parent directory for this run's scratch")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")

    parent = scratch_parent(args.root)
    if parent is not None:
        parent = str(pathlib.Path(parent).expanduser().absolute())
    try:
        cwd = os.getcwd()
    except OSError:
        # A removed working directory must not prevent an otherwise valid check.
        cwd = None
    record = {
        "schemaVersion": 1, "pid": os.getpid(), "cwd": cwd,
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "program": pathlib.Path(command[0]).name, "keep": args.keep, "exitCode": None,
    }
    root = pathlib.Path(tempfile.mkdtemp(prefix="lvpf-", dir=parent))
    original = root.stat()

    def write_record():
        descriptor, temporary = tempfile.mkstemp(prefix=".run-", dir=root)
        try:
            with os.fdopen(descriptor, "w") as output:
                output.write(json.dumps(record, indent=2) + "\n")
            os.replace(temporary, root / "run.json")
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    try:
        diagnostic(f"isolated-performance: scratch {root}")
        write_record()
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "TZ")}
        for key, sub in {
            "HOME": "h", "XDG_CONFIG_HOME": "c", "XDG_CACHE_HOME": "cache",
            "XDG_RUNTIME_DIR": "r", "TMPDIR": "t", "TMP": "t", "TEMP": "t",
            "LLV_STATE_DIR": "s", "LLV_CLAUDE_HOME": "claude", "CLAUDE_CONFIG_DIR": "claude",
            "LLV_CODEX_HOME": "codex", "CODEX_HOME": "codex",
        }.items():
            directory = root / sub
            directory.mkdir(exist_ok=True)
            env[key] = str(directory)
        env.update(
            NEXT_TELEMETRY_DISABLED="1", LLV_ACCOUNT_CONTROLLER_DISABLED="1",
            LLV_REAPER_ENABLED="0", LLV_RUNTIME_EVENTS="0",
            BUN_INSTALL_CACHE_DIR=package_cache(),
        )
        record["exitCode"] = subprocess.run(command, env=env).returncode
    finally:
        try:
            current = root.lstat()
        except FileNotFoundError:
            current = None
        if current is not None:
            if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                raise RuntimeError(f"scratch identity changed; preserving {root}")
            if args.keep:
                write_record()
                diagnostic(f"isolated-performance: retained {root}")
            else:
                remove_scratch(root)
    return record["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
