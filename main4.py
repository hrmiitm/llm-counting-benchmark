"""Run manually: uv run --with openai --with python-dotenv main4.py"""

import argparse
import base64
import json
import mimetypes
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(__file__).resolve().parent
MODELS = [
    # Complete: all six images succeeded at low, medium, and high. Keep eval4 data.
    # "google/gemini-3.1-flash-lite",
    # "google/gemini-3.8-flash",
    "openai/gpt-5.6-luna",
    # "openai/gpt-5.6-sol",
    # "anthropic/claude-sonnet-5.5",
]
# Exact endpoint slugs: each model is restricted to one provider endpoint.
PROVIDERS = {
    "google/gemini-3.1-flash-lite": "google-ai-studio",
    "google/gemini-3.8-flash": "google-ai-studio",
    "openai/gpt-5.6-luna": "openai",
    "openai/gpt-5.6-sol": "openai",
    "anthropic/claude-haiku-4.5": "anthropic",
    "anthropic/claude-sonnet-5.5": "azure/global",
}
PROMPT = (
    "Count the {label} in this image. Report confidence between 0 and 1 as the "
    "probability your count is exactly correct, considering alternative counts. "
    "Use 0.95 for 95% confidence. Low confidence is acceptable."
)
MAX_TOKENS = 32768  # Same reasoning/answer budget at every effort; no automatic retries.
REQUEST_TIMEOUT = 600  # Allow longer high-effort answers to finish.
REASONING_EFFORTS = ("low", "medium", "high")


class CountAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int = Field(strict=True, ge=0)
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False,
                              description="Probability the count is exactly correct; 0.95 means 95%")


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, data, key):
    # Redact credentials even if an upstream error happens to echo them.
    text = json.dumps(data, indent=2, allow_nan=False).replace(key, "[REDACTED]")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text + "\n")
    temporary.replace(path)


def capability_issues(info, endpoint, effort, sampling):
    """Require affirmative effort metadata and the exact endpoint's effort selector."""
    issues = []
    if not info:
        issues.append("Model ID not found")
    if "image" not in info.get("architecture", {}).get("input_modalities", []):
        issues.append("Image input unsupported")
    required = ("structured_outputs", "response_format", "reasoning", "reasoning_effort",
                "max_tokens", "tools", "tool_choice", *sampling)
    for scope, capabilities in (("Model", info), ("Pinned endpoint", endpoint)):
        for parameter in required:
            if parameter not in (capabilities.get("supported_parameters") or []):
                issues.append(f"{scope} unsupported parameter: {parameter}")
        reasoning = capabilities.get("reasoning") or {}
        # OpenRouter documents explicit null as all efforts; omission is not evidence.
        if "supported_efforts" in reasoning:
            supported = reasoning["supported_efforts"]
            if supported is not None and effort not in supported:
                issues.append(f"{scope} reasoning effort {effort!r} unsupported; advertised: {supported}")
        elif scope == "Model":
            issues.append(f"Reasoning effort {effort!r} cannot be validated: model omits supported_efforts")
    if not endpoint:
        issues.append("Pinned provider endpoint not found or could not be validated")
    elif endpoint.get("status") != 0:
        issues.append(f"Pinned provider endpoint unavailable (status={endpoint.get('status')})")
    limit = endpoint.get("max_completion_tokens")
    if limit is not None and limit < MAX_TOKENS:
        issues.append(f"Pinned endpoint token limit {limit} is below requested {MAX_TOKENS}")
    tool_choices = endpoint.get("supports_tool_choice") or {}
    if tool_choices.get("none") is False:
        issues.append("Pinned endpoint does not support tool_choice=none")
    return issues


