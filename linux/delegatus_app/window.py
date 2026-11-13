"""GTK work stays on the main thread; installation and process I/O use workers."""
import argparse
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import threading
import time
import urllib.parse
import urllib.request

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2

from . import core
from .strings import STRINGS

APP_ID = 'org.delegatus.Delegatus'


class Application(Gtk.Application):
    def __init__(self, entry, accept, port):
        # Distinct ports belong to distinct instances in isolated smoke sessions.
        super().__init__(application_id=APP_ID)
        self.entry, self.port = entry, port
        self.home = Path.home()
        self.copy = STRINGS[core.language(os.environ)]
        self.lang = core.language(os.environ)
        self.manifest_file = entry.parent / 'runtime-manifest.json'
        self.manifest = core.load_manifest(self.manifest_file)
        self.metadata = json.loads((entry.parent / 'app.json').read_text())
        self.accept, self.installation = accept, None
        self.busy, self.closing, self.installer = False, False, None
        self.cancel_install = threading.Event()
        self.server, self.failures = None, 0
        self.log_dir = self.home / '.local/state/delegatus/logs'
        self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log_file = self.log_dir / f'app-{time.time_ns()}-{os.getpid()}.log'
        fd = os.open(self.log_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND, 0o600)
        self.log_handle = os.fdopen(fd, 'w', buffering=1)
        self.log_file.chmod(0o600)
        for file in sorted(self.log_dir.glob('app-*.log'), reverse=True)[10:]:
            file.unlink(missing_ok=True)
        self.window = None
        self.state = 'starting'
        self.key = None
        self.set_accels_for_action('app.quit', ['<Primary>q'])
        action = Gio.SimpleAction.new('quit', None)
        action.connect('activate', lambda *_: self.close())
        self.add_action(action)

    @property
    def origin(self):
        return f'http://127.0.0.1:{self.port}'

    def log(self, value):
        self.log_handle.write(core.redact(value, self.home, self.key or core.access_key(self.home, os.environ)) + '\n')

    def later(self, callback, *args):
        def call():
            callback(*args)
            return False
        GLib.idle_add(call)

    def worker(self, callback):
        if self.busy:
            return
        self.busy = True
        self.update_menu()

        def run():
            try:
                callback()
            except Exception as error:
                self.log(f'ERROR {error}')
                code = str(error)
                if self.installation and self.installation.service:
                    try:
                        journal = subprocess.run(['journalctl', '--user', '-u', 'delegatus.service', '-n', '60', '-o', 'cat'], capture_output=True, text=True, timeout=5)
                        self.log(journal.stdout[-12000:])
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                with self.log_file.open('rb') as stream:
                    stream.seek(max(0, self.log_file.stat().st_size - 900))
                    tail = core.redact(stream.read().decode('utf-8', 'replace'), self.home, self.key)
                detail = self.copy.get(code, self.copy['failure-detail'])
                if code not in self.copy:
                    detail += '\n\n' + tail
                self.later(self.show_state, 'failed', detail)
                self.later(self.sync_login_item)
            finally:
                self.later(self.finished)
        threading.Thread(target=run, daemon=True).start()

    def finished(self):
        self.busy = False
        self.update_menu()
        if self.closing:
            self.quit()

    def update_menu(self):
        for key in ('start', 'stop', 'login', 'updates'):
            self.menu_items[key].set_sensitive(not self.busy and (self.installation is not None or key in ('start', 'updates')))

    def sync_login_item(self):
        self.login_item.set_active(bool(self.installation and self.installation.service))

    def do_activate(self):
        if self.window:
            self.window.present()
            return
        self.window = Gtk.ApplicationWindow(application=self, title='Delegatus')
        self.window.set_default_size(1100, 780)
        self.window.set_size_request(680, 500)
        self.window.set_icon_name(APP_ID)
        self.window.set_wmclass(APP_ID, APP_ID)
        self.window.connect('delete-event', lambda *_: self.close())
        header = Gtk.HeaderBar(title='Delegatus', show_close_button=True)
        self.window.set_titlebar(header)
        for label, callback in [('back', lambda: self.web.go_back()), ('forward', lambda: self.web.go_forward()), ('reload', lambda: self.web.reload())]:
            button = Gtk.Button(label=self.copy[label])
            button.connect('clicked', lambda _button, fn=callback: fn())
            header.pack_start(button)
        menu_button = Gtk.MenuButton(label=self.copy['menu'])
        menu = Gtk.Menu()
        self.menu_items = {}
        for key, callback in [('updates', self.updates), ('login', self.login), ('start', self.start), ('stop', self.stop),
                              ('logs', self.open_logs), ('browser', self.open_browser), ('about', self.about), ('quit', self.close)]:
            item = Gtk.CheckMenuItem(label=self.copy[key]) if key == 'login' else Gtk.MenuItem(label=self.copy[key])
            item.connect('activate', lambda _item, fn=callback: fn())
            self.menu_items[key] = item
            if key == 'login':
                self.login_item = item
            menu.append(item)
        menu.show_all()
        menu_button.set_popup(menu)
        header.pack_end(menu_button)
        self.stack = Gtk.Stack()
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, margin=36, valign=Gtk.Align.CENTER)
        box.pack_start(Gtk.Image.new_from_icon_name(APP_ID, Gtk.IconSize.DIALOG), False, False, 0)
        self.title = Gtk.Label()
        self.title.get_style_context().add_class('title')
        box.pack_start(self.title, False, False, 0)
        self.detail = Gtk.Label(wrap=True, max_width_chars=75, selectable=True)
        box.pack_start(self.detail, False, False, 0)
        self.buttons = Gtk.Box(spacing=12, halign=Gtk.Align.CENTER)
        box.pack_start(self.buttons, False, False, 0)
        self.stack.add_named(box, 'status')
        data, cache = self.home / '.local/share/delegatus/webview', self.home / '.cache/delegatus/webview'
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        manager = WebKit2.WebsiteDataManager(base_data_directory=str(data), base_cache_directory=str(cache))
        context = WebKit2.WebContext.new_with_website_data_manager(manager)
        context.set_preferred_languages([self.lang])
        context.get_cookie_manager().set_persistent_storage(str(data / 'cookies.sqlite'), WebKit2.CookiePersistentStorage.SQLITE)
        self.web = WebKit2.WebView.new_with_context(context)
        self.web.get_settings().set_property('enable-media-stream', True)
        self.connect_view(self.web)
        self.stack.add_named(self.web, 'web')
        self.window.add(self.stack)
        self.window.show_all()
        if os.getuid() == 0:
            self.show_state('failed', self.copy['root'])
        elif platform.machine() not in ('x86_64', 'aarch64'):
            self.show_state('unsupported', self.copy['unsupported-detail'])
        else:
            self.start()
        GLib.timeout_add_seconds(15, self.monitor)

    def connect_view(self, view):
        view.connect('decide-policy', self.navigate)
        view.connect('create', self.popup)
        view.connect('permission-request', self.permission)
        view.connect('load-changed', self.loaded)
        view.connect('load-failed', lambda _v, _event, _uri, error: self.load_failed(error))

    def load_failed(self, error):
        self.log(f'WEB failed {error.code}')
        self.show_state('failed', self.copy['failure-detail'])
        return False

    def local_uri(self, uri):
        parsed = urllib.parse.urlsplit(uri or '')
        return (parsed.scheme, parsed.netloc) == ('http', f'127.0.0.1:{self.port}')

    def external(self, uri):
        if urllib.parse.urlsplit(uri).scheme in ('http', 'https'):
            Gio.AppInfo.launch_default_for_uri(uri, None)

    def navigate(self, _view, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            if not self.local_uri(uri):
                decision.ignore()
                self.external(uri)
                return True
        return False

    def popup(self, view, action):
        uri = action.get_request().get_uri()
        if not self.local_uri(uri):
            self.external(uri)
            return None
        child = WebKit2.WebView(related_view=view)
        self.connect_view(child)
        window = Gtk.ApplicationWindow(application=self, title='Delegatus')
        window.set_default_size(900, 700)
        window.add(child)
        window.show_all()
        return child

    def permission(self, view, request):
        if isinstance(request, WebKit2.UserMediaPermissionRequest) and self.local_uri(view.get_uri()):
            request.allow()
        else:
            request.deny()
        return True

    def loaded(self, view, event):
        if event == WebKit2.LoadEvent.FINISHED and self.local_uri(view.get_uri()):
            resource = view.get_main_resource()
            response = resource.get_response() if resource else None
            status = response.get_status_code() if response else 0
            # Inspect the rendered document's language in the real web process.
            def evaluated(web, result, _data):
                try:
                    lang = web.evaluate_javascript_finish(result).to_string()
                    self.log(f'WEB loaded status={status} language={lang}')
                except GLib.Error:
                    self.log('WEB language unavailable')
            view.evaluate_javascript('navigator.language', -1, None, None, None, evaluated, None)

    def show_state(self, state, detail=''):
        self.state = state
        self.log(f'STATE {state} {detail}')
        self.stack.set_visible_child_name('status')
        self.title.set_text(self.copy[state])
        self.detail.set_text(detail)
        for button in self.buttons.get_children():
            self.buttons.remove(button)
        choices = [('retry', self.start), ('logs', self.open_logs)]
        if state == 'needs-install':
            choices = [('install', self.install), ('quit', self.close)]
        elif state == 'installing':
            choices = [('cancel', self.cancel), ('logs', self.open_logs)]
        elif state == 'starting':
            choices = [('logs', self.open_logs)]
        elif state == 'stopped':
            choices = [('start', self.start), ('logs', self.open_logs)]
        elif state == 'older-delegatus':
            choices.insert(0, ('browser', self.open_browser))
        for key, callback in choices:
            button = Gtk.Button(label=self.copy[key])
            button.connect('clicked', lambda _b, fn=callback: fn())
            self.buttons.pack_start(button, False, False, 0)
        self.buttons.show_all()

    def inspect(self):
        env = core.child_environment(self.home, os.environ, self.installation, self.lang)
        self.key = core.access_key(self.home, env)
        result = core.observe(self.port, self.installation, self.key)
        self.log(f'PROBE {result.state} {result.detail}')
        if result.owner:
            self.log(f'LISTENER {result.owner.kind} {result.owner.name} pid={result.owner.pid} {result.owner.version}')
        return result

    def show_result(self, result, state=None):
        if result.state == 'reused':
            self.state = state or 'reused'
            self.log(f'STATE {self.state}')
            self.stack.set_visible_child_name('web')
            key = result.key
            self.web.load_uri(self.origin + '/' + ('?k=' + urllib.parse.quote(key, safe='') if key else ''))
            return
        owner = result.owner or core.Listener('other-user')
        key = {'port-busy': 'busy-detail', 'other-user': 'other-detail', 'older-delegatus': 'older-detail'}.get(result.state, 'failure-detail')
        self.show_state(result.state, self.copy[key].format(port=self.port, name=owner.name, pid=owner.pid, version=owner.version))

    def start(self):
        if not self.busy:
            self.show_state('starting')
            self.worker(self.start_work)

    def start_work(self):
        if self.closing:
            return
        self.installation = core.discover(self.home, os.environ, self.port)
        self.later(self.login_item.set_active, bool(self.installation and self.installation.service))
        result = self.inspect()
        if result.state == 'free' and not self.installation:
            archive = self.manifest['bun']['arm64' if platform.machine() == 'aarch64' else 'x86_64']
            detail = self.copy['install-question'].format(bun=self.manifest['bun']['version'], app=self.manifest['delegatus']['version'], mb=(archive['bytes'] + self.manifest['delegatus']['bytes'] + 999999) // 1000000)
            self.later(self.show_state, 'needs-install', detail)
            if self.accept:
                self.accept = False
                self.perform_install()
                return self.start_work()
            return
        if result.state == 'free':
            env = core.child_environment(self.home, os.environ, self.installation, self.lang)
            if self.installation.bun == core.runtime_dir(self.home) / 'bun/bin/bun':
                current = subprocess.check_output([str(self.installation.bun), '--version'], text=True, timeout=10).strip()
                if core.version(current) < core.version(self.manifest['bun']['version']):
                    self.perform_install()
            # Recheck the port after discovery, a download or a command awaited.
            result = self.inspect()
            if result.state == 'free':
                if self.installation.service:
                    self.command(['systemctl', '--user', 'start', 'delegatus.service'], env, 15)
                else:
                    logger = subprocess.Popen(['/usr/bin/python3', '-I', str(self.entry), '--pipe-log', str(self.home), str(self.log_file)], env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                    try:
                        self.server = subprocess.Popen([str(self.installation.bun), str(self.installation.cli), '--no-open', '--port', str(self.port)], env=env, stdout=logger.stdin, stderr=subprocess.STDOUT, start_new_session=True)
                    finally:
                        # Only the CLI retains a writer. The logger ends at its EOF.
                        logger.stdin.close()
                result = core.Probe('starting')
        if result.state == 'starting':
            self.later(self.show_state, 'starting')
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline and not self.closing:
                result = self.inspect()
                if result.state == 'reused' and result.owner.kind == 'own-install':
                    self.later(self.show_result, result, 'ready')
                    return
                if result.state not in ('starting', 'free'):
                    self.later(self.show_result, result)
                    return
                if self.server and self.server.poll() is not None:
                    deadline = min(deadline, time.monotonic() + 30)
                    self.log(f'LAUNCHER exit={self.server.returncode}')
                    self.server = None
                time.sleep(.5)
            raise core.LauncherError('start-timeout')
        self.later(self.show_result, result)

    def read_output(self, child, setup=False):
        for line in iter(lambda: child.stdout.readline(8192), b''):
            text = line.decode('utf-8', 'replace').rstrip()
            self.log(text)
            if setup and text.startswith('SETUP '):
                step = text[6:7]
                self.later(self.show_state, 'installing', self.copy.get('step-' + step, ''))
        child.stdout.close()

    def perform_install(self):
        self.cancel_install.clear()
        self.later(self.show_state, 'installing', self.copy['step-1'])
        self.installer = subprocess.Popen(['/usr/bin/python3', '-I', str(self.entry), '--install', str(core.runtime_dir(self.home)), str(self.manifest_file)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        if self.cancel_install.is_set():
            self.installer.terminate()
        self.read_output(self.installer, True)
        status = self.installer.wait()
        self.installer = None
        if status:
            raise core.LauncherError('install-command-failed')

    def install(self):
        def work():
            self.perform_install()
            self.start_work()
        self.worker(work)

    def cancel(self):
        self.cancel_install.set()
        if self.installer and self.installer.poll() is None:
            # The installer owns and cleans its Bun subprocess group.
            self.installer.terminate()

    def command(self, args, env=None, timeout=125):
        child = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        reader = threading.Thread(target=self.read_output, args=(child,), daemon=True)
        reader.start()
        try:
            if child.wait(timeout=timeout):
                raise core.LauncherError('command-failed')
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise core.LauncherError('command-timeout') from None
        finally:
            reader.join(timeout=2)

    def cli(self, arguments):
        if not self.installation:
            raise core.LauncherError('no-installation')
        env = core.child_environment(self.home, os.environ, self.installation, self.lang)
        self.command([str(self.installation.bun), str(self.installation.cli), *arguments], env)

    def ask(self, title, affirmative):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.QUESTION, text=title)
        dialog.add_button(self.copy['cancel'], Gtk.ResponseType.CANCEL)
        dialog.add_button(affirmative, Gtk.ResponseType.OK)
        answer = dialog.run() == Gtk.ResponseType.OK
        dialog.destroy()
        return answer

    def stop(self):
        if self.busy or not self.ask(self.copy['stop-question'], self.copy['stop']):
            return
        def work():
            self.cli(['stop', '--all'])
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if self.inspect().state == 'free':
                    self.later(self.show_state, 'stopped')
                    return
                time.sleep(.5)
            raise core.LauncherError('stop-timeout')
        self.worker(work)

    def login(self):
        if self.busy or not self.installation:
            return
        remove = self.installation.service is not None
        if remove and not self.ask(self.copy['remove-question'], self.copy['login']):
            self.login_item.set_active(True)
            return
        def work():
            try:
                self.cli(['service', 'remove'] if remove else ['service', 'install', '--port', str(self.port)])
            except Exception:
                # The command may have changed the unit before it reported an
                # error. Refresh discovery so the checkbox reflects disk state.
                self.installation = core.discover(self.home, os.environ, self.port)
                raise
            self.start_work()
        self.worker(work)

    def monitor(self):
        if not self.busy and self.state in ('ready', 'reused', 'stopped'):
            def work():
                result = self.inspect()
                if result.state == 'reused':
                    self.failures = 0
                    if self.state == 'stopped':
                        self.later(self.show_result, result)
                else:
                    self.failures += 1
                    if self.failures >= 2:
                        self.later(self.show_state, 'stopped')
            self.worker(work)
        return True

    def open_logs(self):
        Gio.AppInfo.launch_default_for_uri(self.log_dir.as_uri(), None)

    def open_browser(self):
        # Keys stay out of the browser handoff; the user can authenticate there.
        self.external(self.origin)

    def message(self, text):
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, text=text, buttons=Gtk.ButtonsType.OK)
        dialog.run()
        dialog.destroy()

    def about(self):
        self.message(self.copy['about-detail'].format(version=self.metadata['version']))

    def updates(self):
        if self.state in ('ready', 'reused'):
            self.web.evaluate_javascript("window.dispatchEvent(new Event('llv:open-self-update'))", -1, None, None, None, None, None)
        def work():
            try:
                repository = self.metadata['repository']
                with urllib.request.urlopen(f'https://api.github.com/repos/{repository}/releases/latest', timeout=15) as response:
                    release = json.load(response)
                tag = release['tag_name'].removeprefix('v')
                name = 'delegatus_' + tag.replace('-', '~', 1) + '_all.deb'
                asset = next((x['browser_download_url'] for x in release.get('assets', []) if x['name'] == name), None)
                newer = core.release_version(tag) > core.release_version(self.metadata['version'])
                def present():
                    if newer and asset:
                        if self.ask(self.copy['new-app'].format(version=tag), self.copy['download']):
                            self.external(asset)
                    else:
                        self.message(self.copy['no-update'])
                self.later(present)
            except Exception:
                self.later(self.message, self.copy['update-failed'])
        self.worker(work)

    def close(self):
        if self.state == 'installing':
            self.closing = True
            self.cancel()
        elif self.busy:
            return True
        elif self.state in ('ready', 'reused'):
            if self.ask(self.copy['keep-question'], self.copy['keep']):
                self.quit()
        else:
            self.quit()
        return True


def main(entry, arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument('--accept-install', action='store_true')
    parser.add_argument('--port', type=int, default=8898)
    args = parser.parse_args(arguments)
    if not 1 <= args.port <= 65535:
        parser.error('invalid port')
    GLib.set_prgname(APP_ID)
    GLib.set_application_name('Delegatus')
    Gdk.set_program_class(APP_ID)
    return Application(entry, args.accept_install, args.port).run([])
