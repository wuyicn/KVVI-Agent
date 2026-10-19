import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('fork_tool',Path(__file__).with_name('fork.py'))
FORK=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FORK)


class ForkPathsTest(unittest.TestCase):
    def test_local_export_supports_relative_and_spaced_destinations(self):
        with tempfile.TemporaryDirectory(prefix='kvvi-fork-path-') as temp:
            root=Path(temp)
            source=root/'source'
            source.mkdir()
            subprocess.run(['git','init','-q',str(source)],check=True)
            (source/'baseline.txt').write_text('pinned baseline')
            subprocess.run(['git','-C',str(source),'add','baseline.txt'],check=True)
            subprocess.run(['git','-C',str(source),'-c','user.name=Test','-c','user.email=test@example.invalid',
                            'commit','-qm','fixture'],check=True)
            sha=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
            with patch.object(FORK,'DSH',str(source)), patch.object(FORK,'manifest',return_value={'upstream_merge_base':sha}):
                for name in ['relative', 'destination with spaces', '中文 目录']:
                    with self.subTest(name=name):
                        destination=root/name
                        target=os.path.relpath(destination,Path.cwd()) if name=='relative' else str(destination)
                        self.assertTrue(FORK.pristine('local',target))
                        self.assertEqual((destination/'baseline.txt').read_text(),'pinned baseline')


if __name__=='__main__':
    unittest.main()
