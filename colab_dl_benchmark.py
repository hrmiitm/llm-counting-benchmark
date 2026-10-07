"""Colab: python colab_dl_benchmark.py [--hourly-cost-usd YOUR_RATE].

Reuses the repository's pinned loaders/predictors, not a new counting recipe.
Only the final colab_dl_results.json is an analysis export; installation locks,
assets and setup provenance stay in the disposable Colab workspace.
"""

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import runpy
import shlex
import shutil
import subprocess
import sys
import sysconfig
import tarfile
from urllib.request import urlretrieve

MODELS = ("CountGD", "CountGD++", "CounTX", "YOLO-World-S")
REPOSITORY = "https://github.com/hrmiitm/llm-counting-benchmark.git"
REVISION = "a3cc30aabcfc999a5f6207ac1b6993ddf7f12f15"
RESULT_MARKER = "COLAB_MODEL_RESULT="
# NVIDIA's immutable CUDA 12.1.1 package channel; matches the GD/CounTX torch build.
CUDA_PACKAGES = {
    "cuda-nvcc-12.1.105-0": "2dadb744089a5326480060bdd7d0c045",
    "cuda-cudart-12.1.105-0": "001823a01c0d49300fd9622c4578eb40",
    "cuda-cudart-dev-12.1.105-0": "accec90e42a0c11db1dd946031f3842f",
    "cuda-cccl-12.1.109-0": "9423b7c1cdaae4bc066eccd4059d833b",
}


def run(*command, **kwargs):
    subprocess.run([str(x) for x in command], check=True, **kwargs)


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def cuda_toolchain(workspace):
    """Only CountGD/GD++ need a compiler. No driver or full Conda install."""
    destination = workspace / "cuda-12.1"
    if not (destination / ".complete").is_file():
        destination.mkdir(parents=True, exist_ok=True)
        for package, checksum in CUDA_PACKAGES.items():
            archive = workspace / f"{package}.tar.bz2"
            if not archive.exists():
                urlretrieve(f"https://conda.anaconda.org/nvidia/label/cuda-12.1.1/linux-64/{archive.name}", archive)
            if hashlib.md5(archive.read_bytes()).hexdigest() != checksum:
                raise RuntimeError(f"NVIDIA package checksum mismatch: {archive.name}")
            with tarfile.open(archive) as handle:
                handle.extractall(destination, filter="data")
        (destination / ".complete").write_text("CUDA 12.1.1 NVIDIA packages\n")
    if not Path("/usr/bin/g++-11").is_file():
        run("apt-get", "update", "-qq")
        run("apt-get", "install", "-y", "--no-install-recommends", "g++-11")
    return {"CUDA_HOME": str(destination), "CC": "/usr/bin/gcc-11", "CXX": "/usr/bin/g++-11",
            "MAX_JOBS": "2"}


def gpu_requirements(folder):
    """Keep every committed package version; replace only CPU PyTorch builds."""
    variant = "cu126" if folder.name == "YOLO-World-S" else "cu121"
    requirements = []
    for line in (folder / "requirements.lock").read_text().splitlines():
        if line and not line[0].isspace() and "==" in line and not line.startswith("#"):
            requirements.append(line.split()[0].replace("+cpu", f"+{variant}"))
    if folder.name in ("CountGD", "CountGD++"):
        requirements.append("wheel==0.45.1")  # Required to build the upstream CUDA extension.
    return requirements, variant


def install_model(folder, uv, env):
    version = "3.12.14" if folder.name == "YOLO-World-S" else "3.10.19"
    python = folder / ".venv/bin/python"
    if not python.exists():
        run(uv, "venv", "--python", version, folder / ".venv", env=env)
    requirements, variant = gpu_requirements(folder)
    source, lock = folder / "requirements.cuda.in", folder / "requirements.cuda.lock"
    source.write_text("\n".join(requirements) + "\n")
    if not lock.exists():
        run(uv, "pip", "compile", source, "--python", python, "--generate-hashes", "-o", lock,
            "--default-index", "https://pypi.org/simple",
            "--extra-index-url", f"https://download.pytorch.org/whl/{variant}",
            "--index-strategy", "unsafe-best-match", env=env)
    run(uv, "pip", "sync", "--require-hashes", "--python", python, lock,
        "--default-index", "https://pypi.org/simple",
        "--extra-index-url", f"https://download.pytorch.org/whl/{variant}",
        "--index-strategy", "unsafe-best-match", env=env)
    return python


