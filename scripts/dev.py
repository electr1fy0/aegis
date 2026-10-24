"""Start both local services and stop both when either exits or Ctrl-C is pressed."""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    bun = shutil.which("bun")
    if bun is None:
        print("Bun is required. Run make setup after installing Bun.", file=sys.stderr)
        return 1
    processes: list[subprocess.Popen] = []
    try:
        processes.append(subprocess.Popen([sys.executable, "-m", "backend.aegis"], cwd=root))
        processes.append(subprocess.Popen([bun, "run", "dev"], cwd=root / "frontend"))
        while all(process.poll() is None for process in processes):
            time.sleep(0.2)
        return next(process.returncode for process in processes if process.returncode is not None)
    except KeyboardInterrupt:
        return 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    raise SystemExit(main())
