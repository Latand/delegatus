"""Per-user installation, discovery and loopback ownership. Standard library only."""
from dataclasses import dataclass, field
import base64
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.parse
import zipfile

SERVICE_MARKER = 'Written by "delegatus service install". "delegatus service remove" deletes it.'
REQUIRED = ('bin/cli.mjs', 'dist/runtime-host.mjs', 'dist/standalone/server.js')
VERIFIED = ('own-install', 'other-delegatus')


class LauncherError(Exception):
    pass


def runtime_dir(home):
    return home / '.local/share/delegatus/runtime'


def language(env):
    for key in ('LANGUAGE', 'LC_ALL', 'LC_MESSAGES', 'LANG'):
        value = env.get(key, '').split(':')[0].split('.')[0]
        if value and value not in ('C', 'POSIX'):
            return 'uk' if value.startswith('uk') else 'en'
    return 'en'


def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise LauncherError('invalid-version')
    return tuple(map(int, value.split('.')))


def release_version(value):
    match = re.fullmatch(r'(\d+\.\d+\.\d+)(?:-([A-Za-z0-9.-]+))?', value)
    if not match:
        raise LauncherError('invalid-version')
    pre = match[2]
    identifiers = tuple((0, int(x)) if x.isdecimal() else (1, x) for x in pre.split('.')) if pre else ()
    return (*version(match[1]), pre is None, identifiers)


def package_info(root):
    try:
        value = json.loads((root / 'package.json').read_text())
        if value['name'] == 'delegatus-cli' and isinstance(value['version'], str):
            return value
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


@dataclass
class Installation:
    bun: Path
    cli: Path
    environment: dict = field(default_factory=dict)
    service: Path | None = None

    @property
    def root(self):
        return self.cli.parent.parent.resolve()

    def valid(self):
        return os.access(self.bun, os.X_OK) and package_info(self.root) is not None and all((self.root / p).is_file() for p in REQUIRED)


def systemd_words(value, command=False):
    # The product writer quotes every argument, escaping backslash and percent.
    words = shlex.split(value, posix=True)
    return [x.replace('%%', '%').replace('$$', '$') if command else x.replace('%%', '%') for x in words]


def read_service(file, port):
    try:
        info = file.lstat()
        import stat
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError()
        text = file.read_text()
        if not text.startswith('# ' + SERVICE_MARKER + '\n'):
            raise ValueError()
        args, env = None, {}
        for line in text.splitlines():
            if line.startswith('ExecStart='):
                if args is not None:
                    raise ValueError()
                args = systemd_words(line.partition('=')[2], True)
            if line.startswith('Environment='):
                for pair in systemd_words(line.partition('=')[2]):
                    key, sep, val = pair.partition('=')
                    if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', key):
                        raise ValueError()
                    env[key] = val
        if not args or len(args) != 5 or args[2:4] != ['--no-open', '--port']:
            raise ValueError()
        if args[4] != str(port):
            raise LauncherError('service-port')
        if not all(Path(x).is_absolute() for x in args[:2]) or not args[1].endswith('/bin/cli.mjs'):
            raise ValueError()
        install = Installation(Path(args[0]), Path(args[1]), env, file)
        if not install.valid():
            raise ValueError()
        return install
    except (OSError, ValueError, TypeError):
        raise LauncherError('service-invalid') from None


def service_file():
    try:
        result = subprocess.run(['systemctl', '--user', 'show', 'delegatus.service', '--property=FragmentPath', '--value'], capture_output=True, text=True, timeout=5)
        path = result.stdout.strip()
        return Path(path) if result.returncode == 0 and path else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def discover(home, env, port=8898, service_lookup=service_file):
    unit = service_lookup()
    if unit:
        return read_service(unit, port)
    runtime = runtime_dir(home)
    for install in (Installation(runtime / 'bun/bin/bun', runtime / 'packages/node_modules/delegatus-cli/bin/cli.mjs'),
                    Installation(home / '.bun/bin/bun', home / '.bun/install/global/node_modules/delegatus-cli/bin/cli.mjs')):
        if install.valid():
            return install
    return None


