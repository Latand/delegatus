from pathlib import Path
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import types

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The tests drive production callbacks without starting a display. The app's
# methods used here require only the Gtk.Application base type at import time.
gi = types.ModuleType('gi')
gi.require_version = lambda *_args: None
repository = types.ModuleType('gi.repository')
repository.Gtk = SimpleNamespace(Application=type('GtkApplication', (), {}))
repository.Gdk = SimpleNamespace()
repository.Gio = SimpleNamespace()
repository.GLib = SimpleNamespace()
repository.WebKit2 = SimpleNamespace()
gi.repository = repository
sys.modules['gi'] = gi
sys.modules['gi.repository'] = repository

from delegatus_app.window import Application
from delegatus_app import core


class CheckItemProbe:
    """Gtk.CheckMenuItem toggles before emitting activate."""
    def __init__(self, active=True):
        self.active = active
        self.callback = None

    def connect(self, signal, callback):
        if signal == 'activate':
            self.callback = callback

    def activate(self):
        self.active = not self.active
        self.callback(self)

    def set_active(self, active):
        self.active = active


class LoginMenuChecks(unittest.TestCase):
    def app(self, item, service, approve):
        app = Application.__new__(Application)
        app.busy = False
        app.port = 8898
        app.installation = SimpleNamespace(service=service)
        app.login_item = item
        app.copy = {'remove-question': 'Remove?', 'login': 'Start at Login', 'failure-detail': 'Failed'}
        app.ask = lambda *_args: approve
        app.update_menu = lambda: None
        app.later = lambda callback, *args: callback(*args)
        return app

    def test_cancel_restores_checked_state_after_activate_toggled_it_off(self):
        item = CheckItemProbe(active=True)
        app = self.app(item, Path('delegatus.service'), False)
        app.worker = lambda _work: self.fail('cancelling must not schedule a service command')
        item.connect('activate', lambda _item: Application.login(app))

        item.activate()

        self.assertTrue(item.active)
        self.assertIsNotNone(app.installation.service)

    def test_command_failure_resynchronizes_checked_state_from_service(self):
        item = CheckItemProbe(active=True)
        app = self.app(item, Path('delegatus.service'), True)
        app.log = lambda _line: None
        app.home = Path(tempfile.gettempdir())
        app.key = None
        app.closing = False
        app.show_state = lambda *_args: None
        finished = threading.Event()
        app.finished = finished.set
        with tempfile.TemporaryDirectory() as directory:
            app.log_file = Path(directory) / 'app.log'
            app.log_file.write_text('')
            app.cli = lambda _args: (_ for _ in ()).throw(RuntimeError('service-remove-failed'))
            app.start_work = lambda: self.fail('failed removal must not restart Delegatus')
            app.worker = Application.worker.__get__(app)
            with patch('delegatus_app.window.subprocess.run', return_value=SimpleNamespace(stdout='')):
                with patch('delegatus_app.window.core.discover', return_value=SimpleNamespace(service=None)):
                    item.connect('activate', lambda _item: Application.login(app))
                    item.activate()
                    self.assertTrue(finished.wait(3))

        self.assertFalse(item.active)
        self.assertIsNone(app.installation.service)


