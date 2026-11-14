"""V1–V3, with deliberate counterexamples. Run in the build container."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_checks import footprint


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def verify(first, second, changed, report):
    outcomes = []
    def digest(file):
        with file.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').digest()
    check(digest(first) == digest(second), 'V2 reproducible package differs')
    check(digest(first) != digest(changed), 'V2 epoch negative control stayed equal')
    outcomes.append({'verdict': 'V2', 'passed': True, 'negativeRejected': True})
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary) / 'root'
        subprocess.run(['dpkg-deb', '--raw-extract', str(first), str(root)], check=True)
        mode = json.loads((root / 'usr/lib/delegatus-app/runtime-manifest.json').read_text())['mode']
        footprint(root, mode)
        script = root / 'DEBIAN/postinst'
        script.write_text('#!/bin/sh\nexit 0\n')
        try:
            footprint(root, mode)
        except ValueError:
            outcomes.append({'verdict': 'V3', 'passed': True, 'negativeRejected': True})
        else:
            raise AssertionError('V3 accepts a maintainer script')
        script.unlink()
        # Run the same lintian command on the exact deliverable and its mutation.
        def lint(file):
            return subprocess.run(['lintian', '--allow-root', '--fail-on', 'error,warning', str(file)], capture_output=True, text=True)
        good = lint(first)
        check(good.returncode == 0, 'V1 lintian: ' + good.stdout + good.stderr)
        (root / 'usr/share/doc/delegatus/copyright').unlink()
        broken = Path(temporary) / 'broken.deb'
        subprocess.run(['dpkg-deb', '--root-owner-group', '--build', str(root), str(broken)], check=True, stdout=subprocess.DEVNULL)
        bad = lint(broken)
        check(bad.returncode != 0 and 'copyright' in bad.stdout, 'V1 negative control accepted')
        outcomes.append({'verdict': 'V1', 'passed': True, 'negativeRejected': True})
    report.write_text(json.dumps({'verdicts': sorted(outcomes, key=lambda x: x['verdict'])}, indent=2) + '\n')


if __name__ == '__main__':
    verify(*(Path(p).resolve() for p in sys.argv[1:5]))
