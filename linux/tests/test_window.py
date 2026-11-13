from pathlib import Path
import tempfile
import threading
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


if __name__ == '__main__':
    unittest.main()
