"""Shared local-run bookkeeping. No credentials, API requests or gold scoring."""

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import random
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

DL_ROOT = Path(__file__).resolve().parent
ROOT = DL_ROOT.parent


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
    tmp.replace(path)


def configuration(folder):
    return json.loads((Path(folder) / "config.json").read_text())


def environment(folder):
    cache = Path(folder) / ".cache"
    for name, directory in {"HF_HOME": "huggingface", "TORCH_HOME": "torch",
                            "MPLCONFIGDIR": "matplotlib", "YOLO_CONFIG_DIR": "ultralytics"}.items():
        path = cache / directory
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"


def packages():
    return {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()
            if d.metadata.get("Name")}


def download(url, destination, expected_sha256=None):
    """Atomic download; verify a publisher hash when supplied, always record hash."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        temp = destination.with_suffix(destination.suffix + ".part")
        subprocess.run(["curl", "-f", "-sS", "-L", "--continue-at", "-", "--retry", "3", "--connect-timeout", "30",
                        "--speed-time", "60", "--speed-limit", "1024",
                        "--max-time", "1800", url, "-o", str(temp)], check=True)
        if expected_sha256 and digest(temp) != expected_sha256:
            raise ValueError(f"Publisher checksum mismatch: {destination.name}")
        temp.replace(destination)
    actual = digest(destination)
    if expected_sha256 and actual != expected_sha256:
        raise ValueError(f"Publisher checksum mismatch: {destination.name}")
    return {"url": url, "file": destination.relative_to(DL_ROOT).as_posix(),
            "sha256": actual, "size_bytes": destination.stat().st_size,
            "publisher_hash_verified": bool(expected_sha256)}


def timed_forward(torch, device, function):
    if device == "cuda":
        torch.cuda.synchronize()
    start = time.perf_counter()
    with torch.inference_mode():
        result = function()
    if device == "cuda":
        torch.cuda.synchronize()
    return result, time.perf_counter() - start


def install_environment(folder, python_version, extra_index=None):
    """Compile once, then install the committed exact dependency lock."""
    folder = Path(folder)
    cache_env = {**os.environ, "UV_CACHE_DIR": str(DL_ROOT / ".cache/uv"),
                 "UV_PYTHON_INSTALL_DIR": str(DL_ROOT / ".cache/python")}
    lock = folder / "requirements.lock"
    if not lock.exists():
        command = ["uv", "pip", "compile", str(folder / "requirements.in"),
                   "--python-version", python_version, "--generate-hashes", "-o", str(lock)]
        if extra_index:
            command += ["--extra-index-url", extra_index, "--index-strategy", "unsafe-best-match"]
        subprocess.run(command, env=cache_env, check=True, stdout=subprocess.DEVNULL)
    venv = folder / ".venv"
    if not (venv / "bin/python").exists():
        subprocess.run(["uv", "venv", "--python", python_version, str(venv)], env=cache_env, check=True)
    command = ["uv", "pip", "sync", "--require-hashes", "--python", str(venv / "bin/python"), str(lock)]
    if extra_index:
        command += ["--extra-index-url", extra_index, "--index-strategy", "unsafe-best-match"]
    subprocess.run(command, env=cache_env, check=True)
    installed = subprocess.check_output([str(venv / "bin/python"), "-c",
        "import importlib.metadata,json;print(json.dumps({d.metadata['Name']:d.version for d in importlib.metadata.distributions() if d.metadata.get('Name')}))"], text=True)
    return {"python_version_requested": python_version, "dependency_lock_sha256": digest(lock),
            "packages": json.loads(installed)}


def checkout_source(folder, source):
    folder = Path(folder)
    upstream = folder / "upstream"
    marker = folder / ".cache/source-commit.txt"
    if upstream.exists():
        if not marker.exists() or marker.read_text().strip() != source["commit"]:
            raise RuntimeError("Existing upstream checkout has a different commit; use a fresh model folder")
        return upstream
    archive = folder / ".cache/source.tar.gz"
    download(f"https://codeload.github.com/{source['repository']}/tar.gz/{source['commit']}", archive)
    staging = folder / ".cache/extracted"
    staging.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as handle:
        handle.extractall(staging, filter="data")
    entries = list(staging.iterdir())
    if len(entries) != 1 or not entries[0].is_dir():
        raise RuntimeError("Unexpected source archive layout")
    entries[0].replace(upstream)
    marker.write_text(source["commit"] + "\n")
    return upstream


def source_hashes(folder):
    folder = Path(folder)
    return {p.relative_to(folder).as_posix(): digest(p)
            for p in sorted((folder / "upstream").rglob("*.py"))}


def drive_download(folder, file_id, filename, expected_sha256=None):
    destination = Path(folder) / "weights" / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        part = destination.with_suffix(destination.suffix + ".part")
        subprocess.run([str(Path(folder) / ".venv/bin/python"), str(DL_ROOT / "download_drive.py"),
                        file_id, str(part)], check=True, timeout=1200)
        if expected_sha256 and digest(part) != expected_sha256:
            raise ValueError("Pinned weight checksum mismatch")
        part.replace(destination)
    actual = digest(destination)
    if expected_sha256 and actual != expected_sha256:
        raise ValueError("Pinned weight checksum mismatch")
    return {"url": f"https://drive.google.com/file/d/{file_id}/view",
            "file": destination.relative_to(DL_ROOT).as_posix(), "sha256": actual,
            "size_bytes": destination.stat().st_size, "publisher_hash_verified": False}


def verify_setup(folder, report):
    expected = report["environment"]
    if digest(Path(folder) / "requirements.lock") != expected["dependency_lock_sha256"]:
        raise RuntimeError("Dependency lock changed after setup")
    installed = packages()
    for name, version in expected["packages"].items():
        if installed.get(name) != version:
            raise RuntimeError(f"Environment drift for {name}; rerun setup.py")
    if "exemplars_sha256" in report:
        if digest(Path(folder) / "exemplars.json") != report["exemplars_sha256"]:
            raise RuntimeError("Exemplar annotations changed after setup")
    for path, expected in report.get("source_hashes", {}).items():
        if digest(Path(folder) / path) != expected:
            raise RuntimeError(f"Modified pinned source file: {path}")
    for asset in report.get("assets", []):
        if digest(DL_ROOT / asset["file"]) != asset["sha256"]:
            raise RuntimeError(f"Modified/missing downloaded asset: {asset['file']}")


def benchmark(folder, load_model, predict):
    folder = Path(folder).resolve()
    config = configuration(folder)
    parser = argparse.ArgumentParser(description=f"Run {config['model']} on six Group 1 images")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--compute-hourly-usd", type=float)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads must be positive")
    if args.compute_hourly_usd is not None and (not math.isfinite(args.compute_hourly_usd)
                                               or args.compute_hourly_usd < 0):
        parser.error("--compute-hourly-usd must be finite and nonnegative")
    environment(folder)
    destination = args.output or DL_ROOT / "results" / f"{folder.name}.json"
    run_id = now()
    items = json.loads((ROOT / "data/group1/metadata.json").read_text())
    # Counts/dot annotations are never supplied to the predictor.
    items = [{key: row[key] for key in ("group", "id", "image", "label")} for row in items]
    if len(items) != 6 or len({r["image"] for r in items}) != 6:
        raise ValueError("Expected six distinct Group 1 images")
    for item in items:
        item["image_sha256"] = digest(ROOT / "data/group1" / item["image"])
    config["runtime"] = {"device": args.device, "threads": args.threads, "seed": 42,
                         "deterministic_algorithms": True,
                         "inputs_sha256": hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest(),
                         "requirements_lock_sha256": digest(folder / "requirements.lock") if (folder / "requirements.lock").is_file() else None,
                         "runner_sha256": digest(folder / "run.py"), "common_sha256": digest(__file__),
                         "detector_sha256": digest(DL_ROOT / "detector.py") if folder.name in ("CountGD", "CountGD++") else None,
                         "compute_hourly_usd": args.compute_hourly_usd}
    if "exemplars" in config:
        exemplar_file = folder / config["exemplars"]
        config["runtime"]["exemplars_sha256"] = digest(exemplar_file) if exemplar_file.is_file() else None
    config_hash = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    if destination.exists():
        old = json.loads(destination.read_text())
        if old.get("config_sha256") != config_hash:
            archive = destination.parent / "history" / folder.name / f"{old['run_id'].replace(':', '-')}.json"
            write_json(archive, old)
    document = {"schema_version": 1, "run_id": run_id, "model": config["model"],
                "model_temp": None, "model_type": "deep learning", "configuration": config,
                "config_sha256": config_hash, "prompt_version": config_hash,
                "prompt": config["input_mode"], "confidence_scale": "0-1",
                "confidence_note": "P(exact count) unavailable; object scores are separate.",
                "cost_note": "No inference API calls. Compute estimate prices per-image latency only; excludes setup/idle time and is not a hosting invoice.",
                "timing_note": "Setup includes load/hash verification. Per-image latency includes image loading, preprocessing, prompt encoding, model forward, postprocessing and artifact saving. inference_seconds measures the forward path separately. First image can include a cold forward unless warmup is recorded.",
                "provider_endpoint": f"local-{args.device}", "tools": [],
                "reasoning": {"enabled": False}, "status": "initializing",
                "hardware": {"platform": platform.platform(), "architecture": platform.machine()},
                "runner_sha256": digest(folder / "run.py"),
                "common_sha256": digest(__file__), "results": []}
    document["shared_code_sha256"] = {p.name: digest(p) for p in DL_ROOT.glob("*.py")}
    setup_report = folder / "setup-report.json"
    if setup_report.exists():
        document["setup"] = json.loads(setup_report.read_text())
    split_file = DL_ROOT / "dataset-info.json"
    if split_file.exists():
        document["dataset"] = json.loads(split_file.read_text())
    write_json(destination, document)
    start = time.perf_counter()
    try:
        import numpy as np
        import torch
        torch.set_num_threads(args.threads)
        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but no working CUDA GPU is available")
        random.seed(42)
        np.random.seed(42)
        torch.manual_seed(42)
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.benchmark = False
        if args.device == "cuda":
            torch.cuda.manual_seed_all(42)
            document["hardware"]["gpu"] = torch.cuda.get_device_name()
        document["software"] = {"python": platform.python_version(), "packages": packages()}
        if not setup_report.exists() or document["setup"].get("status") != "ready":
            raise RuntimeError("Model setup is not ready; run its setup.py first")
        verify_setup(folder, document["setup"])
        state, provenance = load_model(folder, config, args.device)
        document["provenance"] = provenance
        document["setup_seconds"] = time.perf_counter() - start
        document["status"] = "running"
    except Exception as exc:
        document.update(status="setup_failed", setup_seconds=time.perf_counter() - start,
                        error={"type": type(exc).__name__, "reason": str(exc)})
        document["results"] = [{**item, "model": config["model"], "model_temp": None,
                                "model_count": None, "confidence": None, "cost_usd": None,
                                "latency_seconds": None, "inference_seconds": None,
                                "status": "blocked", "error": document["error"]} for item in items]
        write_json(destination, document)
        print(f"Setup failed; see {destination}: {exc}", flush=True)
        return 1
    for item in items:
        row = {**item, "run_id": run_id, "model": config["model"], "model_temp": None,
               "status": "failed", "started_at_utc": now(), "model_count": None,
               "confidence": None, "cost_usd": None, "api_cost_usd": 0,
               "latency_seconds": None, "inference_seconds": None}
        start = time.perf_counter()
        try:
            result = predict(state, ROOT / "data/group1" / item["image"], item, folder,
                             {**config, "_config_sha256": config_hash}, args.device)
            count = result.pop("count")
            if isinstance(count, bool) or not isinstance(count, (int, float)) or not math.isfinite(count) or count < 0:
                raise ValueError("Invalid predicted count")
            row.update(status="success", model_count=count,
                       inference_seconds=result.pop("inference_seconds", None), raw_response=result)
        except Exception as exc:
            row["error"] = {"type": type(exc).__name__, "reason": str(exc)}
        if args.device == "cuda":
            torch.cuda.synchronize()
        row["latency_seconds"] = time.perf_counter() - start
        row["finished_at_utc"] = now()
        if args.compute_hourly_usd is not None:
            row["cost_usd"] = row["latency_seconds"] * args.compute_hourly_usd / 3600
        document["results"].append(row)
        write_json(destination, document)
        print(f"{folder.name}: {item['label']} | {row['status']} | count={row['model_count']} | {row['latency_seconds']:.3f}s", flush=True)
    document["status"] = "success" if all(r["status"] == "success" for r in document["results"]) else "partial_failure"
    document["finished_at_utc"] = now()
    write_json(destination, document)
    return int(document["status"] != "success")
