import json
from pathlib import Path
from dotenv import load_dotenv
from time import sleep
load_dotenv()

from count_image2 import count_image


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
            sleep(15)
            results.append({**item, "model": model, "model_temp": model_temp, "model_count": model_count})
            print(f"  count: {model_count}", flush=True)

        result_file = output / f"{group_name}_eval.json"
        previous = json.loads(result_file.read_text()) if result_file.exists() else []
        previous = [row for row in previous if (row["model"], row["model_temp"]) != (model, model_temp)]
        result_file.write_text(json.dumps(previous + results, indent=2) + "\n")


if __name__ == "__main__":
    models = [
        # "anthropic/claude-opus-5.5",
        # "anthropic/claude-sonnet-5.5",
        # "openai/gpt-5.6-luna",
        # "openai/gpt-5.6-terra",
        # "google/gemini-3.8-flash",
        # "google/gemini-3.1-flash-lite",
        # "qwen/qwen3.7-flash",
        # "qwen/qwen3.8-flash",
        # "openai/gpt-5.6-sol",
        # "openai/gpt-6.1-sol",
        # "anthropic/claude-haiku-4.5",
        "openai/gpt-6-astra",
        "anthropic/claude-fable-5.1",
    ]
    for model in models:
        evaluate(["group1"], model)