def main(*, one_image=False, output_path="eval4", models=None, efforts=None, check_only=False):
    models = MODELS if models is None else models
    efforts = REASONING_EFFORTS if efforts is None else efforts
    if not models or not efforts or set(models) - set(MODELS) or set(efforts) - set(REASONING_EFFORTS):
        raise ValueError("Select only configured models and low/medium/high efforts")
    load_dotenv(ROOT / ".env")
    key = os.environ.get("API_KEY", "").strip()
    if not key:
        raise SystemExit("Set API_KEY in .env first")
    base = (os.environ.get("BASE_URL") or "https://openrouter.ai/api/v1")
    base = base.rstrip("/").removesuffix("/chat/completions")
    group = ROOT / "data/group1"
    items = json.loads((group / "metadata.json").read_text())
    # Only identifiers and the target label enter this benchmark; never copy gold data.
    items = [{k: item[k] for k in ("group", "id", "image", "label")} for item in items]
    if len(items) != 6:
        raise SystemExit("Expected exactly six Group 1 images")
    if one_image:
        items = items[:1]
    images = {}
    for item in items:  # Validate local files before any paid call.
        image = group / item["image"]
        media = mimetypes.guess_type(image.name)[0] or "image/jpeg"
        images[item["image"]] = f"data:{media};base64,{base64.b64encode(image.read_bytes()).decode()}"
    output = ROOT / output_path
    output.mkdir(parents=True, exist_ok=True)
    result_files = []
    run_id = now()

    def log(record):
        with (output / "failures.jsonl").open("a") as handle:
            handle.write(json.dumps(record).replace(key, "[REDACTED]") + "\n")

    with OpenAI(api_key=key, base_url=base, timeout=REQUEST_TIMEOUT, max_retries=0) as client:
        try:
            catalog = {m.id: m.model_dump() for m in client.models.list()}
        except Exception as exc:
            log({"run_id": run_id, "stage": "catalog", "error": str(exc)})
            raise SystemExit(f"Catalog check failed; see {output / 'failures.jsonl'}")
        # Validate every selected model/endpoint/effort before the first paid call.
        preflight = {"run_id": run_id, "checked_at_utc": now(), "checks": []}
        configurations = []
        for model in models:
            provider = PROVIDERS[model]
            sampling = {} if model.startswith("openai/gpt-") else {"temperature": 0}
            info = catalog.get(model, {})
            endpoint, endpoint_error = {}, None
            if info:
                try:
                    endpoint_data = client.get(f"models/{model}/endpoints", cast_to=dict)["data"]
                    matches = [e for e in endpoint_data["endpoints"] if e.get("tag") == provider]
                    if len(matches) != 1:
                        raise ValueError(f"Expected one exact endpoint tag {provider}; found {len(matches)}")
                    endpoint = matches[0]
                except Exception as exc:
                    endpoint_error = str(exc)
            for effort in efforts:
                issues = capability_issues(info, endpoint, effort, sampling)
                if endpoint_error:
                    issues.append(f"Endpoint lookup failed: {endpoint_error}")
                check = {"model": model, "provider_endpoint": provider, "reasoning_effort": effort,
                         "status": "skipped" if issues else "ready", "issues": issues,
                         "model_capabilities": info, "endpoint_capabilities": endpoint}
                preflight["checks"].append(check)
                configurations.append((model, provider, sampling, effort, issues))
                summary = "; ".join(issues) if issues else "ready (catalog efforts + exact endpoint parameters)"
                print(f"{model} | {provider} | {effort} | {summary}".replace(key, "[REDACTED]"), flush=True)
        save(output / "preflight.json", preflight, key)
        if check_only:
            return []
        for model, provider, sampling, effort, issues in configurations:
            reasoning = {"enabled": True, "effort": effort, "exclude": True}
            document = {"run_id": run_id, "model": model, "model_temp": sampling.get("temperature"),
                        "prompt": PROMPT, "max_tokens": MAX_TOKENS, "request_timeout_seconds": REQUEST_TIMEOUT,
                        "provider_endpoint": provider, "allow_fallbacks": False,
                        "tools": [], "tool_choice": "none",
                        "reasoning": reasoning, "confidence_scale": "0-1", "results": []}
            temp_name = "default" if not sampling else "0"
            destination = output / (model.replace("/", "_") + f"_temp{temp_name}_reasoning-{effort}_group1.json")
            result_files.append(destination)
            for item in items:
                row = {**item, "model": model, "model_temp": sampling.get("temperature"), "run_id": run_id,
                       "reasoning_effort": effort,
                       "provider_endpoint": provider,
                       "started_at_utc": now(), "model_count": None, "confidence": None,
                       "cost_usd": None, "usage": {}, "status": "failed", "attempt_count": 0}
                started = time.perf_counter()
                try:
                    if issues:
                        row.update(status="skipped", cost_usd=0)
                        raise ValueError("; ".join(issues))
                    row["attempt_count"] = 1
                    response = client.chat.completions.create(
                        model=model, **sampling, max_tokens=MAX_TOKENS,
                        tools=[], tool_choice="none",
                        messages=[{"role": "user", "content": [
                            {"type": "text", "text": PROMPT.format(label=item["label"])},
                            {"type": "image_url", "image_url": {"url": images[item["image"]]}},
                        ]}],
                        response_format={"type": "json_schema", "json_schema": {
                            "name": "count_answer", "strict": True,
                            "schema": CountAnswer.model_json_schema(),
                        }},
                        # No tools/plugins; never switch to another provider endpoint.
                        extra_body={"provider": {"only": [provider], "allow_fallbacks": False,
                                                 "require_parameters": True},
                                    "reasoning": reasoning},
                    )
                    row["raw_response"] = response.model_dump(mode="json")
                    row["generation_id"] = response.id
                    row["response_provider"] = row["raw_response"].get("provider")
                    row["usage"] = row["raw_response"].get("usage") or {}
                    row["cost_usd"] = row["usage"].get("cost")
                    choice = response.choices[0]
                    if choice.message.tool_calls or choice.message.function_call:
                        raise ValueError("Unexpected tool call; no tools are executed")
                    if choice.finish_reason == "length":
                        raise ValueError(f"Token budget exhausted ({MAX_TOKENS} reasoning/answer tokens); "
                                         "no complete answer. Keep the same budget across all reasoning efforts.")
                    if choice.finish_reason != "stop" or choice.message.refusal:
                        raise ValueError(f"Response incomplete or refused: {choice.finish_reason}; {choice.message.refusal}")
                    # Validate after storing usage so billed invalid answers retain their cost.
                    answer = CountAnswer.model_validate_json(choice.message.content or "")
                    row.update(status="success", model_count=answer.count,
                               confidence=answer.confidence)
                except Exception as exc:
                    body = getattr(exc, "body", None)
                    if isinstance(body, dict):
                        row["error_response"] = body
                        row["usage"] = body.get("usage") or row["usage"]
                        row["cost_usd"] = row["usage"].get("cost", row["cost_usd"])
                    row["error"] = {"type": type(exc).__name__, "reason": str(exc)}
                    row["http_status"] = getattr(exc, "status_code", None)
                    log({"run_id": run_id, "model": model, "reasoning_effort": effort,
                         "provider_endpoint": provider, "image": item["image"], **row["error"]})
                row["latency_seconds"] = time.perf_counter() - started if row["attempt_count"] else None
                row["finished_at_utc"] = now()
                document["results"].append(row)
                document["known_cost_usd"] = sum(r["cost_usd"] or 0 for r in document["results"])
                document["calls_with_unknown_cost"] = sum(
                    r["attempt_count"] and r["cost_usd"] is None for r in document["results"])
                save(destination, document, key)
                print(f"{model} | {effort} | {item['image']} | {row['status']} | USD {row['cost_usd']}", flush=True)
                if "error" in row:
                    print(f"  {row['error']['reason']}".replace(key, "[REDACTED]"), flush=True)
                if row["attempt_count"]:
                    time.sleep(2)
    return result_files


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Six-image reasoning-effort benchmark; real calls are billable.")
    parser.add_argument("--check-only", action="store_true", help="Query capabilities only; no paid calls")
    parser.add_argument("--smoke-test", action="store_true", help="First image only; writes eval4/smoke-test/")
    parser.add_argument("--model", action="append", choices=MODELS, help="Select model (repeatable)")
    parser.add_argument("--effort", action="append", choices=REASONING_EFFORTS, help="Select effort (repeatable)")
    args = parser.parse_args()
    main(one_image=args.smoke_test, output_path="eval4/smoke-test" if args.smoke_test else "eval4",
         models=list(dict.fromkeys(args.model)) if args.model else None,
         efforts=list(dict.fromkeys(args.effort)) if args.effort else None, check_only=args.check_only)
