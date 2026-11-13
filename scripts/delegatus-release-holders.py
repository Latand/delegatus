#!/usr/bin/python3 -IB
"""Fixed procfs observer. No subprocesses, writes, signals or code from stdin."""
import json
import os
import re
import stat
import sys
import time

CONFIG = "/etc/delegatus-release-observer.json"
LIMIT = 2 * 1024 * 1024


def read(file):
    with open(file, "rb") as stream:
        value = stream.read(LIMIT + 1)
    if len(value) > LIMIT:
        raise ValueError("observation-bound")
    return value.decode("utf-8", errors="surrogateescape")


def inside(file, root):
    return file == root or file.startswith("/" if root == "/" else root + "/")


def fields(value):
    return value[value.rindex(")") + 2:].split()


def mounts(file):
    rows = []
    for line in read(file).splitlines():
        parts = line.split(" ")
        if len(parts) < 6 or not parts[4].startswith("/"):
            raise ValueError("mount-inventory")
        decode = lambda value: re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)
        rows.append((parts[2], decode(parts[3]), decode(parts[4])))
    return sorted(rows, key=lambda row: len(row[2]), reverse=True)


def scan(root, proc="/proc", seconds=15):
    deadline = time.monotonic() + seconds
    namespace = os.readlink(proc + "/self/ns/mnt")
    processes, uncertain = [], []
    own_mounts = None
    names = sorted(name for name in os.listdir(proc) if name.isdigit())
    if len(names) > 65536:
        raise ValueError("process-bound")
    for name in names:
        base = proc + "/" + name
        paths, references = [], []
        operation = "stat"
        other_namespace = namespace
        try:
            if time.monotonic() >= deadline:
                raise ValueError("observation-deadline")
            before = fields(read(base + "/stat"))
            if before[0] in ("Z", "X", "x"):
                continue
            kernel = int(before[6]) & 0x200000
            operation = "namespace"
            other_namespace = os.readlink(base + "/ns/mnt")
            for file in ("cwd", "exe", "root"):
                operation = file
                try:
                    paths.append(os.readlink(base + "/" + file))
                except FileNotFoundError:
                    if not (kernel and file == "exe"):
                        raise
            operation = "fd"
            descriptors = os.listdir(base + "/fd")
            if len(descriptors) > 65536:
                raise ValueError("descriptor-bound")
            for descriptor in descriptors:
                try:
                    paths.append(os.readlink(base + "/fd/" + descriptor))
                except FileNotFoundError:
                    pass  # A descriptor closed during the observation.
            operation = "cmdline"
            references.extend(read(base + "/cmdline").split("\0"))
            operation = "maps"
            for line in read(base + "/maps").splitlines():
                match = re.match(r"\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(/.*)$", line)
                if match:
                    paths.append(match[1])
            operation = "environ"
            try:
                environment = read(base + "/environ")
            except ProcessLookupError:
                if not kernel:
                    raise
                environment = ""
            references.extend(pair.split("=", 1)[1] for pair in environment.split("\0") if "=" in pair)
            paths.extend(value for value in references if value.startswith("/"))
            if other_namespace != namespace:
                operation = "mountinfo"
                if own_mounts is None:
                    own_mounts = mounts(proc + "/self/mountinfo")
                remote_mounts = mounts(base + "/mountinfo")
                for entry in list(paths):
                    if not entry.startswith("/"):
                        continue
                    target = re.sub(r" \(deleted\)$", "", entry)
                    visible = next((row for row in remote_mounts if inside(target, row[2])), None)
                    if visible is None:
                        raise ValueError("mount-origin")
                    for device, source, point in remote_mounts:
                        if point != visible[2] or not source.startswith("/"):
                            continue
                        origin = os.path.normpath(source + "/" + os.path.relpath(target, point))
                        for host_device, host_source, host_point in own_mounts:
                            if host_device == device and inside(origin, host_source):
                                paths.append(os.path.normpath(host_point + "/" + os.path.relpath(origin, host_source)))
            operation = "identity"
            after = fields(read(base + "/stat"))
            if before[19] != after[19]:
                raise ValueError("identity-changed")
            if after[0] in ("Z", "X", "x"):
                continue
        except (OSError, ValueError, IndexError):
            if not os.path.exists(base):
                continue
            try:
                if fields(read(base + "/stat"))[0] in ("Z", "X", "x"):
                    continue
            except (OSError, ValueError, IndexError):
                if not os.path.exists(base):
                    continue
            uncertain.append({"pid": int(name), "reason": operation + ":unavailable", "roots": [root]})
        held = []
        for entry in paths:
            if not entry.startswith("/"):
                continue
            target = re.sub(r" \(deleted\)$", "", entry)
            physical = os.path.realpath(target)
            if inside(target, root):
                held.append(target)
            elif inside(physical, root):
                held.append(physical)
        # Return only release paths. Embedded argv/env paths (including PATH
        # lists and --option=/release/...) carry the same hold as an absolute
        # path; publishing only the installation root would lose that hold.
        scoped_references = []
        for value in references:
            for match in re.finditer(re.escape(root) + r"(?:/([^/\s\x00\"':;]+))?", value):
                scoped_references.append(root + ("/" + match[1] if match[1] else ""))
        if held or scoped_references:
            processes.append({"pid": int(name), "namespace": other_namespace, "paths": sorted(set(held)),
                              "references": sorted(set(scoped_references)), "stamped": False})
    result = {"ownNamespace": namespace, "complete": True, "processes": processes, "uncertain": uncertain}
    if len(json.dumps(result)) > 1024 * 1024:
        raise ValueError("reply-bound")
    return result


def configuration(file=CONFIG):
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        metadata = os.fstat(stream.fileno())
        if metadata.st_uid != 0 or not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022:
            raise ValueError("untrusted-configuration")
        value = json.loads(stream.read(4097))
    root = value["directory"]
    metadata = os.lstat(root)
    if not stat.S_ISDIR(metadata.st_mode) or os.path.realpath(root) != root or [metadata.st_dev, metadata.st_ino] != value["identity"]:
        raise ValueError("release-root-changed")
    return root


def main():
    if len(sys.argv) != 1:
        raise ValueError("observer-accepts-no-arguments")
    request = sys.stdin.buffer.read(4097)
    if len(request) > 4096:
        raise ValueError("request-bound")
    request = json.loads(request)
    root = configuration()
    if request != {"directory": root}:
        raise ValueError("unconfigured-release-root")
    print(json.dumps(scan(root), ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print("release observer unavailable", file=sys.stderr)
        sys.exit(1)
