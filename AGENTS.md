# LLM Count Benchmark

## Project layout

- `main.py` runs the benchmark for the models listed in its `models` array.
- `count_image.py` sends one image and its label to the configured API.
- `data/group1` and `data/group2` contain images and `metadata.json` ground truth.
- `eval/` contains generated results and is ignored by Git.

## Configuration

- Read `BASE_URL` and `API_KEY` from `.env` via `python-dotenv`.
- Never print, commit, or expose the API key. Keep `.env.example` as the credential template.
- The API may charge per request. Do not run the full benchmark unless the user asks for it.

## Development

- Keep scripts small and dependency-light; use the standard library where practical.
- Preserve all metadata fields when creating evaluation results. Add `model`, `model_temp`, and `model_count`.
- A re-run for the same model and temperature should replace that model's prior result, not duplicate it.

## Verification

Run syntax checks without making API calls:

```bash
uv run --with python-dotenv python -m py_compile main.py count_image.py
```

Run the benchmark only after configuring `.env`:

```bash
uv run --with python-dotenv main.py
```
