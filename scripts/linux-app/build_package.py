"""Deterministic Debian payload assembly; downloads belong to manifest.ts."""
from datetime import datetime, timezone
import email.utils
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def assemble(mode, output, manifest, icons):
    if mode not in ('pr', 'release'):
        raise ValueError('invalid mode')
    source = Path(__file__).resolve().parents[2]
    value = json.loads(manifest.read_text())
    if value['mode'] != mode or value['platform'] != 'linux':
        raise ValueError('manifest mode/platform mismatch')
    release = json.loads((source / 'package.json').read_text())['version']
    if value['delegatus']['version'] != release or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', release):
        raise ValueError('manifest version mismatch')
    epoch = int(os.environ['SOURCE_DATE_EPOCH'])
    repository = os.environ['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('invalid repository')
    deb_version = release.replace('-', '~', 1)
    output.mkdir(parents=True, exist_ok=True)
    name = f'delegatus_{deb_version}_all.deb'
    with tempfile.TemporaryDirectory(prefix='deb.', dir=output) as temporary:
        root = Path(temporary) / 'root'
        app = root / 'usr/lib/delegatus-app'
        app.mkdir(parents=True)
        shutil.copyfile(source / 'linux/delegatus-app', app / 'delegatus-app')
        shutil.copytree(source / 'linux/delegatus_app', app / 'delegatus_app', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        shutil.copyfile(manifest, app / 'runtime-manifest.json')
        if mode == 'pr':
            shutil.copyfile(manifest.parent / 'delegatus.tgz', app / 'delegatus.tgz')
        (app / 'app.json').write_text(json.dumps({'version': release, 'repository': repository}, sort_keys=True) + '\n')
        desktop = root / 'usr/share/applications'
        desktop.mkdir(parents=True)
        shutil.copyfile(source / 'linux/org.delegatus.Delegatus.desktop', desktop / 'org.delegatus.Delegatus.desktop')
        for size in (16, 32, 64, 128, 256, 512):
            directory = root / f'usr/share/icons/hicolor/{size}x{size}/apps'
            directory.mkdir(parents=True)
            base_size, scale = (32, '@2x') if size == 64 else (size, '')
            original = icons / f'icon_{base_size}x{base_size}{scale}.png'
            shutil.copyfile(original, directory / 'org.delegatus.Delegatus.png')
        scalable = root / 'usr/share/icons/hicolor/scalable/apps'
        scalable.mkdir(parents=True)
        shutil.copyfile(source / 'public/brand/delegatus-touch-icon.svg', scalable / 'org.delegatus.Delegatus.svg')
        docs = root / 'usr/share/doc/delegatus'
        docs.mkdir(parents=True)
        license_text = '\n'.join(' .' if not line else ' ' + line for line in (source / 'LICENSE').read_text().splitlines())
        copyright_text = (source / 'linux/copyright.in').read_text().replace('@REPOSITORY@', repository).replace('@LICENSE@', license_text)
        (docs / 'copyright').write_text(copyright_text)
        date = email.utils.format_datetime(datetime.fromtimestamp(epoch, timezone.utc))
        changelog = f'delegatus ({deb_version}) unstable; urgency=medium\n\n  * Delegatus desktop launcher for Linux.\n\n -- Delegatus <noreply@delegatus.invalid>  {date}\n'
        (docs / 'changelog.gz').write_bytes(gzip.compress(changelog.encode(), compresslevel=9, mtime=0))
        control = root / 'DEBIAN'
        control.mkdir()
        files = sorted(p for p in root.rglob('*') if p.is_file() and control not in p.parents)
        size = sum((file.stat().st_size + 1023) // 1024 for file in files)
        (control / 'control').write_text(f'''Package: delegatus
Version: {deb_version}
Architecture: all
Section: devel
Priority: optional
Maintainer: Delegatus <noreply@delegatus.invalid>
Installed-Size: {size}
Depends: python3 (>= 3.11), python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, ca-certificates
Homepage: https://delegatus.org
Description: desktop window for local coding agents
 Opens Delegatus in its own window. On first run, installs the pinned Bun
 runtime and Delegatus release for the current user with integrity checks.
''')
        sums = []
        for file in files:
            with file.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'md5').hexdigest()
            sums.append(f'{digest}  {file.relative_to(root)}\n')
        (control / 'md5sums').write_text(''.join(sums))
        for path in [root, *root.rglob('*')]:
            path.chmod(0o755 if path.is_dir() or path == app / 'delegatus-app' else 0o644)
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        subprocess.run([sys.executable, '-I', str(source / 'scripts/linux-app/package_checks.py'), str(root), mode], check=True)
        subprocess.run(['dpkg-deb', '--root-owner-group', '--threads-max=2', '-Zxz', '--build', str(root), str(output / name)], check=True)
    with (output / name).open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    (output / (name + '.sha256')).write_text(f'{sha}  {name}\n')


if __name__ == '__main__':
    assemble(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
