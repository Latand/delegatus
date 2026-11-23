"""Check an extracted package's complete root footprint and control members."""
from pathlib import Path
import sys


def footprint(root, mode):
    if mode not in ('pr', 'release'):
        raise ValueError('invalid mode')
    control = root / 'DEBIAN'
    if {p.name for p in control.iterdir()} != {'control', 'md5sums'}:
        raise ValueError('unexpected control member or maintainer script')
    prefixes = ('usr/lib/delegatus-app/', 'usr/share/applications/', 'usr/share/icons/hicolor/', 'usr/share/doc/delegatus/')
    for file in root.rglob('*'):
        if file.is_symlink():
            raise ValueError('unexpected symlink')
        if file.is_dir() or control in file.parents:
            continue
        if not file.relative_to(root).as_posix().startswith(prefixes):
            raise ValueError('file outside package footprint')
    if mode == 'release' and (root / 'usr/lib/delegatus-app/delegatus.tgz').exists():
        raise ValueError('release contains checkout bundle')


if __name__ == '__main__':
    footprint(Path(sys.argv[1]), sys.argv[2])
    print('root footprint: pass')
