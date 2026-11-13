#!/usr/bin/python3 -I
"""Operator-run installation of the fixed read-only release observer."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile


def trusted_directory(directory):
    for parent in [directory, *directory.parents]:
        metadata = parent.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError("installation parent must be a physical root-owned directory")


def install():
    parser = argparse.ArgumentParser()
    parser.add_argument("--releases-dir", required=True)
    arguments = parser.parse_args()
    if os.geteuid() != 0 or not os.environ.get("SUDO_UID"):
        raise ValueError("run the installer through sudo")
    account = pwd.getpwuid(int(os.environ["SUDO_UID"]))
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", account.pw_name) or account.pw_uid == 0:
        raise ValueError("unsupported invoking account")
    root = Path(arguments.releases_dir)
    if not root.is_absolute() or str(root.resolve()) != str(root) or not root.is_dir():
        raise ValueError("releases-dir must name its physical directory")
    metadata = root.lstat()
    if metadata.st_uid != account.pw_uid:
        raise ValueError("releases-dir must belong to the invoking account")
    destination = Path("/usr/local/libexec")
    if not destination.exists():
        trusted_directory(destination.parent)
        destination.mkdir(mode=0o755)
    trusted_directory(destination)
    trusted_directory(Path("/etc/sudoers.d"))
    helper = destination / "delegatus-release-holders"
    configuration = Path("/etc/delegatus-release-observer.json")
    sudoers = Path("/etc/sudoers.d/delegatus-release-observer")
    # Read the reviewed bytes once. Root never executes a user-owned helper.
    source = Path(__file__).with_name("delegatus-release-holders.py").read_bytes()
    rule = f'{account.pw_name} ALL=(root) NOPASSWD: {helper} ""\n'.encode()
    pending = []
    try:
        for target, data, mode in [(helper, source, 0o755), (configuration, json.dumps({"directory": str(root), "identity": [metadata.st_dev, metadata.st_ino]}).encode(), 0o644), (sudoers, rule, 0o440)]:
            descriptor, name = tempfile.mkstemp(prefix=".delegatus-observer-", dir=target.parent)
            pending.append((name, target))
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        subprocess.run(["/usr/sbin/visudo", "-cf", pending[-1][0]], check=True)
        for name, target in pending:
            os.replace(name, target)
        print("Installed the read-only Delegatus release observer.")
    finally:
        for name, _ in pending:
            if os.path.exists(name):
                os.unlink(name)


if __name__ == "__main__":
    install()
