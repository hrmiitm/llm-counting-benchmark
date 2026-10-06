"""Read-only validation of configuration/result provenance; no model calls."""
import hashlib
import json
import math
from pathlib import Path
from common import DL_ROOT, ROOT, digest

MODELS = ("YOLO-World-S", "FamNet", "CounTX", "CountGD", "CountGD++")


def no_gold(value):
    if isinstance(value, dict):
        assert "actual-count" not in value and "gt_count" not in value
        for child in value.values():
            no_gold(child)
    elif isinstance(value, list):
        for child in value:
            no_gold(child)


def main():
    metadata = json.loads((ROOT / "data/group1/metadata.json").read_text())
    identifiers = {(r["group"], r["image"]) for r in metadata}
    complete = True
    for name in MODELS:
        path = DL_ROOT / "results" / f"{name}.json"
        assert path.exists(), f"Missing result: {path}"
        document = json.loads(path.read_text())
        no_gold(document)
        config = document["configuration"]
        expected = json.loads((DL_ROOT / name / "config.json").read_text())
        assert {k: v for k, v in config.items() if k != "runtime"} == expected, f"Stale configuration: {name}"
        calculated = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
        assert calculated == document["config_sha256"]
        assert document["common_sha256"] == digest(DL_ROOT / "common.py"), f"Stale harness: {name}"
        assert document["runner_sha256"] == digest(DL_ROOT / name / "run.py")
        assert all(digest(DL_ROOT / path) == sha for path, sha in document["shared_code_sha256"].items())
        assert len(document["results"]) == 6
        assert {(r["group"], r["image"]) for r in document["results"]} == identifiers
        for row in document["results"]:
            assert row["image_sha256"] == digest(ROOT / "data/group1" / row["image"])
            assert row["confidence"] is None
            if row["status"] != "success":
                assert row["model_count"] is None and row.get("error")
                complete = False
                continue
            count = row["model_count"]
            assert math.isfinite(count) and count >= 0
            assert row["latency_seconds"] > 0 and row["inference_seconds"] > 0
            assert row["api_cost_usd"] == 0
            rate = config["runtime"]["compute_hourly_usd"]
            if rate is None:
                assert row["cost_usd"] is None
            else:
                assert math.isclose(row["cost_usd"], row["latency_seconds"] * rate / 3600)
            raw = row["raw_response"]
            if "detections" in raw:
                assert count == len(raw["detections"])
                assert all(0 <= box["score"] <= 1 and len(box["xyxy"]) == 4 for box in raw["detections"])
            if "density_map" in raw:
                assert digest(DL_ROOT / raw["density_map"]) == raw["density_sha256"]
        print(f"{name}: {document['status']}, six rows validated")
    if not complete:
        print("One or more models failed; counts remain unavailable for those rows")
    return int(not complete)


if __name__ == "__main__":
    raise SystemExit(main())
