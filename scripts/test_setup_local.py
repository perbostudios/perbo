"""Exercise the executable setup entry point without installing real dependencies."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class SetupLocalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="perbo setup ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout with spaces"
        scripts = self.root / "scripts"
        scripts.mkdir(parents=True)
        self.script = scripts / "setup-local.mjs"
        shutil.copy2(Path(__file__).with_name("setup-local.mjs"), self.script)
        (self.root / "package.json").write_text('{"packageManager":"pnpm@9.15.9"}')
        self.profile = self.root / "profile.json"
        self.profile.write_text('{"existing":"preserve me"}')
        self.trace = self.root / "calls.jsonl"
        binaries = self.root / "bin"
        binaries.mkdir()
        for name in ("npm", "git"):
            binary = binaries / name
            binary.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                f"with open({str(self.trace)!r}, 'a') as output:\n"
                "    output.write(json.dumps({'tool': pathlib.Path(sys.argv[0]).name, 'args': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')\n"
                "if os.environ.get('FAIL_TOOL') == pathlib.Path(sys.argv[0]).name and '--version' in sys.argv:\n"
                "    sys.exit(1)\n"
                "if os.environ.get('FAIL_BUILD') and 'desktop:build' in sys.argv:\n"
                "    sys.exit(1)\n"
            )
            binary.chmod(0o755)
        self.environment = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"]}
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("Node is required to exercise desktop setup")

    def run_setup(self, *args: str, extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.node, str(self.script), *args],
            cwd=self.temporary.name,
            env={**self.environment, **(extra or {})},
            text=True, encoding="utf-8", capture_output=True, timeout=20, check=False,
        )

    def calls(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.trace.read_text(encoding="utf-8").splitlines()]

    def test_builds_with_pinned_pnpm_from_another_directory_and_preserves_data(self) -> None:
        for _ in range(2):
            result = self.run_setup("--no-launch")
            self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        installs = [call for call in calls if "install" in call["args"]]
        self.assertEqual(len(installs), 2)
        self.assertEqual(installs[0]["args"], ["exec", "--yes", "--package=pnpm@9.15.9", "--", "pnpm", "install", "--frozen-lockfile", "--prod=false"])
        self.assertTrue(all(Path(call["cwd"]).resolve() == self.root.resolve() for call in calls))
        self.assertFalse(any("desktop:start" in call["args"] for call in calls))
        self.assertEqual(self.profile.read_text(encoding="utf-8"), '{"existing":"preserve me"}')
        self.assertTrue(os.access(self.script, os.X_OK))

    def test_default_opens_the_built_desktop(self) -> None:
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [call["args"][-1] for call in self.calls()]
        self.assertEqual(commands[-2:], ["desktop:build", "desktop:start"])

    def test_failed_build_never_launches(self) -> None:
        result = self.run_setup(extra={"FAIL_BUILD": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Resolve the error above and rerun", result.stderr)
        self.assertFalse(any("desktop:start" in call["args"] for call in self.calls()))

    def test_failed_prerequisite_explains_remedy_before_installing(self) -> None:
        result = self.run_setup(extra={"FAIL_TOOL": "git"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("https://git-scm.com/downloads", result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_help_and_unknown_flags_do_not_install_anything(self) -> None:
        result = self.run_setup("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("--no-launch", result.stdout)
        result = self.run_setup("--publish")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.trace.exists())


if __name__ == "__main__":
    unittest.main()
