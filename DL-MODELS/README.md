# Local deep-learning counting models

Five isolated runners on the six images in `../data/group1`. They make no LLM
API calls and do not read `.env`. Models run sequentially. The current machine
has no working CUDA driver, so CPU is the default.

| Folder | Inputs | Inference path |
| --- | --- | --- |
| `YOLO-World-S/` | Image + unchanged text label | Ultralytics YOLOv8s-World v2, confidence 0.25, 640-pixel input; known-positive control |
| `FamNet/` | Image + all supplied official exemplar boxes | Official ResNet50/matching/density path; no adaptation |
| `CounTX/` | Image + unchanged text label | Official paper checkpoint and 384-pixel sliding windows; density divided by 60 |
| `CountGD/` | Image + unchanged text label | Whole-image text-only, 800/1333 resize, confidence 0.23 |
| `CountGD++/` | Image + unchanged positive text label | Whole-image text-only, confidence 0.23; no negative examples, pseudo-exemplars, adaptive crops or super-resolution |

These are specifically recorded configurations, not claims to reproduce every
paper's best evaluation recipe. FamNet's examples provide extra visual input;
compare that setting separately from text-only inference.

## Setup and run

Install [uv](https://docs.astral.sh/uv/) and `curl`. From the repository root:

```bash
python3 DL-MODELS/YOLO-World-S/setup.py
DL-MODELS/YOLO-World-S/.venv/bin/python DL-MODELS/YOLO-World-S/run.py

python3 DL-MODELS/FamNet/setup.py
DL-MODELS/FamNet/.venv/bin/python DL-MODELS/FamNet/run.py

python3 DL-MODELS/CounTX/setup.py
DL-MODELS/CounTX/.venv/bin/python DL-MODELS/CounTX/run.py

python3 DL-MODELS/CountGD/setup.py
DL-MODELS/CountGD/.venv/bin/python DL-MODELS/CountGD/run.py

python3 'DL-MODELS/CountGD++/setup.py'
'DL-MODELS/CountGD++/.venv/bin/python' 'DL-MODELS/CountGD++/run.py'
```

Alternatively, `python3 DL-MODELS/run_all.py --setup` installs and runs each in
that order. Omit `--setup` to use existing environments. `--model FamNet` selects
one model. Runners accept `--device cpu`, `--threads 4`, `--output PATH`, and an
optional `--compute-hourly-usd RATE`.

YOLO uses Python 3.12.14; the other models use Python 3.10.19. Each environment
has an exact, hash-checked `requirements.lock`. `requirements.in` specifies the
direct dependencies. To deliberately change dependencies, update that file and
regenerate its lock with the command documented in the lock's header; do not
silently substitute newer packages.

The committed locks install **CPU PyTorch builds**. `--device cuda` fails when a
working CUDA installation is absent. To build a GPU variant, use a separate
environment/lock for CUDA PyTorch and record it as a separate configuration.
CountGD/CountGD++ also need their upstream CUDA deformable-attention extension
for GPU execution. CPU uses the upstream mathematical PyTorch implementation.

## Results and reproducibility

### Minimal Colab CUDA export

Upload the standalone root `colab_dl_benchmark.py` file to a Colab GPU runtime.
It checks out benchmark commit `a3cc30aabcfc999a5f6207ac1b6993ddf7f12f15`,
reuses its original loaders/predictors/configs and the six curated images,
and runs CountGD, CountGD++ and CounTX sequentially. FamNet is
not installed or benchmarked. Conflicting package versions are isolated.
The committed package versions are retained with CUDA PyTorch variants:
2.2.1/cu121 for all three models. The GD extension is built
with NVIDIA's CUDA 12.1 compiler and GCC 11. Two untimed target-image warm-ups
precede each model's six measurements. Existing forward-timing scopes are
preserved, with CUDA synchronization; startup, warm-up, disk artifacts and
other work outside those scopes are not priced as inference.
Seed 42 and deterministic implementations are preferred. Unsupported CUDA
operations warn instead of failing: PyTorch 2.2.1 cannot enforce determinism
for the floating-point `cumsum` used by GD positional encoding. The predictor
code, counting recipe, precision and thresholds are unchanged; bitwise GPU repeatability
is not guaranteed. This policy is recorded in the workspace setup report.
The script sets `MPLBACKEND=Agg` and discovers the installed CUDA library
headers automatically. It prints setup/warm-up/inference phases rather than
the full generated dependency lock.

Colab cells (first choose **Runtime → Change runtime type → GPU**):
after committing/pushing the latest script to GitHub, update and run from one
fixed checkout (this avoids repeatedly cloning inside the previous checkout):

```python
from pathlib import Path
import subprocess

repo = Path("/content/llm-counting-benchmark")
if (repo / ".git").exists():
    subprocess.run(["git", "-C", str(repo), "pull", "--ff-only"], check=True)
else:
    subprocess.run(["git", "clone", "https://github.com/hrmiitm/llm-counting-benchmark.git", str(repo)], check=True)
```

```python
!python /content/llm-counting-benchmark/colab_dl_benchmark.py --output /content/colab_dl_results.json
```

```python
import json
from google.colab import files
with open("/content/colab_dl_results.json") as handle:
    result = json.load(handle)
assert {m["model"] for m in result["models"]} == {"CountGD", "CountGD++", "CounTX"}
assert all(len(m["images"]) == 6 for m in result["models"])
files.download("/content/colab_dl_results.json")
```

In an already-cloned checkout, use `!git pull --ff-only` instead of cloning
again. If the new script has not yet been pushed, upload it directly as follows:

```python
from google.colab import files
files.upload()  # Select colab_dl_benchmark.py only.
```

```python
!python colab_dl_benchmark.py
# Only if you explicitly know the rate:
# !python colab_dl_benchmark.py --hourly-cost-usd YOUR_RATE
```

```python
files.download("colab_dl_results.json")
```

For notebook imports, `from colab_dl_benchmark import main; main([])` also
works. `--model` is repeatable to install/run a subset. The compact export
contains only provider, actual GPU name, nullable hourly rate, model names,
image filenames, unrounded predictions and inference seconds. Installation
locks/assets/setup provenance remain in the disposable Colab workspace,
not in the analysis export. A failed model raises an error; completed models
remain saved, and no failed prediction becomes zero. The pinned older Torch
build requires a compatible GPU such as T4/L4/A100; Blackwell fails explicitly.
Use `--output NEW_FILENAME.json` for another run; existing exports are not overwritten.

Enter a rate with the flag above or edit the top-level `hourly_cost_usd` in
the exported JSON before importing. No price is assumed or looked up.
After downloading the file, run from this repository's root:

```bash
node scripts/import-colab-dl.mjs colab_dl_results.json
```

The command validates each model's exact six-image set, prints per-image
deviation and model summaries, and copies the raw file unchanged to
`eval4/colab-dl.json`. Scoring uses `eval2/metadata.json`; mean deviation
weights images equally and does not round density predictions.
Compute estimate = total inference seconds / 3600 * supplied hourly rate.
Cost/image = estimate / 6; cost/1,000 = cost/image * 1,000. All costs remain
null without a supplied rate. Page 4 discovers the new source automatically
and includes priced DL points in cost/error, plus an optional mean-deviation
quality comparison even without a rate. DL models have no reasoning levels
or count confidence and remain excluded from confidence/coverage summaries.

Page 4's **DL compute rate** dropdown offers saved JSON rates, reference
AWS/Azure/GCP T4 instance rates, and a custom USD/hour input. NVIDIA has no
verified comparable public T4 rate, so enter any quoted rate with Custom.
The initial view uses the labelled Azure T4 reference rate and a logarithmic
cost axis so all three DL points appear without editing their nullable saved
rate. DL points have model labels; their cost and mean deviation are also
shown below the graph. Explicit URL filters and saved-rate selections remain
available.
Rates and source links live in root `dl-pricing.json`; these are dated
reference scenarios, not live cloud quotes. Presets require a measured T4.
Changing the rate updates DL costs, rankings and per-image estimates only;
saved JSON, counting error and LLM API charges remain unchanged. The chosen
scenario is included in the page URL and survives refresh. CPU work still
handles image loading, tokenization and artifacts; CUDA forward timing does
not imply an exclusively GPU pipeline or 100% GPU utilization.
The original CPU results and LLM data are unchanged. Publish the imported
JSON through the existing Pages workflow to update the public graphs.

Offline checks (no CUDA/model/API calls):

```bash
python3 -m unittest discover -s scripts -p test_colab_dl.py
node scripts/colab-dl-data-test.mjs
```

All five result envelopes are written to **`DL-MODELS/results/`**, one JSON per
model. The website's `eval2/` data and original LLM pilot are not changed.

- `config.json`: model identity, immutable upstream revision, checkpoint source,
  prompts/input mode, preprocessing, thresholds and optional features.
- `setup-report.json`: setup status, resolved environment, downloaded asset
  SHA256/size/source, source-code hashes and any compatibility changes.
- `results/MODEL.json`: effective configuration/hash, software/hardware, setup
  timing and six prediction rows. Each row includes input SHA256, count, forward
  timing, total latency, status, and raw model output.
- `results/artifacts/`: raw density arrays for FamNet/CounTX, with hashes in JSON.
  Object detectors store boxes/scores directly in JSON.
- `.venv`, `upstream`, `weights` and `.cache`: ignored installation files and
  downloaded official code/weights. Upstream license files are retained there.

Inference runs offline after setup. Source files/assets are verified before
loading. Every inference parameter must load strictly; CounTX's historical
`shot_token` entry, absent from the official paper-inference architecture, is
explicitly excluded and recorded. CountGD++'s official app also omits the unused
training `feature_map_encoder`; only its 38 explicitly named checkpoint entries
are excluded. The training forward call is commented out in the pinned source.
Other unexpected/missing keys fail. Failures are
recorded with null counts, not converted to zero. A `success` status means the
pipeline completed, not that the prediction is accurate.

YOLO/CLIP and the HF CountGD/BERT assets have independently supplied hashes.
Google Drive checkpoints are fetched from authors' published links; their first
observed hashes are recorded. An observed hash proves repeatability of those
bytes, not independent authenticity. Preserve verified hashes for reruns.

Count confidence stays `null`: no model supplies a calibrated P(exact count).
Detection scores are separate. Density estimates stay floating point without
rounding or clamping. API cost is zero; compute cost stays unknown unless a rate
is supplied. The rate estimates timed per-image work, excluding startup/idle
time and annotation. First-forward overhead is possible unless warmup is
explicitly recorded. Timing depends on hardware and current system load.

Rerunning the same configuration replaces that model's current result. Changing
configuration archives the previous JSON under `results/history/`. Use `--output`
to retain independent runs explicitly. Gold counts and point annotations never
enter model predictions or result rows.

## Dataset limits

`dataset-info.json` records the official split: bottle caps/books are validation;
buffaloes/bricks/cement bags are training; stamps is test. Thus this six-image
pilot is **not an independent held-out evaluation** for FSC-147-trained models.
FamNet's `exemplars.json` contains boxes only, extracted from official annotations
without counts/dots. Books has five provided exemplars; the others have three.

## Official sources

- [FSC-147 and FamNet](https://github.com/cvlab-stonybrook/LearningToCountEverything)
- [CounTX](https://github.com/niki-amini-naieni/CounTX)
- [CountGD](https://github.com/niki-amini-naieni/CountGD)
- [CountGD++](https://github.com/niki-amini-naieni/CountGDPlusPlus)
- [YOLO-World](https://docs.ultralytics.com/models/yolo-world/)

## Verification

Run `python3 DL-MODELS/audit.py` to validate saved JSON, source/configuration and
input/output hashes, count semantics, row completeness, and absence of gold
counts. Model inference is the integration check; audit makes no network calls.
