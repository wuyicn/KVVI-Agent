import contextlib
import io
import json
import os
import subprocess
from pathlib import Path
import tarfile
import unittest

from distribution.tests import test_release_package as preservation


class PackageInventoryTests(unittest.TestCase):
    setUp = preservation.ReleasePackageTests.setUp
    call = preservation.ReleasePackageTests.call
    pair = preservation.ReleasePackageTests.pair

    def rewrite(self, mutate):
        members = []
        with tarfile.open(self.module.ARCHIVE, 'r:gz') as source:
            for member in source:
                with contextlib.ExitStack() as stack:
                    handle = stack.enter_context(source.extractfile(member)) if member.isfile() else None
                    members.append((member, handle.read() if handle else None))
        mutate(members)
        with tarfile.open(self.module.ARCHIVE, 'w:gz') as target:
            for member, body in members:
                if body is not None: member.size = len(body)
                target.addfile(member, io.BytesIO(body) if body is not None else None)
        manifest = json.loads(Path(self.module.MANIFEST).read_text())
        manifest['archiveSha256'] = self.module.sha256_of(self.module.ARCHIVE)
        manifest['archiveBytes'] = Path(self.module.ARCHIVE).stat().st_size
        Path(self.module.MANIFEST).write_text(json.dumps(manifest))

    def test_fresh_package_passes(self):
        self.assertEqual(self.call(self.module.check), 0)

    def test_changed_tar_body_with_recomputed_external_archive_hash_is_rejected(self):
        def mutate(rows):
            i = next(i for i, (m, _) in enumerate(rows) if m.name.endswith('/README.md'))
            rows[i] = (rows[i][0], b'changed tar payload\n')
        self.rewrite(mutate)
        self.assertNotEqual(self.call(self.module.check), 0)

    def test_unsafe_extra_duplicate_and_wrong_type_members_are_rejected(self):
        original = self.pair()
        def append_file(rows, name):
            member = tarfile.TarInfo(name); rows.append((member, b'unexpected'))
        for kind in ('traversal', 'absolute', 'backslash', 'unknown-top', 'extra', 'duplicate', 'directory', 'hardlink', 'absolute-link', 'escaping-link', 'mode', 'mtime'):
            with self.subTest(kind=kind):
                Path(self.module.ARCHIVE).write_bytes(original[0]); Path(self.module.MANIFEST).write_bytes(original[1])
                def mutate(rows):
                    if kind in ('traversal','absolute','backslash','unknown-top','extra'):
                        name = {'traversal':self.module.TOP + '/../outside', 'absolute':'/outside', 'backslash':self.module.TOP + '/bad\\name', 'unknown-top':'unknown/data', 'extra':self.module.TOP + '/unlisted.txt'}[kind]
                        append_file(rows, name); return
                    index = next(i for i, (m, _) in enumerate(rows) if m.name.endswith('/README.md'))
                    member, body = rows[index]
                    if kind == 'duplicate': rows.append((member, body)); return
                    if kind == 'mode': member.mode = 0o777; return
                    if kind == 'mtime': member.mtime = 2147483647; return
                    member.type = {'directory':tarfile.DIRTYPE, 'hardlink':tarfile.LNKTYPE, 'absolute-link':tarfile.SYMTYPE, 'escaping-link':tarfile.SYMTYPE}[kind]
                    member.size = 0; member.linkname = '/outside' if kind == 'absolute-link' else '../../outside'
                    rows[index] = (member, None)
                self.rewrite(mutate)
                self.assertNotEqual(self.call(self.module.check), 0)

    def test_internal_manifest_body_is_verified(self):
        def mutate(rows):
            index = next(i for i, (m, _) in enumerate(rows) if m.name == self.module.TOP + '/发行包清单.json')
            rows[index] = (rows[index][0], b'{"fileCount":0}')
        self.rewrite(mutate)
        self.assertNotEqual(self.call(self.module.check), 0)

    def test_external_manifest_count_and_size_are_verified(self):
        original = Path(self.module.MANIFEST).read_bytes()
        for field in ('fileCount','archiveBytes'):
            with self.subTest(field=field):
                manifest = json.loads(original); manifest[field] += 1
                Path(self.module.MANIFEST).write_text(json.dumps(manifest))
                self.assertNotEqual(self.call(self.module.check), 0)

    def test_malformed_or_legacy_external_manifest_fails_closed(self):
        original = json.loads(Path(self.module.MANIFEST).read_text())
        for body in ('{}', '[]', '[' * 10000 + '0' + ']' * 10000, '{"archiveSha256":1,"archiveSha256":2}', json.dumps(dict(original, bundleVersion='kvvi-macos-pilot/v1'))):
            Path(self.module.MANIFEST).write_text(body)
            self.assertNotEqual(self.call(self.module.check), 0)
        self.assertEqual(Path(self.module.ARCHIVE).read_bytes(), self.old[0])

    def test_symlink_files_and_directories_are_recorded_without_dereferencing(self):
        source = self.root / 'distribution'
        (source / 'real-dir').mkdir(); (source / 'real-dir/data.txt').write_bytes(b'real bytes')
        (source / 'directory-alias').symlink_to('real-dir', target_is_directory=True)
        (source / 'file-alias').symlink_to('real-dir/data.txt')
        self.assertEqual(self.call(self.module.build), 0)
        with tarfile.open(self.module.ARCHIVE) as archive:
            self.assertTrue(archive.getmember(self.module.TOP + '/distribution/directory-alias').issym())
            self.assertTrue(archive.getmember(self.module.TOP + '/distribution/file-alias').issym())
        self.assertEqual(self.call(self.module.check), 0)

    def test_unsafe_or_dangling_source_symlink_preserves_previous_outputs(self):
        link = self.root / 'distribution/unsafe-link'
        for target in ('/outside', '../../outside', 'missing', 'unsafe-link'):
            with self.subTest(target=target):
                link.symlink_to(target)
                try:
                    self.assertNotEqual(self.call(self.module.build), 0)
                    self.assertEqual(self.pair(), self.old)
                finally: link.unlink()

    def test_source_mode_and_link_text_changes_are_detected(self):
        source = self.root / 'distribution'
        (source / 'first').write_bytes(b'same'); (source / 'second').write_bytes(b'same')
        link = source / 'alias'; link.symlink_to('first')
        self.assertEqual(self.call(self.module.build), 0); self.assertEqual(self.call(self.module.check), 0)
        link.unlink(); link.symlink_to('second')
        self.assertNotEqual(self.call(self.module.check), 0)
        link.unlink(); link.symlink_to('first')
        self.assertEqual(self.call(self.module.check), 0)
        (source / 'first').chmod(0o755)
        self.assertNotEqual(self.call(self.module.check), 0)

    def test_symlink_expansion_precedes_parent_components(self):
        source = self.root / 'distribution'
        (source / 'secret').write_bytes(b'lexically plausible target')
        (source / 'root-alias').symlink_to('..', target_is_directory=True)
        (source / 'escape').symlink_to('root-alias/../secret')
        self.assertFalse((source / 'escape').exists())
        self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(self.pair(), self.old)

    def test_safe_component_order_links_round_trip_with_system_tar(self):
        source = self.root / 'distribution'
        (source / 'real/inner').mkdir(parents=True); (source / 'real/inner/marker').write_bytes(b'marker')
        (source / 'real/data').write_bytes(b'actual target')
        (source / 'alias').symlink_to('real/inner', target_is_directory=True)
        (source / 'composite').symlink_to('alias/../data')
        self.assertEqual(self.call(self.module.build), 0); self.assertEqual(self.call(self.module.check), 0)
        destination = self.root / 'unpacked'; destination.mkdir()
        result = subprocess.run(['/usr/bin/tar','-xzf',self.module.ARCHIVE,'-C',str(destination)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual((destination / self.module.TOP / 'distribution/composite').read_bytes(), b'actual target')

    def test_unreadable_source_directory_cannot_be_silently_omitted(self):
        directory = self.root / 'distribution/unreadable'; directory.mkdir(); (directory / 'required-by-inventory').write_bytes(b'keep')
        self.assertEqual(self.call(self.module.build), 0); previous = self.pair()
        directory.chmod(0)
        try:
            if os.access(directory, os.R_OK | os.X_OK): self.skipTest('current user can bypass mode permissions')
            self.assertNotEqual(self.call(self.module.build), 0)
            self.assertEqual(self.pair(), previous)
        finally: directory.chmod(0o755)

    def test_operating_manual_is_required(self):
        (self.root / 'docs/操作手册.md').unlink()
        self.assertNotEqual(self.call(self.module.build), 0)
        self.assertEqual(self.pair(), self.old)

    def test_pax_semantics_and_data_after_tar_end_are_rejected(self):
        original = self.pair()
        for attack in ('pax', 'concatenated-tar', 'missing-gzip-footer'):
            with self.subTest(attack=attack):
                Path(self.module.ARCHIVE).write_bytes(original[0]); Path(self.module.MANIFEST).write_bytes(original[1])
                if attack == 'pax':
                    def mutate(rows): rows[0][0].pax_headers['SCHILY.xattr.user.untrusted'] = 'unexpected'
                    self.rewrite(mutate)
                else:
                    if attack == 'concatenated-tar':
                        import gzip
                        with gzip.open(self.module.ARCHIVE, 'ab') as compressed:
                            with tarfile.open(fileobj=compressed, mode='w|') as archive:
                                member = tarfile.TarInfo('../outside'); member.size = 1; archive.addfile(member, io.BytesIO(b'x'))
                    else: Path(self.module.ARCHIVE).write_bytes(original[0][:-8])
                    manifest = json.loads(Path(self.module.MANIFEST).read_text())
                    manifest['archiveSha256'] = self.module.sha256_of(self.module.ARCHIVE)
                    manifest['archiveBytes'] = Path(self.module.ARCHIVE).stat().st_size
                    Path(self.module.MANIFEST).write_text(json.dumps(manifest))
                self.assertNotEqual(self.call(self.module.check), 0)


if __name__ == '__main__':
    unittest.main()
