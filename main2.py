"""Run the Group 1 count-and-confidence benchmark."""

import json
import mimetypes
import os
import re
from pathlib import Path
from time import sleep
from typing import Annotated

from dotenv import load_dotenv
from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent, NativeOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider


load_dotenv()
API_KEY = os.environ["API_KEY"]
BASE_URL = os.environ.get("BASE_URL", "https://openrouter.ai/api/v1/chat/completions")
API_BASE_URL = BASE_URL.removesuffix("/chat/completions")


class CountWithConfidence(BaseModel):
    count: Annotated[int, Field(strict=True, ge=0)]
    confidence: Annotated[float, Field(ge=0, le=100)]


def count_with_confidence(agent, image, label):
    image = Path(image)
    media_type = mimetypes.guess_type(image.name)[0] or "image/jpeg"
    result = agent.run_sync([
        f"Count the {label} in this image. Return your count and your confidence, "
        "from 0 to 100, that the count is exactly correct. Calibrate confidence "
        "honestly: 90 means that about 90% of comparable predictions would be "
        "exactly correct, not merely close to the correct count.",
        BinaryContent(data=image.read_bytes(), media_type=media_type),
    ])
    return result.output


def result_path(output_dir, model):
    safe_model = re.sub(r"[^A-Za-z0-9._-]+", "_", model).strip("._-")
    return output_dir / f"{safe_model}_conf_group1_eval.json"


def evaluate_group1(model, model_temp=0, data_path="data", output_path="eval"):
    group_dir = Path(data_path) / "group1"
    metadata = json.loads((group_dir / "metadata.json").read_text())
    output_dir = Path(output_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    agent = Agent(
        OpenAIChatModel(
            model,
            provider=OpenAIProvider(base_url=API_BASE_URL, api_key=API_KEY),
        ),
        output_type=NativeOutput(CountWithConfidence),
        model_settings={"temperature": model_temp},
    )

    results = []
    for index, item in enumerate(metadata, 1):
        print(f"{model} | group1 [{index}/{len(metadata)}] {item['image']} ...", flush=True)
        answer = count_with_confidence(agent, group_dir / item["image"], item["label"])
        results.append({
            **item,
            "model": model,
            "model_temp": model_temp,
            "model_count": answer.count,
            "confidence": answer.confidence,
        })
        print(f"  count: {answer.count}; confidence: {answer.confidence:.1f}%", flush=True)
        if index < len(metadata):
            sleep(15)

    destination = result_path(output_dir, model)
    destination.write_text(json.dumps(results, indent=2) + "\n")
    print(f"Wrote {destination}", flush=True)


if __name__ == "__main__":
    models = [
        "anthropic/claude-fable-5.1",
        "anthropic/claude-haiku-4.5",
        "anthropic/claude-opus-5.5",
        "anthropic/claude-sonnet-5.5",
        "google/gemini-3.1-flash-lite",
        "google/gemini-3.8-flash",
        "meta-llama/llama-4-maverick",
        "openai/gpt-5.6-luna",
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-terra",
        "openai/gpt-6.1-sol",
        "openai/gpt-6-astra",
    ]
    for model in models:
        evaluate_group1(model)
