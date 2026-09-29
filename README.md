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

The API can charge for every image request. `eval/` and `.env` are ignored by Git.
