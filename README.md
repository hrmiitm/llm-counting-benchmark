# LLM Counting Benchmark

## Six-image confidence and cost pilot (`main3.py`)

Configure `.env`, choose entries in `MODELS`, then run manually:

```bash
uv run --with openai --with python-dotenv main3.py
```

Uses the official OpenAI Python SDK with OpenRouter and Pydantic validation.
Only the six Group 1 images are evaluated, with one prompt, temperature 0 for
non-GPT models and temperature omitted for GPT models (saved as `model_temp: null`).
It uses JSON-schema output, low reasoning effort, no tools/plugins, and no automatic SDK
retries. Confidence is a probability between 0 and 1 (0.95 means 95%). Each model
is pinned to one endpoint in `PROVIDERS`; provider fallbacks are disabled.
DeepSeek uses DeepInfra FP8, Gemini uses Google AI Studio, GPT uses OpenAI,
Haiku uses Anthropic, and Sonnet uses Azure Global (its catalog advertises
temperature support). An unavailable or incompatible pinned endpoint produces
a logged failure. Requested endpoint and reported provider are saved.
Reasoning text is excluded from responses, but reasoning tokens are still billed
and included in usage. `MAX_TOKENS = 4096` gives room for reasoning plus the
final JSON answer; this is an upper bound, not a target. Truncated answers are
logged without retrying.

The catalog check skips models lacking image, structured-output or reasoning
support, non-GPT models lacking temperature support, and models explicitly
listing reasoning efforts without `low`. Gemini 3.1 uses Flash Lite; DeepSeek uses V4.1 Flash
and V4 Flash Vision Exp.

Each model's `eval2/{model}_temp{0|default}_reasoning-low_group1.json` stores the configuration and a
`results` array with only group, ID, image, and label from metadata, predicted count,
confidence, latency, timestamps, token usage, generation ID,
raw response, and API-reported `cost_usd`. It saves after each image. Missing
cost stays `null`; `known_cost_usd` excludes unknown charges, and
`calls_with_unknown_cost` reports how many attempted calls lack cost data.
No ground-truth counts or accuracy/error/calibration metrics are saved or
calculated; ground truth can be joined later using the group and image fields.
Existing result files keep their previous format until that model is rerun.
Requests explicitly set `tools=[]` and `tool_choice="none"`; no search plugins
or search parameters are supplied. Failure logs describe request/validation
problems only, not counting errors against ground truth. GPT 6.1 Sol remains
removed from the selected models.

Failures and skipped calls append reasons to `eval2/failures.jsonl`. Rerunning
replaces model result files and makes new calls; it does not resume prior
successes. At most 54 image calls per invocation. Result envelopes are separate
from the existing website's array format.

Syntax check without API calls:

```bash
python3 -m py_compile main3.py
```

One-image smoke test (real, billable calls; no automatic retries):

```bash
uv run --with openai --with python-dotenv smoke_test.py
```

Uses the first Group 1 image (`813.jpg`) once per enabled model in `MODELS`,
with exactly the same requests and validation as `main3.py`. Results and logs
go to `eval2/smoke-test/`, separate from benchmark results. It prints count,
confidence, cost, output/reasoning tokens, failure reasons, and token-limit
warnings. Exit code is 1 if any model failed or was skipped, otherwise 0.
At most nine image calls with the current model list. Passing this image does
not guarantee that the other images fit the token budget or succeed.

Counts labeled objects in the images in `data/group1` and `data/group2` using vision models through an OpenRouter-compatible API.

## Run

1. Create `.env` from `.env.example` and add your endpoint and API key:

   ```env
   BASE_URL="https://openrouter.ai/api/v1/chat/completions"
   API_KEY="your-api-key"
   ```

2. Choose the models to evaluate in the `models` list in `main.py`, then run:

   ```bash
   uv run --with python-dotenv main.py
   ```

The script prints progress for every image and writes results to `eval/group1_eval.json` and `eval/group2_eval.json`. Each result includes the image metadata, model, temperature, and `model_count`.

The API can charge for every image request. `.env` is ignored by Git. Results intended for the website are tracked in `eval/`.


## Benchmark website

The root `index.html` is a static GitHub Pages site with no build step. It fetches `eval/include.txt`, then fetches and parses only the JSON files listed there. Results are never embedded in the HTML or JavaScript.

Preview locally (opening `index.html` as a file will not allow JSON fetching):

```bash
python3 -m http.server 8765
```

Open <http://localhost:8765>. For GitHub Pages, push the website, `eval/include.txt`, the listed JSON files, and the image folders. In **Settings → Pages**, choose **Deploy from a branch**, your publishing branch, and **/ (root)**. The page works under a repository subpath.

### Add results

1. Save an evaluation JSON array in `eval/`.
2. Add its filename to `eval/include.txt`, one path per line, relative to `eval/`. Blank lines and lines beginning with `#` are ignored. Only listed files are loaded.
3. Commit and push the JSON and manifest. Reload the page after Pages deploys.

Each record uses the existing benchmark fields: `group`, `id`, `image`, `label`, `actual-count`, `model`, `model_temp`, and `model_count`. The group comes from the record, not its filename. Image links point to `data/group{group}/{image}`. Models, providers, columns, and groups are discovered automatically. Provider headings use the prefix before `/` in the model name; names without a prefix appear under Other.

Rows represent model/temperature combinations so runs at different temperatures remain distinguishable. If a model/temperature/image appears more than once, the last record in manifest order wins. Conflicting actual counts are reported and skipped. Missing or malformed files produce a visible warning while valid files still render.

Each table defaults to percentage deviation and predicted/actual counts. Optional displays include predicted/actual as a percentage (100% means exact, above 100% means overcount), raw predicted count, and actual minus predicted. Exact-match accuracy has been removed.

**Normalized error** is `100 × mean(abs(predicted − actual) / actual)`. Each image contributes equally. Lower is better; 0% means perfect counts. Missing predictions and zero actual counts are excluded, with coverage shown. Values can exceed 100%.

Models default to ascending normalized error across providers. Use the explicit Asc/Desc buttons in each column header to sort models; use each model row’s Asc/Desc buttons to reorder images by that model’s deviation; image headings sort by absolute percentage deviation. Missing values stay last. Optional provider grouping applies the chosen sort within each provider. Image-order controls reorder columns by original ID, mean error, or a selected model's error.

Cells and overall error use D3's continuous `interpolateRdYlGn`, reversed: 0% green, 50% yellow, 100%+ red. Both tables share this fixed domain; only color is clamped, not the numeric values. Foreground color adjusts for contrast. Zero-denominator and missing cells are neutral. D3 7.9.0 is served locally from `vendor/` with its license; no runtime CDN is required.

The loader does not scan `eval/` or fetch metadata JSON. All model names, image columns, ground truths, predictions, and scores originate exclusively from the result files listed in `eval/include.txt`. Image files are fetched only for the thumbnails.
