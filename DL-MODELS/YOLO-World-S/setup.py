"""Download verified official weights and install an isolated, locked environment."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import configuration, download, install_environment, now, write_json

folder = Path(__file__).resolve().parent
config = configuration(folder)
report = {"model": config["model"], "started_at_utc": now(), "status": "running"}
try:
    report["environment"] = install_environment(folder, "3.12.14", "https://download.pytorch.org/whl/cpu")
    report["assets"] = [download(config["weights_url"], folder / config["checkpoint"], config["weights_sha256"]),
                        download(config["clip_url"], folder / "weights/clip/ViT-B-32.pt", config["clip_sha256"]),
                        download(config["control_url"], folder / "weights/control-bus.jpg", config["control_sha256"])]
    report["status"] = "ready"
except Exception as exc:
    report.update(status="failed", error={"type": type(exc).__name__, "reason": str(exc)})
    raise
finally:
    report["finished_at_utc"] = now()
    write_json(folder / "setup-report.json", report)
