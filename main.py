import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

from count_image import count_image


def evaluate(groups_to_evalutes, model, model_temp=0, data_path="data", output_path="eval"):
    output = Path(output_path)
    output.mkdir(parents=True, exist_ok=True)

    for group_name in groups_to_evalutes:
        group_dir = Path(data_path) / group_name
        metadata = json.loads((group_dir / "metadata.json").read_text())
        results = []
        for index, item in enumerate(metadata, 1):
            print(f"{model} | {group_name} [{index}/{len(metadata)}] {item['image']} ...", flush=True)
            model_count = count_image(model, group_dir / item["image"], item["label"], model_temp)
            results.append({**item, "model": model, "model_temp": model_temp, "model_count": model_count})
            print(f"  count: {model_count}", flush=True)

        result_file = output / f"{group_name}_eval.json"
        previous = json.loads(result_file.read_text()) if result_file.exists() else []
        previous = [row for row in previous if (row["model"], row["model_temp"]) != (model, model_temp)]
        result_file.write_text(json.dumps(previous + results, indent=2) + "\n")


if __name__ == "__main__":
    models = [
        # "openai/gpt-5.6-luna",
        # "openai/gpt-5.6-terra",
        # "google/gemini-3.8-flash",
        # "google/gemini-3.1-flash-lite",
        "qwen/qwen3.7-flash",
        "qwen/qwen3.8-flash",
        # "openai/gpt-5.6-sol",
        # "anthropic/claude-haiku-4.5",
        # "anthropic/claude-fable-5.1",
        # "openai/gpt-6-astra",
    ]
    for model in models:
        evaluate(["group1", "group2"], model)
