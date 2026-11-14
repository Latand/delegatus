"""Installed Linux app smoke. Own container, users, homes, display and processes."""
import argparse
import dataclasses
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time

APP = Path('/usr/lib/delegatus-app/delegatus-app')


def require(value, reason):
    if not value:
        raise AssertionError(reason)


def wait_for(callback, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = callback()
        if value:
            return value
        time.sleep(.25)
    raise AssertionError('observation deadline: ' + callback.__name__)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def process_identity(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def ready(port):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        conn.request('HEAD', '/api/onboarding/diagnostics')
        response = conn.getresponse()
        if response.status != 204 or response.getheader('x-delegatus-diagnostics') != '1':
            return False
        response.read()
        conn.request('GET', '/')
        response = conn.getresponse()
        ok = response.status == 200
        response.read()
        return ok
    except (OSError, http.client.HTTPException):
        return False
    finally:
        conn.close()


def home_footprint(home):
    result = {}
    for path in home.rglob('*'):
        relative = path.relative_to(home)
        if relative.parts[0] in ('.local', '.config', '.cache'):
            continue
        if path.is_file():
            result[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


class Smoke:
    def __init__(self, deb, report):
        require(os.getuid() == 0 and os.environ.get('CI') == 'true' and (Path('/.dockerenv').exists() or Path('/run/.containerenv').exists()), 'run only as root in a disposable CI container')
        self.deb, self.report = deb.resolve(), report.resolve()
        self.report.mkdir(parents=True, exist_ok=True)
        self.processes, self.apps, self.verdicts = [], [], []
        self.xvfb = None
        self.display = ':91'
        self.port = free_port()
        self.case_root = Path('/cases')

    def run(self, args, **kwargs):
        return subprocess.run(args, check=True, text=True, **kwargs)

    def verdict(self, name, positive, negative):
        require(positive, name + ' failed')
        require(negative, name + ' negative control did not reject')
        self.verdicts.append({'verdict': name, 'passed': True, 'negativeRejected': True})
        self.save()

    def save(self, error=None):
        value = {'verdicts': self.verdicts, 'error': error}
        (self.report / 'report.json').write_text(json.dumps(value, indent=2) + '\n')

    def home(self, name):
        home = self.case_root / name
        home.mkdir(parents=True)
        for directory in (home, home / '.local', home / '.local/state', home / '.config', home / '.cache', home / '.local/tmp'):
            directory.mkdir(parents=True, exist_ok=True)
            os.chown(directory, self.uid, self.gid)
        return home

    def env(self, home, lang='en', extra=None):
        return {'HOME': str(home), 'USER': 'tester', 'LOGNAME': 'tester', 'PATH': '/usr/bin:/bin',
                'DISPLAY': self.display, 'LANG': 'uk_UA.UTF-8' if lang == 'uk' else 'en_US.UTF-8',
                'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_CACHE_HOME': str(home / '.cache'),
                'LLV_STATE_DIR': str(home / '.config/delegatus/state'), 'TMPDIR': str(home / '.local/tmp'),
                'DELEGATUS_TELEMETRY': '0', **({'LLV_TOKEN': 'smoke-busy-credential'} if home.name == 'busy' else {}), **(extra or {})}

    def user_command(self, home, args, lang='en', extra=None):
        return ['runuser', '-u', 'tester', '--', 'env', '-i', *(f'{k}={v}' for k, v in self.env(home, lang, extra).items()), *map(str, args)]

    def user_run(self, home, args, **kwargs):
        return self.run(self.user_command(home, args), **kwargs)

    def launch(self, home, lang='en', accept=False):
        # Exec preserves the app PID, recorded inside the user's own session.
        pidfile = home / '.local/app.pid'
        pidfile.unlink(missing_ok=True)
        command = ['dbus-run-session', '--', '/bin/sh', '-c', 'echo $$ > "$HOME/.local/app.pid"; exec "$@"', 'sh', *self.desktop, '--port', str(self.port)]
        if accept:
            command.append('--accept-install')
        output = (self.report / f'launch-{len(self.apps)}.log').open('w')
        child = subprocess.Popen(self.user_command(home, command, lang), stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append((child, output))
        pid = wait_for(lambda: int(pidfile.read_text()) if pidfile.exists() and pidfile.read_text().strip() else None)
        app = {'pid': pid, 'identity': process_identity(pid), 'process': child, 'home': home}
        self.apps.append(app)
        return app

    def stop_app(self, app):
        if app['process'].poll() is None:
            if process_identity(app['pid']) == app['identity']:
                try:
                    os.kill(app['pid'], signal.SIGTERM)
                except ProcessLookupError:
                    pass
            app['process'].wait(timeout=15)

    def log(self, app):
        files = list((app['home'] / '.local/state/delegatus/logs').glob(f'app-*-{app["pid"]}.log'))
        return files[0].read_text() if files else ''

    def state(self, app, text, timeout=30):
        return wait_for(lambda: text in self.log(app), timeout)

    def windows(self, pid):
        env = {**os.environ, 'DISPLAY': self.display}
        tree = subprocess.check_output(['xwininfo', '-root', '-tree'], env=env, text=True)
        for wid in re.findall(r'(0x[0-9a-f]+) "Delegatus"', tree):
            props = subprocess.check_output(['xprop', '-id', wid, 'WM_CLASS', '_NET_WM_PID'], env=env, text=True)
            info = subprocess.check_output(['xwininfo', '-id', wid], env=env, text=True)
            if APP.name and 'org.delegatus.Delegatus' in props and re.search(rf'_NET_WM_PID\(CARDINAL\) = {pid}\b', props) and 'IsViewable' in info:
                return wid
        return None

    def frame(self, app, name):
        if name.startswith('ready-'):
            # A document's load completion precedes the client's first render.
            time.sleep(4)
        wid = wait_for(lambda: self.windows(app['pid']))
        path = self.report / (name + '.png')
        self.run(['import', '-display', self.display, '-window', wid, str(path)], stdout=subprocess.DEVNULL)
        deviation = float(subprocess.check_output(['identify', '-format', '%[fx:standard_deviation]', str(path)], text=True))
        require(deviation > .02, 'blank application frame')
        return path

    def cli(self, home, args):
        runtime = home / '.local/share/delegatus/runtime'
        return self.user_run(home, [runtime / 'bun/bin/bun', runtime / 'packages/node_modules/delegatus-cli/bin/cli.mjs', *args], timeout=150, stdout=subprocess.DEVNULL)

    def ancestry(self, home):
        script = "import sys,json,dataclasses; from pathlib import Path; sys.path.insert(0,'/usr/lib/delegatus-app'); from delegatus_app.core import listener; print(json.dumps(dataclasses.asdict(listener(int(sys.argv[1])))))"
        owner = json.loads(self.user_run(home, ['python3', '-I', '-c', script, self.port], capture_output=True).stdout)
        require(owner['kind'] in ('own-install', 'other-delegatus'), 'unverified listener')
        pid = owner['pid']
        for _ in range(64):
            args = Path(f'/proc/{pid}/cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if any(x.endswith(b'/bin/cli.mjs') for x in args):
                return pid, [os.fsdecode(x) for x in args]
            pid = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        raise AssertionError('no CLI ancestor')

    def stub(self, home):
        marker = home / '.local/stub-port'
        script = '''import http.server,sys
from pathlib import Path
class H(http.server.BaseHTTPRequestHandler):
 def do_HEAD(self):
  if self.headers.get('Authorization'): Path(sys.argv[2]).write_text('credential received')
  self.send_response(404); self.end_headers()
 def do_GET(self): self.do_HEAD()
 def log_message(self,*a): pass
s=http.server.HTTPServer(('127.0.0.1',0),H)
Path(sys.argv[1]).write_text(str(s.server_port))
s.serve_forever()
'''
        child = subprocess.Popen(self.user_command(home, ['python3', '-I', '-c', script, marker, home / '.local/credential-leak']), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.processes.append((child, None))
        self.port = wait_for(lambda: int(marker.read_text()) if marker.exists() else None)
        return child

    def execute(self):
        os.environ['DEBIAN_FRONTEND'] = 'noninteractive'
        self.run(['apt-get', 'update'], stdout=subprocess.DEVNULL)
        self.run(['apt-get', 'install', '-y', 'python3-gi'], stdout=subprocess.DEVNULL)
        before = Path('/package-before')
        self.run(['dpkg-deb', '--extract', str(self.deb), str(before)])
        missing = subprocess.run(['python3', '-I', str(before / 'usr/lib/delegatus-app/delegatus-app'), '--check-imports'], capture_output=True, text=True)
        self.run(['apt-get', 'install', '-y', str(self.deb)], stdout=subprocess.DEVNULL)
        imported = subprocess.run([str(APP), '--check-imports'], capture_output=True, text=True)
        self.verdict('V4', imported.returncode == 0, missing.returncode != 0 and ('Gtk' in missing.stderr or 'WebKit2' in missing.stderr))
        self.run(['apt-get', 'install', '-y', 'xvfb', 'x11-utils', 'imagemagick', 'dbus-x11', 'locales', 'fonts-dejavu-core'], stdout=subprocess.DEVNULL)
        self.run(['localedef', '-i', 'en_US', '-f', 'UTF-8', 'en_US.UTF-8'])
        self.run(['localedef', '-i', 'uk_UA', '-f', 'UTF-8', 'uk_UA.UTF-8'])
        self.run(['useradd', '--no-create-home', '--shell', '/bin/sh', 'tester'])
        user = pwd.getpwnam('tester')
        self.uid, self.gid = user.pw_uid, user.pw_gid
        desktop = Path('/usr/share/applications/org.delegatus.Delegatus.desktop').read_text()
        self.desktop = shlex.split(next(x[5:] for x in desktop.splitlines() if x.startswith('Exec=')))
        self.xvfb = subprocess.Popen(['Xvfb', self.display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.processes.append((self.xvfb, None))
        wait_for(lambda: Path('/tmp/.X11-unix/X91').exists())
        blank_window = self.windows(0) is None
        blank = self.report / 'blank.png'
        self.run(['convert', '-size', '1280x800', 'xc:black', str(blank)])
        blank_rejected = float(subprocess.check_output(['identify', '-format', '%[fx:standard_deviation]', str(blank)], text=True)) <= .02
        blank.unlink()
        home = self.home('install')
        before_home = home_footprint(home)
        app = self.launch(home)
        self.state(app, 'STATE needs-install')
        time.sleep(20)
        runtime = home / '.local/share/delegatus/runtime'
        require(not runtime.exists(), 'confirmation wrote runtime')
        self.frame(app, 'needs-install-en')
        self.stop_app(app)
        uk = self.launch(home, 'uk')
        self.state(uk, 'STATE needs-install')
        self.frame(uk, 'needs-install-uk')
        self.stop_app(uk)
        app = self.launch(home, accept=True)
        self.state(app, 'STATE ready', 720)
        self.state(app, 'WEB loaded status=200 language=en', 60)
        wait_for(lambda: ready(self.port))
        launcher_pid, argv = self.ancestry(home)
        require(argv[:2] == [str(runtime / 'bun/bin/bun'), str(runtime / 'packages/node_modules/delegatus-cli/bin/cli.mjs')], 'wrong first-run launcher')
        self.frame(app, 'ready-en')
        self.verdict('V5', 'STATE needs-install' in self.log(uk), runtime.exists())
        self.verdict('V6', self.windows(app['pid']) is not None, blank_window and blank_rejected)
        self.verdict('V8', home_footprint(home) == before_home, {**before_home, '.profile': 'changed'} != before_home)
        self.stop_app(app)
        reuse = self.launch(home, 'uk')
        self.state(reuse, 'STATE reused')
        self.state(reuse, 'WEB loaded status=200 language=uk', 60)
        self.frame(reuse, 'ready-uk')
        self.verdict('V9', self.ancestry(home)[0] == launcher_pid, 'STATE reused' not in self.log(app) and 'STATE ready' in self.log(app))
        self.stop_app(reuse)
        self.cli(home, ['stop', '--all'])
        stub_home = self.home('busy')
        stub = self.stub(stub_home)
        self.verdict('V7', 'STATE ready' in self.log(app), not ready(self.port))
        busy = self.launch(stub_home)
        self.state(busy, 'STATE port-busy')
        log = self.log(busy)
        # Verify the actual stub listener PID and no CLI ancestor was spawned.
        props = self.user_run(stub_home, ['python3', '-I', '-c', "import sys,json,dataclasses;sys.path.insert(0,'/usr/lib/delegatus-app');from delegatus_app.core import listener;print(json.dumps(dataclasses.asdict(listener(int(sys.argv[1])))))", self.port], capture_output=True).stdout
        owner = json.loads(props)
        self.verdict('V10', f'pid={owner["pid"]}' in log and 'python3' in log and not (stub_home / '.local/credential-leak').exists() and not (stub_home / '.local/share/delegatus/runtime').exists(), 'STATE port-busy' not in self.log(reuse))
        self.frame(busy, 'port-busy')
        self.stop_app(busy)
        stub.terminate()
        stub.wait(timeout=15)
        self.port = free_port()
        older_home = self.home('older')
        fake = older_home / '.local/fake'
        (fake / 'bin').mkdir(parents=True)
        (fake / 'dist/standalone').mkdir(parents=True)
        (fake / 'dist/standalone/server.js').touch()
        (fake / 'package.json').write_text('{"name":"delegatus-cli","version":"1.11.0"}')
        (fake / 'bin/cli.mjs').write_text("import {spawn} from 'node:child_process';spawn(process.execPath,[new URL('../dist/runtime-host.mjs',import.meta.url).pathname,process.argv[2]],{stdio:'inherit'});")
        (fake / 'dist/runtime-host.mjs').write_text("import http from 'node:http';http.createServer((q,s)=>{s.writeHead(404);s.end();}).listen(Number(process.argv[2]),'127.0.0.1');")
        for file in fake.rglob('*'):
            os.chown(file, self.uid, self.gid)
        os.chown(fake, self.uid, self.gid)
        old = subprocess.Popen(self.user_command(older_home, [runtime / 'bun/bin/bun', fake / 'bin/cli.mjs', self.port]), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.processes.append((old, None))
        def listening():
            with socket.socket() as sock:
                return sock.connect_ex(('127.0.0.1', self.port)) == 0
        wait_for(listening)
        older = self.launch(older_home)
        self.state(older, 'STATE older-delegatus')
        self.verdict('V11', '1.11.0' in self.log(older) and not (older_home / '.local/share/delegatus/runtime').exists(), 'STATE older-delegatus' not in log)
        self.frame(older, 'older-delegatus')
        self.stop_app(older)
        os.killpg(old.pid, signal.SIGTERM)
        old.wait(timeout=15)
        self.port = free_port()
        output = (self.report / 'booting-cli.log').open('w')
        boot = subprocess.Popen(self.user_command(home, [runtime / 'bun/bin/bun', runtime / 'packages/node_modules/delegatus-cli/bin/cli.mjs', '--no-open', '--port', self.port]), stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append((boot, output))
        booting = self.launch(home)
        wait_for(lambda: 'STATE ready' in self.log(booting) or 'STATE reused' in self.log(booting), 180)
        self.verdict('V12', 'STATE port-busy' not in self.log(booting) and 'STATE older-delegatus' not in self.log(booting), 'STATE port-busy' in log)
        self.stop_app(booting)
        self.cli(home, ['stop', '--all'])
        files = [Path(line) for line in subprocess.check_output(['dpkg', '-L', 'delegatus'], text=True).splitlines() if Path(line).is_file()]
        def removed():
            return all(not file.exists() for file in files)
        before_removal_rejected = not removed()
        data_file = runtime / 'packages/node_modules/delegatus-cli/package.json'
        config = home / '.config/delegatus'
        require(data_file.is_file() and config.is_dir(), 'missing data before removal')
        sentinel = config / 'launcher-smoke-data'
        sentinel.write_text('retained user data\n')
        os.chown(sentinel, self.uid, self.gid)
        expected = {file.relative_to(home): hashlib.sha256(file.read_bytes()).digest() for file in (data_file, sentinel)}
        def retained(candidate):
            return all((candidate / name).is_file() and hashlib.sha256((candidate / name).read_bytes()).digest() == digest for name, digest in expected.items())
        self.run(['apt-get', 'remove', '-y', 'delegatus'], stdout=subprocess.DEVNULL)
        require(removed() and retained(home), 'remove changed the wrong files')
        # A package without conffiles can disappear from apt's database on remove.
        # Exercise purge from a separately installed state as well.
        self.run(['apt-get', 'install', '-y', str(self.deb)], stdout=subprocess.DEVNULL)
        self.run(['apt-get', 'purge', '-y', 'delegatus'], stdout=subprocess.DEVNULL)
        self.verdict('V13', removed() and retained(home), before_removal_rejected and not retained(self.report / 'empty-home'))

    def cleanup(self):
        for app in reversed(self.apps):
            try:
                self.stop_app(app)
            except (OSError, subprocess.SubprocessError):
                pass
        # App-started CLIs have their own sessions. Stop only this smoke's homes.
        for home in self.case_root.glob('*'):
            if (home / '.local/share/delegatus/runtime/packages/node_modules/delegatus-cli/bin/cli.mjs').exists():
                try:
                    self.cli(home, ['stop', '--all'])
                except (OSError, subprocess.SubprocessError):
                    pass
        for child, output in reversed(self.processes):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=10)
                except ProcessLookupError:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait()
            if output:
                output.close()
        # Reports contain synthetic data, with private case homes scrubbed.
        for file in self.report.glob('*.log'):
            text = file.read_text(errors='replace').replace(str(self.case_root), '$CASE')
            text = re.sub(r'([?&]k=)[^\s&]+', r'\1[redacted]', text)
            file.write_text(text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('deb', type=Path)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    smoke = Smoke(args.deb, args.report)
    try:
        smoke.execute()
    except Exception as error:
        smoke.save(type(error).__name__ + ': ' + str(error).replace('/cases', '$CASE'))
        raise
    finally:
        try:
            smoke.cleanup()
        except Exception as error:
            earlier = json.loads((smoke.report / 'report.json').read_text()).get('error')
            smoke.save((earlier + '; ' if earlier else '') + 'cleanup: ' + type(error).__name__)
            raise
