"""Offline safety/regression checks: no network or paid model calls."""

import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from openai.types.chat import ChatCompletion

import main3
import main4


def capabilities():
    info = {"architecture": {"input_modalities": ["text", "image"]},
            "supported_parameters": ["structured_outputs", "response_format", "reasoning",
                                     "reasoning_effort", "max_tokens", "tools", "tool_choice", "temperature"],
            "reasoning": {"supported_efforts": ["low", "medium", "high"]}}
    endpoint = {"tag": "openai", "status": 0, "max_completion_tokens": 128000,
                "supported_parameters": info["supported_parameters"][:],
                "supports_tool_choice": {"none": True}}
    return info, endpoint


class Main4Tests(unittest.TestCase):
    def test_capability_gate(self):
        info, endpoint = capabilities()
        self.assertEqual(main4.capability_issues(info, endpoint, "high", {}), [])
        endpoint["reasoning"] = {"supported_efforts": ["low"]}
        self.assertTrue(main4.capability_issues(info, endpoint, "high", {}))
        del endpoint["reasoning"]
        info["reasoning"]["supported_efforts"] = None
        self.assertEqual(main4.capability_issues(info, endpoint, "medium", {}), [])
        info["reasoning"] = {}
        self.assertTrue(main4.capability_issues(info, endpoint, "low", {}))
        info, endpoint = capabilities()
        endpoint["supported_parameters"].remove("reasoning_effort")
        self.assertTrue(main4.capability_issues(info, endpoint, "low", {}))
        self.assertTrue(main4.capability_issues(info, {}, "low", {}))
        info, endpoint = capabilities()
        endpoint["status"] = 1
        self.assertTrue(main4.capability_issues(info, endpoint, "low", {}))
        endpoint["status"], endpoint["max_completion_tokens"] = 0, 1024
        self.assertTrue(main4.capability_issues(info, endpoint, "low", {}))

    def run_fake(self, *, check_only=False, bad_endpoint=False, incomplete=False):
        requests, events = [], []
        models = ["openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5"]
        info, endpoint = capabilities()
        haiku = copy.deepcopy(info)
        haiku["reasoning"] = {"mandatory": False}
        haiku["supported_parameters"].remove("reasoning_effort")

        def get(path, cast_to):
            events.append("endpoint")
            ep = copy.deepcopy(endpoint)
            ep["tag"] = main4.PROVIDERS[path.removeprefix("models/").removesuffix("/endpoints")]
            if bad_endpoint:
                ep["tag"] += "/other"
            return {"data": {"endpoints": [ep]}}

        def create(**request):
            events.append("paid")
            requests.append(copy.deepcopy(request))
            return ChatCompletion.model_validate({
                "id": "test-generation", "object": "chat.completion", "created": 0,
                "model": request["model"], "provider": "OpenAI",
                "choices": [{"index": 0, "finish_reason": "length" if incomplete else "stop",
                             "message": {"role": "assistant", "content": '{"count":12,"confidence":0.8}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30,
                          "cost": 0.001},
            })

        client = SimpleNamespace(
            models=SimpleNamespace(list=lambda: [SimpleNamespace(id=model, model_dump=lambda data=data: data)
                                                 for model, data in zip(models, [info, haiku])]),
            get=get, chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main4, "OpenAI") as factory, patch.object(main4, "load_dotenv"), \
                    patch.dict(os.environ, {"API_KEY": "fake-test-secret", "BASE_URL": "https://example.test/api/v1/chat/completions"}), \
                    patch.object(main4.time, "sleep"), redirect_stdout(io.StringIO()):
                factory.return_value.__enter__.return_value = client
                paths = main4.main(one_image=True, output_path=directory, models=models, check_only=check_only)
                self.assertEqual(factory.call_args.kwargs["base_url"], "https://example.test/api/v1")
                self.assertEqual(factory.call_args.kwargs["max_retries"], 0)
                self.assertEqual(factory.call_args.kwargs["timeout"], 600)
            documents = [json.loads(path.read_text()) for path in paths]
            self.assertEqual(len(json.loads((Path(directory) / "preflight.json").read_text())["checks"]), 6)
        return requests, events, documents

    def test_only_effort_changes_and_no_gold_data(self):
        self.assertEqual(main4.PROMPT, main3.PROMPT)
        self.assertEqual(main4.CountAnswer.model_json_schema(), main3.CountAnswer.model_json_schema())
        requests, events, documents = self.run_fake()
        self.assertEqual(events[:2], ["endpoint", "endpoint"])
        self.assertEqual(len(requests), 3)
        reference = copy.deepcopy(requests[0])
        del reference["extra_body"]["reasoning"]["effort"]
        for request, effort in zip(requests, main4.REASONING_EFFORTS):
            self.assertEqual(request["max_tokens"], 32768)
            self.assertEqual(request["extra_body"]["reasoning"].pop("effort"), effort)
            self.assertEqual(request, reference)
            self.assertEqual(request["extra_body"]["provider"],
                             {"only": ["openai"], "allow_fallbacks": False, "require_parameters": True})
        self.assertNotIn("actual-count", json.dumps(documents))
        self.assertNotIn("actual-count", json.dumps(requests))
        for document in documents[:3]:
            self.assertEqual(document["results"][0]["status"], "success")
            self.assertEqual(document["results"][0]["cost_usd"], 0.001)
        for document in documents[3:]:
            row = document["results"][0]
            self.assertEqual((row["status"], row["attempt_count"]), ("skipped", 0))
            self.assertIn("supported_efforts", row["error"]["reason"])

    def test_no_paid_calls_when_unverified_or_check_only(self):
        for kwargs in ({"check_only": True}, {"bad_endpoint": True}):
            requests, _, _ = self.run_fake(**kwargs)
            self.assertEqual(requests, [])

    def test_billed_incomplete_answers_are_saved_without_retries(self):
        requests, _, documents = self.run_fake(incomplete=True)
        self.assertEqual(len(requests), 3)
        for document in documents[:3]:
            row = document["results"][0]
            self.assertEqual((row["status"], row["attempt_count"], row["model_count"]), ("failed", 1, None))
            self.assertEqual(row["cost_usd"], 0.001)
            self.assertEqual(row["raw_response"]["choices"][0]["finish_reason"], "length")
            self.assertIn("Token budget exhausted (32768", row["error"]["reason"])

    def test_completed_models_are_disabled(self):
        self.assertNotIn("google/gemini-3.1-flash-lite", main4.MODELS)
        self.assertNotIn("google/gemini-3.8-flash", main4.MODELS)
        self.assertEqual(main4.REASONING_EFFORTS, ("low", "medium", "high"))
        self.assertEqual(set(main4.MODELS), {"openai/gpt-5.6-luna", "openai/gpt-5.6-sol",
                                            "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5.5"})


if __name__ == "__main__":
    unittest.main()
