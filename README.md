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

The root `index.html` is a static GitHub Pages site with no build step or dependencies. It fetches `eval/include.txt`, then fetches and parses only the JSON files listed there. Results are never embedded in the HTML or JavaScript.

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

Each table has independent checkboxes for predicted/actual, predicted count, and difference (**actual − predicted**). Multiple displays can be enabled together. Green means exact, amber undercount, and purple overcount. **Accuracy is exact matches divided by images with valid predictions**, with prediction coverage shown separately. Missing, null, or invalid predictions display `—` and do not enter the accuracy denominator. Counts must be nonnegative JSON numbers.


**Normalized error** is mean absolute percentage error: `100 × mean(abs(predicted − actual) / actual)`. Each image contributes equally, so a miss of 10 on an actual count of 20 matters more than a miss of 10 on 200. Lower is better; 0% means perfect counts. The metric can exceed 100% for large overcounts. Missing predictions and zero actual counts are excluded, with the contributing image count shown in the column. Exact-match accuracy still includes valid predictions for zero actual counts.

The loader does not scan `eval/` or fetch metadata JSON. All model names, image columns, ground truths, predictions, and scores originate exclusively from the result files listed in `eval/include.txt`. Image files are fetched only for the thumbnails.
