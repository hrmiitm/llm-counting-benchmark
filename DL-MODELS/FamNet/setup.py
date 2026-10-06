"""Pinned official FamNet code, weights, and exemplar-only annotation extraction."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ROOT, configuration, checkout_source, digest, download, install_environment, now, source_hashes, write_json

folder = Path(__file__).resolve().parent
config = configuration(folder)
report = {"model": config["model"], "started_at_utc": now(), "status": "running"}
try:
    upstream = checkout_source(folder, config["source"])
    report["environment"] = install_environment(folder, "3.10.19", "https://download.pytorch.org/whl/cpu")
    report["assets"] = [download(config["backbone_url"], folder / ".cache/torch/hub/checkpoints/resnet50-0676ba61.pth")]
    checkpoint = folder / config["checkpoint"]
    report["assets"].append({"file": checkpoint.relative_to(folder.parent).as_posix(),
                             "sha256": digest(checkpoint), "size_bytes": checkpoint.stat().st_size,
                             "url": f"https://raw.githubusercontent.com/{config['source']['repository']}/{config['source']['commit']}/data/pretrainedModels/FamNet_Save1.pth"})
    annotations = json.loads((upstream / "data/annotation_FSC147_384.json").read_text())
    split = json.loads((upstream / "data/Train_Test_Val_FSC_147.json").read_text())
    exemplar_rows = {}
    for row in json.loads((ROOT / "data/group1/metadata.json").read_text()):
        annotation = annotations[row["image"]]
        boxes = []
        for points in annotation["box_examples_coordinates"]:
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            boxes.append([min(ys), min(xs), max(ys), max(xs)])
        if not boxes:
            raise ValueError(f"Missing official exemplar boxes: {row['image']}")
        exemplar_rows[row["image"]] = {"boxes_yxyx": boxes,
            "dataset_split": next((name for name, images in split.items() if row["image"] in images), "unknown")}
    write_json(folder / "exemplars.json", {"source_commit": config["source"]["commit"], "images": exemplar_rows})
    report["exemplars_sha256"] = digest(folder / "exemplars.json")
    report["source_hashes"] = source_hashes(folder)
    report["status"] = "ready"
except Exception as exc:
    report.update(status="failed", error={"type": type(exc).__name__, "reason": str(exc)})
    raise
finally:
    report["finished_at_utc"] = now()
    write_json(folder / "setup-report.json", report)
