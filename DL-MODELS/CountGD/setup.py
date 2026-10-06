import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from detector_setup import setup

if __name__ == "__main__":
    setup(Path(__file__).resolve().parent)
