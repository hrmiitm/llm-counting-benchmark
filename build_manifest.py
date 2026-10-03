"""Discover every eval2 JSON file for static hosting. No API calls."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def build_manifest():
    folder = ROOT / "eval2"
    folder.mkdir(exist_ok=True)
    destination = folder / "manifest.json"
    files = sorted(p.relative_to(ROOT).as_posix() for p in folder.rglob("*.json") if p != destination)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps({"files": files}, indent=2) + "\n")
    temporary.replace(destination)
    print(f"Indexed {len(files)} JSON files in {destination.relative_to(ROOT)}")


if __name__ == "__main__":
    build_manifest()
