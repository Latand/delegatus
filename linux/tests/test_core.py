import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delegatus_app import core


class CoreChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def package(self, root):
        for name in ('bin/cli.mjs', 'dist/runtime-host.mjs', 'dist/standalone/server.js'):
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        (root / 'package.json').write_text(json.dumps({'name': 'delegatus-cli', 'version': '2.0.0'}))
        return root

    def test_language_and_environment(self):
        for env, expected in [({}, 'en'), ({'LANG': 'uk_UA.UTF-8'}, 'uk'),
                              ({'LC_ALL': 'C', 'LANG': 'uk_UA.UTF-8'}, 'uk'),
                              ({'LANGUAGE': 'en:uk', 'LANG': 'uk'}, 'en')]:
            self.assertEqual(core.language(env), expected)
        install = core.Installation(Path('/fixture/bun'), Path('/fixture/root/bin/cli.mjs'), {'LLV_STATE_DIR': '/fixture/state'})
        env = core.child_environment(self.home, {'PATH': '/usr/bin'}, install, 'uk')
        self.assertEqual(env['LLV_STATE_DIR'], '/fixture/state')
        self.assertEqual(env['LLV_LANG'], 'uk')
        self.assertTrue(env['PATH'].startswith('/fixture:'))

    def test_release_versions_and_https_redirects(self):
        self.assertLess(core.release_version('2.0.0-rc.2'), core.release_version('2.0.0-rc.10'))
        self.assertLess(core.release_version('2.0.0-rc.10'), core.release_version('2.0.0'))
        self.assertLess(core.release_version('2.0.0'), core.release_version('2.1.0'))
        with self.assertRaises(core.LauncherError):
            core.release_version('../2.0.0')
        with self.assertRaisesRegex(core.LauncherError, 'untrusted-url'):
            core.HTTPSRedirect().redirect_request(None, None, 302, '', {}, 'http://fixture.invalid/archive')
        with self.assertRaisesRegex(core.LauncherError, 'untrusted-url'):
            core.download_https('file:///fixture/archive', self.home / 'output')

    def test_private_and_global_discovery(self):
        self.assertIsNone(core.discover(self.home, {}, service_lookup=lambda: None))
        runtime = core.runtime_dir(self.home)
        root = self.package(runtime / 'packages/node_modules/delegatus-cli')
        bun = runtime / 'bun/bin/bun'
        bun.parent.mkdir(parents=True)
        bun.write_text('#!/bin/sh\n')
        bun.chmod(0o700)
        self.assertEqual(core.discover(self.home, {}, service_lookup=lambda: None).root, root)
        (root / 'dist/runtime-host.mjs').unlink()
        self.assertIsNone(core.discover(self.home, {}, service_lookup=lambda: None))

    def test_reads_real_systemd_writer(self):
        root = self.package(self.home / 'root % $ dollar')
        bun = self.home / 'bun'
        bun.touch()
        bun.chmod(0o700)
        script = '''import { renderLoginService } from './bin/login-service.mjs';
console.log(renderLoginService(JSON.parse(process.argv[1])));'''
        value = {'platform': 'linux', 'root': str(root), 'bun': str(bun), 'port': 43210,
                 'env': {'LLV_STATE_DIR': str(self.home / 'state % $$'), 'PATH': '/usr/bin'}, 'home': str(self.home)}
        text = subprocess.check_output(['bun', '-e', script, json.dumps(value)], text=True)
        file = self.home / 'unit'
        file.write_text(text)
        install = core.read_service(file, 43210)
        self.assertEqual(install.root, root)
        self.assertEqual(install.environment, value['env'])
        with self.assertRaisesRegex(core.LauncherError, 'service-port'):
            core.read_service(file, 43211)
        file.write_text(text.replace(core.SERVICE_MARKER, 'foreign'))
        with self.assertRaisesRegex(core.LauncherError, 'service-invalid'):
            core.read_service(file, 43210)

    def process(self, proc, pid, parent, args, inode=None):
        directory = proc / str(pid)
        (directory / 'fd').mkdir(parents=True)
        (directory / 'cmdline').write_bytes(b'\0'.join(os.fsencode(x) for x in args) + b'\0')
        (directory / 'stat').write_text(f'{pid} (bun worker) S {parent} ' + '0 ' * 20)
        (directory / 'comm').write_text('bun\n')
        if inode:
            (directory / 'fd/4').symlink_to(f'socket:[{inode}]')

    def test_proc_classes_and_mixed_owners(self):
        proc = self.home / 'proc'
        (proc / 'net').mkdir(parents=True)
        table = proc / 'net/tcp'
        row = f' 0: 0100007F:A8CA 00000000:0000 0A 0:0 00:0 0 {os.getuid()} 0 123 1\n'
        table.write_text('header\n' + row)
        root = self.package(self.home / 'root')
        install = core.Installation(Path('/fixture/bun'), root / 'bin/cli.mjs')
        self.process(proc, 40, 1, ['/fixture/bun', str(install.cli)])
        self.process(proc, 41, 40, ['/fixture/bun', str(root / 'dist/runtime-host.mjs')], '123')
        self.assertEqual(core.listener(43210, install, proc).kind, 'own-install')
        other = core.Installation(Path('/fixture/bun'), self.home / 'other/bin/cli.mjs')
        self.assertEqual(core.listener(43210, other, proc).kind, 'other-delegatus')
        active = self.package(self.home / 'cache/release')
        self.process(proc, 42, 40, ['/fixture/bun', str(active / 'bin/cli.mjs')])
        (proc / '41/stat').write_text('41 (bun worker) S 42 ' + '0 ' * 20)
        self.assertEqual(core.listener(43210, install, proc).kind, 'own-install')
        (proc / '41/cmdline').write_bytes(b'python3\0server.py\0')
        self.assertEqual(core.listener(43210, install, proc).kind, 'program')
        table.write_text('header\n' + row.replace(f' {os.getuid()} 0 123', f' {os.getuid()+1} 0 123'))
        self.assertEqual(core.listener(43210, install, proc).kind, 'other-user')

    def test_probe_never_sends_key_to_unverified_listener_or_redirect(self):
        requests = []
        status = [401]

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_HEAD(self):
                requests.append(self.headers.get('Authorization'))
                self.send_response(204 if self.headers.get('Authorization') else status[0])
                self.send_header('x-delegatus-diagnostics', '1')
                self.send_header('Location', 'http://127.0.0.1:1/')
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        port = server.server_port
        foreign = lambda: core.Listener('program', 10, 'python3')
        owned = lambda: core.Listener('own-install', 10, 'bun')
        self.assertEqual(core.probe(port, 'fixture-key', foreign).state, 'busy')
        self.assertEqual(requests, [None])
        self.assertEqual(core.probe(port, 'fixture-key', owned).key, 'fixture-key')
        self.assertEqual(requests[-2:], [None, 'Bearer fixture-key'])
        for code in (302, 404, 503):
            status[0] = code
            self.assertEqual(core.probe(port, 'fixture-key', owned).state, 'busy')
            self.assertIsNone(requests[-1])
        status[0] = 204
        # A marker alone cannot authorize reusing an unrelated listener.
        self.assertEqual(core.observe(port, None, None, inspect=foreign).state, 'port-busy')
        self.assertEqual(core.observe(port, None, None, inspect=owned).state, 'reused')

    def test_free_port_and_booting_wait(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.assertEqual(core.probe(port, None, lambda: None).state, 'free')
        self.assertEqual(core.decision(core.Probe('busy'), core.Listener('own-install')).state, 'starting')
        self.assertEqual(core.decision(core.Probe('busy'), core.Listener('other-delegatus', version='1.11.0')).state, 'older-delegatus')
        self.assertEqual(core.decision(core.Probe('busy'), core.Listener('other-user')).state, 'other-user')

    def test_redaction_and_translation_parity(self):
        from delegatus_app.strings import STRINGS
        self.assertEqual(set(STRINGS['en']), set(STRINGS['uk']))
        value = core.redact(f'{self.home}/file ?k=secret Authorization: Bearer secret', self.home, 'secret')
        self.assertNotIn('secret', value)
        self.assertNotIn(str(self.home), value)

    def test_server_logging_survives_closed_app_handles(self):
        output = self.home / 'server.log'
        logger = subprocess.Popen([sys.executable, '-I', 'linux/delegatus-app', '--pipe-log', str(self.home), str(output)], stdin=subprocess.PIPE)
        self.addCleanup(lambda: logger.kill() if logger.poll() is None else None)
        producer = subprocess.Popen([sys.executable, '-I', '-c', "import time; time.sleep(.1); print('alive ?k=fixture-key', flush=True)"], stdout=logger.stdin, stderr=subprocess.STDOUT)
        self.addCleanup(lambda: producer.kill() if producer.poll() is None else None)
        logger.stdin.close()
        self.assertEqual(producer.wait(timeout=5), 0)
        self.assertEqual(logger.wait(timeout=5), 0)
        self.assertIn('alive', output.read_text())
        self.assertNotIn('fixture-key', output.read_text())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
