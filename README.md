# LLM Counting Benchmark

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
