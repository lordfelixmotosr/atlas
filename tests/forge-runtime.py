import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("atlas_forge_runtime", Path(sys.argv.pop(1)) / "forge_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class RuntimeTests(unittest.TestCase):
    def test_load_folders_selects_only_requested_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for version in ("1.6", "1.7"):
                (root / version).mkdir()
            (root / "LoadFolders.xml").write_text('<loadFolders><v1.6><li>1.6</li></v1.6><v1.7><li>1.7</li></v1.7></loadFolders>')
            for version in ("1.6", "1.7"):
                roots, problems, complete = bridge.load_roots(root, version)
                self.assertEqual(roots, [root / version])
                self.assertTrue(complete)
                self.assertFalse(problems)

    def test_missing_version_and_escaping_folders_are_not_validated_as_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for xml in ('<loadFolders><v1.6><li>/</li></v1.6></loadFolders>', '<loadFolders><v1.7><li>../</li></v1.7></loadFolders>'):
                (root / "LoadFolders.xml").write_text(xml)
                roots, problems, complete = bridge.load_roots(root, "1.7")
                self.assertFalse(complete)
                self.assertTrue(problems)

    def test_waylith_assemblies_and_unity_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            unity = root / "RimWorldWin64_Data/Managed"
            unity.mkdir(parents=True)
            self.assertEqual(bridge.discovery.managed_dir(root), unity)
            for name in ("Waylith.dll", "Assembly-CSharp.dll"):
                (root / name).touch()
            self.assertEqual(bridge.discovery.managed_dir(root), root)


unittest.main()
