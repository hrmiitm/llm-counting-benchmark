"""Install the official OpenCLIP fork and apply its documented timm fix."""
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import configuration, checkout_source, digest, drive_download, install_environment, now, source_hashes, write_json

folder = Path(__file__).resolve().parent
config = configuration(folder)
report = {"model": config["model"], "started_at_utc": now(), "status": "running"}
try:
    upstream = checkout_source(folder, config["source"])
    report["environment"] = install_environment(folder, "3.10.19", "https://download.pytorch.org/whl/cpu")
    python = folder / ".venv/bin/python"
    subprocess.run(["uv", "pip", "install", "--python", str(python), "--no-deps", "--no-build-isolation", str(upstream / "open_clip")],
                   env={**__import__("os").environ, "UV_CACHE_DIR": str(folder.parent / ".cache/uv")}, check=True)
    timm_dir = Path(subprocess.check_output([str(python), "-c", "import importlib.util; print(next(iter(importlib.util.find_spec('timm').submodule_search_locations)))"], text=True).strip())
    (timm_dir / "models/layers/helpers.py").write_bytes((upstream / "helpers.py").read_bytes())
    # The complete paper checkpoint contains CLIP too. Skip redundant pretrained
    # initialization/download, then require a strict full state-dict load in run.py.
    model_file = upstream / "models_reproduce_paper.py"
    old = 'pretrained="laion2b_s34b_b88k"'
    contents = model_file.read_text()
    if old in contents:
        if contents.count(old) != 1:
            raise ValueError("Unexpected pretrained initialization site")
        model_file.write_text(contents.replace(old, 'pretrained=None'))
    position_file = upstream / "util/pos_embed.py"
    position_file.write_text(position_file.read_text().replace("dtype=np.float)", "dtype=float)"))
    report["compatibility_changes"] = ["Official README timm helpers.py replacement", "Replace removed np.float alias with builtin float", "Skip redundant CLIP initialization; full checkpoint is loaded strictly"]
    report["assets"] = [drive_download(folder, config["drive_file_id"], "paper-model.pth", config.get("weights_sha256"))]
    report["source_hashes"] = source_hashes(folder)
    report["timm_helpers_sha256"] = digest(timm_dir / "models/layers/helpers.py")
    report["status"] = "ready"
except Exception as exc:
    report.update(status="failed", error={"type": type(exc).__name__, "reason": str(exc)})
    raise
finally:
    report["finished_at_utc"] = now()
    write_json(folder / "setup-report.json", report)
