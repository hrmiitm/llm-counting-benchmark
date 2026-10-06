"""Pinned source/checkpoint setup shared by the two CountGD generations."""
from pathlib import Path
from common import configuration, checkout_source, download, drive_download, install_environment, now, source_hashes, write_json


def setup(folder):
    folder = Path(folder).resolve()
    config = configuration(folder)
    report = {"model": config["model"], "started_at_utc": now(), "status": "running"}
    try:
        checkout_source(folder, config["source"])
        report["environment"] = install_environment(folder, "3.10.19", "https://download.pytorch.org/whl/cpu")
        if "weights_url" in config:
            checkpoint = download(config["weights_url"], folder / config["checkpoint"], config["weights_sha256"])
        else:
            checkpoint = drive_download(folder, config["drive_file_id"], "countgd_plusplus.pth", config.get("weights_sha256"))
        report["assets"] = [checkpoint]
        bert = config["bert"]
        for filename in ("config.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt", "model.safetensors"):
            sha = bert["weights_sha256"] if filename == "model.safetensors" else None
            report["assets"].append(download(
                f"https://huggingface.co/google-bert/bert-base-uncased/resolve/{bert['revision']}/{filename}?download=true",
                folder / "weights/bert-base-uncased" / filename, sha))
        report["source_hashes"] = source_hashes(folder)
        report["implementation_note"] = "CPU uses upstream PyTorch deformable-attention fallback; no CUDA extensions compiled. CUDA requires upstream extension installation."
        report["status"] = "ready"
    except Exception as exc:
        report.update(status="failed", error={"type": type(exc).__name__, "reason": str(exc)})
        raise
    finally:
        report["finished_at_utc"] = now()
        write_json(folder / "setup-report.json", report)
