# LLM Counting Benchmark

## Start here

The latest workflow is `main3.py` → `eval2/` → the static website. Read
`README.md`, `main3.py`, `eval2/manifest.json`, `eval2/metadata.json`, and the
relevant HTML/JS/CSS before changing results, findings, or the website.
`main.py`, `main2.py`, `count_image.py`, `count_image2.py`, and `eval/` are earlier
experiments, not the current website's default data source.

## Current project layout

- `main3.py`: OpenAI SDK requests through the configured OpenRouter-compatible
  endpoint; model list is `MODELS`, endpoint pins are `PROVIDERS`.
- `smoke_test.py`: one Group 1 image per enabled model using `main3.py`;
  writes to `eval2/smoke-test/`. This makes real, billable API calls.
- `data/group1/`: six current pilot images and input `metadata.json`.
  `data/group2/` retains six samples for earlier experiments.
- `eval2/`: tracked per-model result envelopes with a `results` array.
  `metadata.json` supplies website scoring counts; `manifest.json` indexes JSON
  files for static hosts. `failures.jsonl` logs failures/skips when a run occurs.
- `index.html`, `story.js`, `story.css`: narrative for the saved original pilot.
- `compare.html`, `app.js`, `charts.js`, `styles.css`: explorer for all discovered
  `eval2/` JSON, including subfolders, older arrays, and metadata arrays.
- `theme.js`, `theme.css`, `navigation.css`: shared themes and navigation.
  `vendor/d3.min.js` is used by the story cost chart; keep its license.
- `build_manifest.py`: recursively rebuilds `eval2/manifest.json`; no API calls.
- `scripts/story-browser-test.mjs`, `scripts/browser-test.mjs`,
  `scripts/audit-results.mjs`: browser verification against saved data.
- `eval/` and `eval2/` include tracked public results; neither is globally ignored.
  The full `FSC147_384_V2/` download is ignored; keep the curated samples.

## Dataset attribution and scoring

- Images come from FSC-147 / Learning To Count Everything (CVPR 2021), by
  Viresh Ranjan, Udbhav Sharma, Thu Nguyen, and Minh Hoai.
- Official source: https://github.com/cvlab-stonybrook/LearningToCountEverything#dataset-download
- Image archive: https://drive.google.com/file/d/1ymDYrGs9DSRicfZbSCDiOu0ikGDh5k6S/view?usp=sharing
- Paper: https://arxiv.org/abs/2104.08391
- `data/data_source.txt` records the original direct download URL with the same
  file ID. Keep attribution and clickable source links in both pages and README.
- The website scores against supplied `actual-count` values in
  `eval2/metadata.json`, joined by group and image. Do not describe these as
  independently audited or replace them based on model predictions.
- The pilot is six selected Group 1 images, not the full FSC-147 benchmark.
  Confidence is P(exact count), in 0–1; exact matching gives no credit for close counts.
  Mean absolute percentage deviation weights images equally and excludes zero
  ground truth/missing predictions. Missing costs stay unknown, not zero.

## Configuration and API safety

- Load `BASE_URL` and `API_KEY` from `.env` using `python-dotenv`.
  `main3.py` accepts a base URL with or without `/chat/completions`.
- Never print, commit, expose, or publish the API key or `.env`.
  Keep `.env.example` as the credential template; retain log/result redaction.
- Do not run `main3.py`, `smoke_test.py`, or older benchmark scripts unless the
  user asks for those billable calls. Website preview and syntax checks need none.
- Current settings: nine models, six images, strict JSON count/confidence,
  low reasoning effort, 4,096-token cap, temperature 0 for non-GPT models,
  temperature omitted (`model_temp: null`) for GPT models, no tools/plugins,
  no SDK retries, and one pinned provider per model with no fallbacks.
  Treat saved result configurations as evidence of a past run, not current availability.

## Development rules

- Keep scripts small and dependency-light; use the standard library where practical.
- `main3.py` takes only `group`, `id`, `image`, and `label` from input metadata.
  Never send or copy `actual-count` into its requests/results, or calculate
  accuracy/calibration there. The website joins ground truth and calculates scores.
  Earlier runners may preserve full metadata; do not apply that rule to `main3.py`.
- Preserve saved prediction, confidence, usage, raw response, configuration,
  cost, latency, and timestamp fields. Failures can still have billed costs.
- Rerunning `main3.py` replaces the model/configuration result file and makes
  new calls; it does not resume. Do not silently overwrite the original pilot.
- `story.js` selects the original run ID `2026-10-03T11:03:45.271545+00:00`,
  requires all nine complete model envelopes with matching settings, and excludes
  subfolder smoke tests. Missing/changed data must show a notice, not partial findings.
- The explorer discovers all JSON recursively (directory listing locally;
  manifest fallback on GitHub Pages). Latest timestamp wins per image/configuration;
  sorted paths break ties. Conflicting ground truths disable scoring for that image.
- Keep page-relative URLs working under the GitHub Pages repository subpath,
  accessible controls, mobile layouts, both themes, and bookmarkable chart/filter states.
- Rebuild the manifest after adding/removing JSON files. Publish both pages,
  their scripts/styles/vendor files, manifest and indexed JSON, corresponding
  images, `data/data_source.txt`, and `main3.py` so source links resolve.

## Verification without model API calls

```bash
python3 -m py_compile main3.py smoke_test.py build_manifest.py main.py count_image.py
node --check app.js
node --check charts.js
node --check story.js
node --check theme.js
git diff --check
```

For website changes, serve the repository and run the existing browser checks
when practical; neither test calls a model API:

```bash
python3 -m http.server 8765
# In a separate process, use an isolated Chrome profile:
google-chrome --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 --user-data-dir=/tmp/count-benchmark-chrome
node scripts/story-browser-test.mjs
node scripts/browser-test.mjs
```

Screenshots go to `/tmp`. Check the changed area on desktop/mobile and in both
themes. Rebuild with `python3 build_manifest.py` only when the JSON file set changes.
