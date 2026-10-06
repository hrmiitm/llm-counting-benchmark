import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import benchmark
from detector import load, predict

if __name__ == "__main__":
    raise SystemExit(benchmark(Path(__file__).resolve().parent, load, predict))
