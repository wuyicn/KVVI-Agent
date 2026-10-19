"""Shared package collection policy; changing this policy needs requalification."""
from pathlib import PurePosixPath

from .package_inventory import _path

SKIP_ANYWHERE = ('/.git/', '/__pycache__/', '/.cache/', '/.pytest_cache/', '/.venv/', '/.dsh-build/')
PORTABLE_DEPENDENCIES = ('services/platform', 'tools/meta-schema')
SKIP_SUFFIX = ('.pyc', '.log', '.tsbuildinfo')


def should_skip(source_rel, rel):
    if source_rel == 'vendor/dsh' and (rel.strip('/') == '.dsh-build' or rel.startswith('.dsh-build/')):
        return rel not in ('.dsh-build/', '.dsh-build/client-build-environment.json')
    probe = '/' + rel.strip('/') + '/'
    if any(piece in probe for piece in SKIP_ANYWHERE):
        return True
    if '/node_modules/' in probe:
        return not any(source_rel == keep or source_rel.startswith(keep + '/') or keep.startswith(source_rel + '/')
                       for keep in PORTABLE_DEPENDENCIES)
    if rel.endswith(SKIP_SUFFIX):
        return True
    # lib/types contains runtime JS imports. Keep those JS files while excluding
    # declarations/maps; do not prune the directory containing them.
    return '/lib/types/' in probe and not rel.endswith('/') and not rel.endswith('.js')


def runtime_file_included(path):
    _path(path)
    return (not should_skip('vendor/dsh', path)
            and all(not should_skip('vendor/dsh', str(parent) + '/') for parent in PurePosixPath(path).parents if str(parent) != '.'))
