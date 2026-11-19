import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delegatus_app import core


class InstallerChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.runtime = self.base / 'runtime'
        self.archive = self.base / 'bun.zip'
        # A real executable fixture exercises subprocess, staging and rollback.
        script = '''#!/usr/bin/python3
import json, os, pathlib, time, sys
if sys.argv[1] == '--version': print('1.4.0'); sys.exit(0)
if os.environ.get('INSTALL_HOLD'):
    pathlib.Path(os.environ['INSTALL_HOLD']).touch()
    time.sleep(120)
p = pathlib.Path('node_modules/delegatus-cli')
for f in ['bin/cli.mjs', 'dist/runtime-host.mjs', 'dist/standalone/server.js']:
    q = p / f; q.parent.mkdir(parents=True, exist_ok=True); q.touch()
(p / 'package.json').write_text(json.dumps({'name':'delegatus-cli', 'version':'2.0.0'}))
'''
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr('bun-linux-x64-baseline/bun', script)
        (self.base / 'delegatus.tgz').write_bytes(b'fixture archive checked before bun add')
        sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.manifest = {'mode': 'pr', 'platform': 'linux', 'port': 43210,
                         'bun': {'version': '1.4.0', 'x86_64': {'url': 'https://fixture.invalid/bun.zip', 'sha256': sha, 'bytes': 1}},
                         'delegatus': {'version': '2.0.0', 'tarball': 'bundle:delegatus.tgz',
                                       'integrity': 'sha512-' + base64.b64encode(hashlib.sha512((self.base / 'delegatus.tgz').read_bytes()).digest()).decode(),
                                       'gitHead': 'a' * 40, 'bytes': 1}}
        self.file = self.base / 'runtime-manifest.json'

    def install(self):
        self.file.write_text(json.dumps(self.manifest))
        core.install_runtime(self.runtime, self.file, architecture='x86_64',
                             download=lambda _url, dest: dest.write_bytes(self.archive.read_bytes()))

    def assert_unpublished(self):
        self.assertFalse((self.runtime / 'packages').exists())
        self.assertFalse((self.runtime / 'bun').exists())
        self.assertEqual(list(self.runtime.glob('.stage.*')), [])

    def test_publish_and_never_replace_existing_root(self):
        self.install()
        root = self.runtime / 'packages/node_modules/delegatus-cli'
        inode = root.stat().st_ino
        (root / 'package.json').write_text(json.dumps({'name': 'delegatus-cli', 'version': '3.0.0'}))
        self.install()
        self.assertEqual(root.stat().st_ino, inode)
        self.assertEqual(json.loads((root / 'package.json').read_text())['version'], '3.0.0')

    def test_bad_bun_and_package_integrity(self):
        for target in ('bun', 'delegatus'):
            with self.subTest(target=target):
                original = json.loads(json.dumps(self.manifest))
                if target == 'bun': self.manifest['bun']['x86_64']['sha256'] = '0' * 64
                else: self.manifest['delegatus']['integrity'] = 'sha512-' + base64.b64encode(bytes(64)).decode()
                with self.assertRaisesRegex(core.LauncherError, 'checksum'):
                    self.install()
                self.assert_unpublished()
                self.manifest = original

    def test_release_refuses_bundle(self):
        self.manifest['mode'] = 'release'
        with self.assertRaisesRegex(core.LauncherError, 'bundle'):
            self.install()
        self.assertFalse((self.runtime / 'packages').exists())

    def test_incomplete_existing_packages_are_preserved(self):
        (self.runtime / 'packages').mkdir(parents=True)
        marker = self.runtime / 'packages/keep'
        marker.touch()
        with self.assertRaisesRegex(core.LauncherError, 'incomplete'):
            self.install()
        self.assertTrue(marker.exists())
        self.assertFalse((self.runtime / 'bun').exists())

    def test_held_lock_refuses_second_real_process_and_recovers(self):
        import fcntl
        self.runtime.mkdir()
        self.file.write_text(json.dumps(self.manifest))
        with (self.runtime / '.install-lock-v2').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run([sys.executable, '-I', 'linux/delegatus-app', '--install', str(self.runtime), str(self.file)], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('install-locked', result.stderr)
            self.assert_unpublished()
        self.install()
        self.assertTrue((self.runtime / 'packages').exists())

    def test_sigterm_during_add_rolls_back_previous_bun(self):
        self.file.write_text(json.dumps(self.manifest))
        previous = self.runtime / 'bun/bin/bun'
        previous.parent.mkdir(parents=True)
        previous.write_text('#!/bin/sh\necho 1.3.3\n')
        previous.chmod(0o700)
        code = '''import sys
from pathlib import Path
sys.path.insert(0, 'linux')
from delegatus_app.core import install_runtime
install_runtime(Path(sys.argv[1]), Path(sys.argv[2]), architecture='x86_64', download=lambda u,d: d.write_bytes(Path(sys.argv[3]).read_bytes()))
'''
        marker = self.base / 'held'
        child = subprocess.Popen([sys.executable, '-I', '-c', code, str(self.runtime), str(self.file), str(self.archive)], env={**os.environ, 'INSTALL_HOLD': str(marker)}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        def cleanup():
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            child.stderr.close()
        self.addCleanup(cleanup)
        deadline = time.monotonic() + 10
        while not marker.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(marker.exists())
        child.send_signal(signal.SIGTERM)
        self.assertNotEqual(child.wait(timeout=10), 0)
        self.assertEqual(previous.read_text(), '#!/bin/sh\necho 1.3.3\n')
        self.assertFalse((self.runtime / 'packages').exists())
        self.assertEqual(list(self.runtime.glob('.stage.*')), [])
        self.install()


if __name__ == '__main__':
    unittest.main()