def child_environment(home, env, install, lang):
    result = {**env, **(install.environment if install else {}), 'HOME': str(home), 'LLV_LANG': lang, 'NO_COLOR': '1'}
    paths = [str(install.bun.parent)] if install else []
    result['PATH'] = ':'.join(paths + [str(home / '.bun/bin'), str(home / '.local/bin'), result.get('PATH', '/usr/local/bin:/usr/bin:/bin')])
    # The CLI folds the public alias over LLV_LANG.
    result.pop('DELEGATUS_LANG', None)
    return result


def access_key(home, env):
    direct = env.get('DELEGATUS_TOKEN') or env.get('LLV_TOKEN')
    if direct:
        return direct
    config = Path(env.get('XDG_CONFIG_HOME', home / '.config'))
    directory = config / 'delegatus'
    if not directory.exists():
        directory = config / 'agent-log-viewer'
    try:
        value = (directory / 'token').read_text().strip()
        return value if re.fullmatch('[a-f0-9]{32}', value) else None
    except OSError:
        return None


@dataclass
class Listener:
    kind: str
    pid: int = 0
    name: str = '?'
    version: str = ''


def listening_sockets(text, port):
    rows = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        try:
            if parts[3] == '0A' and int(parts[1].split(':')[1], 16) == port:
                rows.append((int(parts[7]), parts[9]))
        except (IndexError, ValueError):
            continue
    return rows


