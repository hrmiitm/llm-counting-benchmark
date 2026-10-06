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