class ListenerReuseChecks(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        bun = shutil.which('bun')
        self.assertIsNotNone(bun, 'Bun is required for the real listener regression')
        runtime = core.runtime_dir(self.home)
        self.private = self.installation(runtime / 'bun/bin/bun', runtime / 'packages/node_modules/delegatus-cli', bun)
        self.global_install = self.installation(self.home / '.bun/bin/bun', self.home / '.bun/install/global/node_modules/delegatus-cli', bun)
        self.assertNotEqual(self.private.bun.resolve(), self.global_install.bun.resolve())

    def installation(self, binary, root, source):
        binary.parent.mkdir(parents=True)
        os.link(Path(source).resolve(), binary)
        for name in core.REQUIRED:
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        (root / 'package.json').write_text(json.dumps({'name': 'delegatus-cli', 'version': '2.0.0'}))
        return core.Installation(binary, root / 'bin/cli.mjs')

    def start_listener(self, keyed, foreign=False):
        root = self.global_install.root
        (root / 'dist/runtime-host.mjs').write_text('''import http from 'node:http';
import fs from 'node:fs';
const server = http.createServer((request, response) => {
  if (request.headers.authorization) fs.appendFileSync(process.env.CREDENTIALS, request.headers.authorization + '\\n');
  const ready = process.env.KEYED !== '1' || request.headers.authorization === 'Bearer fixture-key';
  response.writeHead(ready ? 204 : 401, {'x-delegatus-diagnostics': '1'});
  response.end();
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.MARKER, String(server.address().port)));
''')
        if foreign:
            (root / 'dist/runtime-host.mjs').write_text('''import http.server, os
class Handler(http.server.BaseHTTPRequestHandler):
 def do_HEAD(self):
  value = self.headers.get('Authorization')
  if value:
   with open(os.environ['CREDENTIALS'], 'a') as stream: stream.write(value + "\\n")
  self.send_response(401 if os.environ['KEYED'] == '1' else 204)
  self.send_header('x-delegatus-diagnostics', '1')
  self.end_headers()
 def log_message(self, *_args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
with open(os.environ['MARKER'], 'w') as stream: stream.write(str(server.server_port))
server.serve_forever()
''')
        command = "['python3', ['-I', script]]" if foreign else '[process.execPath, [script]]'
        self.global_install.cli.write_text('''import { spawn } from 'node:child_process';
const script = new URL('../dist/runtime-host.mjs', import.meta.url).pathname;
const [executable, args] = ''' + command + ''';
const child = spawn(executable, args, {stdio: 'inherit'});
child.on('exit', code => process.exit(code ?? 1));
''')
        marker = self.home / 'port'
        self.credentials = self.home / 'credentials'
        child = subprocess.Popen([str(self.global_install.bun), str(self.global_install.cli)],
                                 env={**os.environ, 'HOME': str(self.home), 'MARKER': str(marker),
                                      'CREDENTIALS': str(self.credentials), 'KEYED': '1' if keyed else '0'},
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        def stop():
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        self.addCleanup(stop)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and child.poll() is None:
            if marker.exists() and marker.read_text():
                return int(marker.read_text())
            time.sleep(.02)
        self.fail('the ephemeral listener did not start')

    def launch(self, port):
        app = Application.__new__(Application)
        app.home, app.port, app.lang = self.home, port, 'en'
        app.closing, app.server = False, None
        app.login_item = CheckItemProbe()
        app.later = lambda callback, *args: callback(*args)
        app.log = lambda _line: None
        results = []
        app.show_result = results.append
        # Run real discovery, inspection and the start decision, with no display.
        # Any attempt to start a second CLI, logger or service fails the test.
        discover = core.discover
        with patch('delegatus_app.window.core.discover', wraps=lambda home, env, port: discover(home, env, port, service_lookup=lambda: None)):
            with patch.dict(os.environ, {'LLV_TOKEN': 'fixture-key', 'DELEGATUS_TOKEN': 'fixture-key'}):
                with patch('delegatus_app.window.subprocess.Popen', side_effect=AssertionError('second launch')):
                    app.start_work()
        self.assertEqual(app.installation.root, self.private.root)
        self.assertIsNone(app.server)
        self.assertEqual(len(results), 1)
        return results[0]

    def check_healthy_reuse(self, keyed):
        port = self.start_listener(keyed=keyed)
        result = self.launch(port)
        self.assertEqual((result.state, result.owner.kind), ('reused', 'other-delegatus'))
        self.assertEqual(result.key, 'fixture-key' if keyed else None)
        if keyed:
            self.assertEqual(self.credentials.read_text(), 'Bearer fixture-key\n')
        else:
            self.assertFalse(self.credentials.exists())
        # The same real server is own-install against its own root and also
        # reusable when no local install was discovered.
        self.assertEqual(core.observe(port, self.global_install, None).owner.kind, 'own-install')
        self.assertEqual(core.observe(port, None, 'fixture-key').state, 'reused')

    def test_healthy_global_listener_is_reused_with_private_install(self):
        self.check_healthy_reuse(keyed=False)

    def test_keyed_global_listener_is_reused_with_private_install(self):
        self.check_healthy_reuse(keyed=True)

    def check_foreign_refusal(self, keyed):
        port = self.start_listener(keyed=keyed, foreign=True)
        result = self.launch(port)
        self.assertEqual((result.state, result.owner.kind), ('port-busy', 'program'))
        self.assertIsNone(result.key)
        self.assertFalse(self.credentials.exists())

    def test_foreign_listener_keeps_plain_busy_result_and_never_receives_key(self):
        self.check_foreign_refusal(keyed=False)

    def test_foreign_auth_challenge_never_receives_key(self):
        self.check_foreign_refusal(keyed=True)


if __name__ == '__main__':
    unittest.main()
