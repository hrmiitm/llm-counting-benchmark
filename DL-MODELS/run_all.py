"""Set up/run each local model sequentially; no inference API or credentials."""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS = ("YOLO-World-S", "FamNet", "CounTX", "CountGD", "CountGD++")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", action="store_true", help="Download/install before each model run")
    parser.add_argument("--model", choices=MODELS, action="append", help="Run selected models only")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    failures = []
    for name in args.model or MODELS:
        folder = ROOT / name
        if args.setup:
            setup = subprocess.run([sys.executable, str(folder / "setup.py")])
            if setup.returncode:
                failures.append(f"{name}: setup")
        python = folder / ".venv/bin/python"
        # The standard-library harness can write a blocked result even if the
        # model environment has not been installed successfully.
        run = subprocess.run([str(python) if python.exists() else sys.executable,
                              str(folder / "run.py"), "--device", args.device])
        if run.returncode:
            failures.append(f"{name}: inference")
    print("All model runs completed" if not failures else "Failures: " + "; ".join(failures))
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
