"""Run a check with private homes, provider roots, state and temporary paths.

Scratch is removed after success or failure. Pass --keep to retain it for
inspection. --root or the caller's TMPDIR overrides the persistent Unix default.
Only Bun's package cache is shared; operator state and provider homes stay private.
"""
import argparse
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


def remove_scratch(root, original):
    if os.name != "posix":
        shutil.rmtree(root)
        return

    def same_directory(expected, current):
        return (stat.S_ISDIR(current.st_mode)
                and (current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino))

    def remove_at(name, parent_fd, expected):
        path_handle = hasattr(os, "O_PATH") and os.path.isdir("/proc/self/fd")
        flags = os.O_PATH if path_handle else os.O_RDONLY
        descriptor = os.open(name, flags | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=parent_fd)
        try:
            current = os.fstat(descriptor)
            if not same_directory(expected, current):
                raise RuntimeError("scratch directory changed; preserving replacement")
            # All traversal and permission changes use the verified descriptor.
            # Renaming a path cannot redirect them to another directory.
            if path_handle:
                # Linux O_PATH can open owned mode-000 directories. The proc
                # handle stays bound to that verified inode across renames.
                handle_path = f"/proc/self/fd/{descriptor}"
                os.chmod(handle_path, current.st_mode | stat.S_IRWXU)
                readable = os.open(handle_path, os.O_RDONLY | os.O_DIRECTORY)
                os.close(descriptor)
                descriptor = readable
            else:
                os.fchmod(descriptor, current.st_mode | stat.S_IRWXU)
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    child = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(child.st_mode):
                        remove_at(entry.name, descriptor, child)
                    else:
                        os.unlink(entry.name, dir_fd=descriptor)
            linked = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not same_directory(current, linked):
                raise RuntimeError("scratch directory changed; preserving replacement")
            os.rmdir(name, dir_fd=parent_fd)
        finally:
            os.close(descriptor)

    parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        remove_at(root.name, parent_fd, original)
    finally:
        os.close(parent_fd)


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
    root = pathlib.Path(tempfile.mkdtemp(prefix="lvpf-", dir=parent))
    original = root.stat()
    exit_code = None

    try:
        diagnostic(f"isolated-performance: scratch {root}")
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
        exit_code = subprocess.run(command, env=env).returncode
    finally:
        try:
            current = root.lstat()
        except FileNotFoundError:
            current = None
        if current is not None:
            if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                raise RuntimeError(f"scratch identity changed; preserving {root}")
            if args.keep:
                diagnostic(f"isolated-performance: retained {root}")
            else:
                remove_scratch(root, original)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
