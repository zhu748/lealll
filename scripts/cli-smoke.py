#!/usr/bin/env python3
"""Check the packaged CLI without credentials, external traffic or a terminal."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    bundle = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "dist/android/server.cjs"
    if not bundle.is_file():
        raise SystemExit("Build the Android Node bundle first")
    with tempfile.TemporaryDirectory(prefix="cli-smoke-") as temporary:
        directory = Path(temporary)
        env = {key: value for key, value in os.environ.items() if not key.startswith("ZCODE")}
        env.update(ZCODE_PROXY_CONFIG=str(directory / "absent" / "config.yaml"),
                   ZCODE_PROXY_STORE_DIR=str(directory / "absent" / "store"), ZCODE_UPDATE_CHECK="off")
        count = 0

        def run(args, status, expected, stderr=False):
            nonlocal count
            result = subprocess.run(["node", str(bundle), *args], cwd=directory, env=env,
                                    input="", text=True, capture_output=True, timeout=10)
            assert result.returncode == status, (args, result.returncode, result.stdout, result.stderr)
            assert expected in (result.stderr if stderr else result.stdout), (args, result.stdout, result.stderr)
            count += 1

        version = json.loads((ROOT / "package.json").read_text())["version"]
        for args in [["--version"], ["-v"], ["version"], ["--cli", "--version"]]:
            run(args, 0, "zcode-proxy " + version)
        for args in [["--help"], ["-h"], ["help"], ["--cli", "help"]]:
            run(args, 0, "Usage:")
        run(["unknown-command"], 1, "Unknown command:", stderr=True)
        run([], 1, "TUI mode needs an interactive terminal", stderr=True)
        run(["--cli", "tui"], 1, "TUI mode needs an interactive terminal", stderr=True)
        run(["serve"], 1, "zcode-proxy: serve failed:", stderr=True)
        run(["--cli", str(directory / "absent" / "custom.yaml")], 1, "zcode-proxy: serve failed:", stderr=True)
        run(["auth", "login"], 1, "Usage:", stderr=True)
        run(["auth", "login", "bigmodel", "--plan=typo"], 1, "Invalid --plan value", stderr=True)
        assert not (directory / "absent").exists(), "CLI unexpectedly initialized config or account storage"
    print(f"CLI: {count} version/help, alias, validation and startup-error checks passed")


if __name__ == "__main__":
    main()
