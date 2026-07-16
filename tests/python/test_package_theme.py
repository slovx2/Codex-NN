from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (
    ROOT
    / "plugin"
    / "codex-nn-theme-designer"
    / "skills"
    / "design-codex-nn-theme"
    / "scripts"
    / "package_theme.py"
)
SOURCE_THEME = ROOT / "theme-packs" / "strawberry-starlight"


class PackageThemeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.theme = self.root / "theme"
        shutil.copytree(SOURCE_THEME, self.theme)
        self.output = self.root / "theme.zip"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_package(self, output: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                str(self.theme),
                "--output",
                str(output or self.output),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_packages_valid_theme_with_exact_root_entries(self) -> None:
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(
                sorted(archive.namelist()),
                ["background.webp", "theme.json"],
            )
            manifest = json.loads(archive.read("theme.json"))
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["image"], "background.webp")

    def test_rejects_extra_files(self) -> None:
        (self.theme / "notes.txt").write_text("extra", encoding="utf-8")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("必须且只能包含", result.stderr)
        self.assertFalse(self.output.exists())

    def test_rejects_invalid_schema_and_image_spoofing(self) -> None:
        manifest_path = self.theme / "theme.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["schemaVersion"] = 2
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("schemaVersion", result.stderr)

        manifest["schemaVersion"] = 1
        manifest["image"] = "background.png"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        (self.theme / "background.webp").rename(self.theme / "background.png")
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("内容与扩展名不一致", result.stderr)

    def test_rejects_output_inside_theme_directory(self) -> None:
        output = self.theme / "theme.zip"
        result = self.run_package(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("主题目录之外", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