def process_row(proc, pid):
    directory = proc / str(pid)
    try:
        if directory.stat().st_uid != os.getuid():
            return None
        args = [os.fsdecode(x) for x in (directory / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')]
        # comm may itself contain spaces or parentheses.
        parent = int((directory / 'stat').read_text().rsplit(')', 1)[1].split()[1])
        return args, parent
    except (OSError, ValueError, IndexError):
        return None


def script_argument(args):
    if len(args) < 2:
        return None
    index = 2 if args[1] == '--bun' else 1
    return Path(args[index]) if len(args) > index and Path(args[index]).is_absolute() else None


def listener(port, install=None, proc=Path('/proc')):
    rows = []
    for table in ('tcp', 'tcp6'):
        try:
            rows.extend(listening_sockets((proc / 'net' / table).read_text(), port))
        except OSError:
            pass
    if not rows or any(uid != os.getuid() for uid, _ in rows):
        return Listener('other-user')
    inodes = {inode for _, inode in rows}
    owners = {}
    for directory in proc.iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            if directory.stat().st_uid != os.getuid():
                continue
            for fd in (directory / 'fd').iterdir():
                try:
                    target = os.readlink(fd)
                    for inode in inodes:
                        if target == f'socket:[{inode}]':
                            owners[inode] = int(directory.name)
                except OSError:
                    pass
        except OSError:
            continue
    if not inodes.issubset(owners):
        return Listener('other-user')
    outcomes = []
    for pid in sorted(set(owners.values())):
        try:
            name = (proc / str(pid) / 'comm').read_text().strip()[:80]
        except OSError:
            name = '?'
        outcome = Listener('program', pid, name)
        cursor, seen, server = pid, set(), False
        while cursor > 1 and cursor not in seen and len(seen) < 64:
            seen.add(cursor)
            row = process_row(proc, cursor)
            if not row:
                break
            args, cursor = row
            script = script_argument(args)
            if script and (str(script).endswith('/dist/runtime-host.mjs') or str(script).endswith('/dist/standalone/server.js')):
                server = True
            if server and script and str(script).endswith('/bin/cli.mjs'):
                root = script.parent.parent.resolve()
                info = package_info(root)
                if info:
                    own = install and root == install.root
                    if own or outcome.kind == 'program':
                        outcome = Listener('own-install' if own else 'other-delegatus', pid, name, info['version'])
                    if own:
                        break
                # An updated CLI is supervised by the original install's CLI.
                # Walk through the release handoff before deciding it is foreign.
        outcomes.append(outcome)
    # Every listener must be verified before sending a key or opening the view.
    if all(x.kind in VERIFIED for x in outcomes):
        return next((x for x in outcomes if x.kind == 'other-delegatus'), outcomes[0])
    return next(x for x in outcomes if x.kind not in VERIFIED)


@dataclass
class Probe:
    state: str
    key: str | None = None
    detail: str = ''
    owner: Listener | None = None


def probe(port, key, inspect):
    def request(credential=None):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            headers = {'Authorization': 'Bearer ' + credential} if credential else {}
            conn.request('HEAD', '/api/onboarding/diagnostics', headers=headers)
            answer = conn.getresponse()
            return answer.status, answer.getheader('x-delegatus-diagnostics')
        finally:
            conn.close()
    used = None
    try:
        code, marker = request()
        if code in (401, 403) and key and inspect().kind in VERIFIED:
            # Reinspect after the first awaited response, immediately before retry.
            code, marker = request(key)
            used = key
        return Probe('ready' if code == 204 and marker == '1' else 'busy', used, f'HEAD {code} marker={marker}')
    except ConnectionRefusedError:
        return Probe('free', detail='connection refused')
    except (OSError, http.client.HTTPException, socket.timeout):
        return Probe('waiting', detail='no response yet')


def decision(result, owner):
    if result.state == 'free':
        return result
    if owner.kind in VERIFIED and result.state == 'ready':
        return Probe('reused', result.key, result.detail, owner)
    state = {'own-install': 'starting', 'other-delegatus': 'older-delegatus', 'program': 'port-busy', 'other-user': 'other-user'}[owner.kind]
    return Probe(state, detail=result.detail, owner=owner)


def observe(port, install, key, inspect=None):
    inspect = inspect or (lambda: listener(port, install))
    result = probe(port, key, inspect)
    return decision(result, inspect()) if result.state != 'free' else result


def load_manifest(file):
    try:
        value = json.loads(file.read_text())
        if value['platform'] != 'linux' or value['mode'] not in ('pr', 'release'):
            raise ValueError()
        version(value['bun']['version'])
        if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', value['delegatus']['version']):
            raise ValueError()
        if not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', value['delegatus']['integrity']):
            raise ValueError()
        if value['mode'] == 'release' and value['delegatus']['tarball'].startswith('bundle:'):
            raise LauncherError('bundle-forbidden')
        return value
    except (OSError, ValueError, KeyError, TypeError):
        raise LauncherError('invalid-manifest') from None


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != 'https':
            raise LauncherError('untrusted-url')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_https(url, destination):
    if urllib.parse.urlsplit(url).scheme != 'https':
        raise LauncherError('untrusted-url')
    opener = urllib.request.build_opener(HTTPSRedirect())
    deadline = time.monotonic() + 300
    with opener.open(url, timeout=15) as response, destination.open('wb') as output:
        while chunk := response.read(128 * 1024):
            if time.monotonic() > deadline:
                raise LauncherError('download-timeout')
            output.write(chunk)


def file_digest(file, algorithm):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).digest()


def install_runtime(runtime, manifest_file, architecture=None, download=download_https):
    manifest = load_manifest(manifest_file)
    arch = architecture or {'aarch64': 'arm64', 'x86_64': 'x86_64'}.get(platform.machine())
    if arch not in manifest['bun']:
        raise LauncherError('unsupported')
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (runtime / '.install-lock-v2').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LauncherError('install-locked') from None
        stage = Path(tempfile.mkdtemp(prefix='.stage.', dir=runtime))
        child = None
        handlers = {}
        published_bun = published_packages = committed = False

        def cancelled(_sig, _frame):
            raise LauncherError('install-cancelled')

        def run(args, **kwargs):
            nonlocal child
            child = subprocess.Popen(args, start_new_session=True, **kwargs)
            status = child.wait(timeout=600)
            child = None
            if status:
                raise LauncherError('install-command-failed')

        try:
            for sig in (signal.SIGTERM, signal.SIGINT):
                handlers[sig] = signal.signal(sig, cancelled)
            archive = manifest['bun'][arch]
            print('SETUP 1/3', flush=True)
            download(archive['url'], stage / 'bun.zip')
            if file_digest(stage / 'bun.zip', 'sha256').hex() != archive['sha256']:
                raise LauncherError('bun-checksum')
            binary = 'bun-linux-aarch64/bun' if arch == 'arm64' else 'bun-linux-x64-baseline/bun'
            target = stage / 'bun/bin/bun'
            target.parent.mkdir(parents=True)
            with zipfile.ZipFile(stage / 'bun.zip') as zip_file, zip_file.open(binary) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o700)
            actual = subprocess.check_output([str(target), '--version'], text=True, timeout=10).strip()
            if actual != manifest['bun']['version']:
                raise LauncherError('bun-version')
            current = runtime / 'bun/bin/bun'
            use = target
            if os.access(current, os.X_OK):
                try:
                    installed = subprocess.check_output([str(current), '--version'], text=True, timeout=10).strip()
                    if version(installed) >= version(actual):
                        use = current
                except (OSError, subprocess.SubprocessError, LauncherError):
                    pass
            packages = runtime / 'packages'
            if packages.exists() and not Installation(use, packages / 'node_modules/delegatus-cli/bin/cli.mjs').valid():
                raise LauncherError('incomplete-private-package')
            if not packages.exists():
                print('SETUP 2/3', flush=True)
                tarball = stage / 'delegatus.tgz'
                url = manifest['delegatus']['tarball']
                if url == 'bundle:delegatus.tgz' and manifest['mode'] == 'pr':
                    shutil.copyfile(manifest_file.parent / 'delegatus.tgz', tarball)
                else:
                    download(url, tarball)
                integrity = 'sha512-' + base64.b64encode(file_digest(tarball, 'sha512')).decode()
                if integrity != manifest['delegatus']['integrity']:
                    raise LauncherError('delegatus-checksum')
                (stage / 'packages').mkdir()
                (stage / 'packages/package.json').write_text('{"private":true}\n')
                (stage / 'home').mkdir()
                env = {**os.environ, 'HOME': str(stage / 'home'), 'BUN_INSTALL': str(stage / 'home/.bun'),
                       'XDG_CACHE_HOME': str(stage / 'home/.cache'), 'XDG_CONFIG_HOME': str(stage / 'home/.config')}
                run([str(use), 'add', '--exact', str(tarball)], cwd=stage / 'packages', env=env)
                candidate = Installation(use, stage / 'packages/node_modules/delegatus-cli/bin/cli.mjs')
                if not candidate.valid() or package_info(candidate.root)['version'] != manifest['delegatus']['version']:
                    raise LauncherError('package-identity')
            print('SETUP 3/3', flush=True)
            if use == target:
                if (runtime / 'bun').exists():
                    (runtime / 'bun').rename(stage / 'previous-bun')
                published_bun = True
                (stage / 'bun').rename(runtime / 'bun')
            if (stage / 'packages').exists():
                if packages.exists():
                    raise LauncherError('incomplete-private-package')
                published_packages = True
                (stage / 'packages').rename(packages)
            committed = True
        finally:
            for sig in handlers:
                signal.signal(sig, signal.SIG_IGN)
            if child:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                except ProcessLookupError:
                    pass
            if not committed:
                if published_packages:
                    shutil.rmtree(runtime / 'packages')
                if published_bun:
                    shutil.rmtree(runtime / 'bun', ignore_errors=True)
                if (stage / 'previous-bun').exists():
                    (stage / 'previous-bun').rename(runtime / 'bun')
            shutil.rmtree(stage)
            for sig, previous in handlers.items():
                signal.signal(sig, previous)


def redact(text, home, key=None):
    text = str(text).replace(str(home), '$HOME')
    if key:
        text = text.replace(key, '[redacted]')
    text = re.sub(r'([?&]k=)[^\s&]+', r'\1[redacted]', text)
    return re.sub(r'(?i)(Bearer\s+)[^\s]+', r'\1[redacted]', text)


def pipe_log(home, file):
    """A detached reader keeps the server's stdout alive after the window quits."""
    import sys
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'w', buffering=1) as output:
        for chunk in iter(lambda: sys.stdin.buffer.readline(8192), b''):
            output.write(redact(chunk.decode('utf-8', 'replace'), home, access_key(home, os.environ)))