def cuda_header_environment(site_packages=None):
    """Expose the CUDA development headers already installed with GPU PyTorch."""
    root = Path(site_packages or sysconfig.get_path("purelib")) / "nvidia"
    includes = sorted(root.glob("*/include"))
    required = ("cusparse.h", "cublas_v2.h", "cusolverDn.h")
    missing = [header for header in required if not any((path / header).is_file() for path in includes)]
    if missing:
        raise RuntimeError(f"Missing NVIDIA wheel headers: {', '.join(missing)}. Reinstall this model's CUDA dependencies.")
    cpath = os.pathsep.join([*(str(path) for path in includes), *([os.environ["CPATH"]] if os.environ.get("CPATH") else [])])
    flags = shlex.join([f"-I{path}" for path in includes])
    if os.environ.get("NVCC_PREPEND_FLAGS"):
        flags += " " + os.environ["NVCC_PREPEND_FLAGS"]
    return {"CPATH": cpath, "NVCC_PREPEND_FLAGS": flags}


def worker(name, repo, warmups):
    """One process per model avoids conflicting timm/OpenCLIP/module versions."""
    sys.path.insert(0, str(repo / "DL-MODELS"))
    import common
    import numpy as np
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. Select a GPU runtime in Google Colab.")
    if name != "YOLO-World-S" and torch.cuda.get_device_capability()[0] > 9:
        raise RuntimeError("This repository's pinned PyTorch 2.2.1 build needs a compatible GPU (e.g. T4/L4/A100), not Blackwell. No settings were substituted.")
    folder = repo / "DL-MODELS" / name
    # The existing setup downloads/checks the same source and checkpoint assets.
    # Dependency installation above is the separate CUDA variant of its CPU lock.
    common.install_environment = lambda *_args, **_kwargs: {
        "python_version_requested": "3.12.14" if name == "YOLO-World-S" else "3.10.19",
        "dependency_lock_sha256": common.digest(folder / "requirements.cuda.lock"),
        "packages": common.packages(),
    }
    # GD/GD++ execute setup only inside their __main__ guards.
    runpy.run_path(str(folder / "setup.py"), run_name="__main__")
    header_env = {}
    if name in ("CountGD", "CountGD++"):
        extension = folder / "upstream/models/GroundingDINO/ops"
        if not (extension / "setup.py").is_file():
            raise RuntimeError(f"Upstream CUDA extension is missing after {name} setup: {extension}")
        header_env = cuda_header_environment()
        run("uv", "pip", "install", "--python", sys.executable, "--no-deps", "--no-build-isolation",
            extension, env={**os.environ, **header_env})
        import MultiScaleDeformableAttention
        assert hasattr(MultiScaleDeformableAttention, "ms_deform_attn_forward")
    report = json.loads((folder / "setup-report.json").read_text())
    report["environment"]["packages"] = common.packages()
    report["cuda_version"] = torch.version.cuda
    report["gpu"] = torch.cuda.get_device_name()
    report["repository_revision"] = REVISION
    report["warmup_iterations"] = warmups
    if header_env:
        report["cuda_build_header_environment"] = header_env
    report["implementation_note"] = "Colab CUDA; original predictor and inference settings; CUDA variant dependency lock."
    common.write_json(folder / "setup-report.json", report)
    common.environment(folder)
    torch.set_num_threads(4)
    random.seed(42); np.random.seed(42); torch.manual_seed(42); torch.cuda.manual_seed_all(42)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    config = common.configuration(folder)
    config["_config_sha256"] = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    spec = importlib.util.spec_from_file_location("colab_model", folder / "run.py")
    runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
    state, _ = runner.load(folder, config, "cuda")
    metadata = json.loads((repo / "data/group1/metadata.json").read_text())
    items = [{key: row[key] for key in ("group", "id", "image", "label")} for row in metadata]
    if len(items) != 6 or len({r["image"] for r in items}) != 6:
        raise ValueError("Expected the six distinct repository benchmark images")
    def predict(item):
        torch.cuda.synchronize()
        with torch.inference_mode():
            result = runner.predict(state, repo / "data/group1" / item["image"], item, folder, config, "cuda")
        torch.cuda.synchronize()
        return result
    for _ in range(warmups):
        predict(items[0])
    images = []
    for item in items:
        result = predict(item)
        # Original synchronized forward timings: GD includes text/image encoders;
        # CounTX includes the sliding-window loop; YOLO profiles its network forward.
        count, seconds = result["count"], result["inference_seconds"]
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0
               for x in (count, seconds)):
            raise ValueError(f"Invalid prediction/timing for {name}: {item['image']}")
        images.append({"image": item["image"], "predicted_count": count, "inference_seconds": seconds})
        print(f"{name}: {item['image']} count={count} forward={seconds:.6f}s", flush=True)
    print(RESULT_MARKER + json.dumps({"gpu": torch.cuda.get_device_name(),
          "result": {"model": name, "images": images}}, allow_nan=False), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", action="append", choices=MODELS)
    parser.add_argument("--hourly-cost-usd", type=float, default=None)
    parser.add_argument("--warmups", type=int, default=2)
    parser.add_argument("--output", type=Path, default=Path("colab_dl_results.json"))
    parser.add_argument("--workspace", type=Path, default=Path("/content/dl-count-workspace"))
    parser.add_argument("--worker", choices=MODELS, help=argparse.SUPPRESS)
    parser.add_argument("--repo", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.warmups < 1: parser.error("Warm-up must be at least one inference")
    if args.hourly_cost_usd is not None and (not math.isfinite(args.hourly_cost_usd) or args.hourly_cost_usd < 0):
        parser.error("Hourly cost must be finite and nonnegative, or omitted")
    if args.worker:
        worker(args.worker, args.repo, args.warmups); return
    if args.output.exists():
        raise SystemExit(f"{args.output} already exists. Choose --output NEW_FILENAME.json to keep earlier measurements.")
    if not shutil.which("nvidia-smi"):
        raise SystemExit("Select Runtime → Change runtime type → GPU in Google Colab first.")
    run("nvidia-smi", "--query-gpu=name", "--format=csv,noheader")
    if not shutil.which("uv"):
        run(sys.executable, "-m", "pip", "install", "uv==0.12.10")
    uv = shutil.which("uv")
    workspace = args.workspace.resolve(); workspace.mkdir(parents=True, exist_ok=True)
    repo = workspace / "repository"
    if not repo.exists(): run("git", "clone", "--filter=blob:none", "--no-checkout", REPOSITORY, repo)
    run("git", "-C", repo, "checkout", "--detach", REVISION)
    run("git", "-C", repo, "diff", "--exit-code", "--", "data/group1", "DL-MODELS/common.py",
        "DL-MODELS/detector.py", *[f"DL-MODELS/{name}/{file}" for name in MODELS for file in ("config.json", "run.py")])
    models = list(dict.fromkeys(args.model or MODELS))
    env = {**os.environ, "CUBLAS_WORKSPACE_CONFIG": ":4096:8", "UV_CACHE_DIR": str(workspace / "uv-cache"),
           "UV_PYTHON_INSTALL_DIR": str(workspace / "python")}
    if any(name in ("CountGD", "CountGD++") for name in models): env.update(cuda_toolchain(workspace))
    document = {"provider": "Google Colab", "gpu": None, "hourly_cost_usd": args.hourly_cost_usd, "models": []}
    for name in models:
        python = install_model(repo / "DL-MODELS" / name, uv, env)
        command = [str(python), str(Path(__file__).resolve()), "--worker", name, "--repo", str(repo), "--warmups", str(args.warmups)]
        process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        result = None
        for line in process.stdout:
            if line.startswith(RESULT_MARKER): result = json.loads(line[len(RESULT_MARKER):])
            else: print(line, end="", flush=True)
        if process.wait() or result is None:
            raise RuntimeError(f"{name} failed. Completed models, if any, remain in {args.output}; no zero counts were fabricated.")
        if document["gpu"] is not None and document["gpu"] != result["gpu"]: raise RuntimeError("GPU changed during the run")
        document["gpu"] = result["gpu"]; document["models"].append(result["result"])
        write_json(args.output, document)
    print(f"Saved {args.output.resolve()} (no LLM calls, no scoring, no assumed price).")


if __name__ == "__main__":
    main()
