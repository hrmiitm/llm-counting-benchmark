"""One real image per model. Run: uv run --with openai --with python-dotenv smoke_test.py"""

import json

from main3 import main


def run_test():
    files = main(one_image=True, output_path="eval2/smoke-test")
    failures, known_cost, unknown_cost = 0, 0, 0
    for path in files:
        result = json.loads(path.read_text())
        row = result["results"][0]
        usage = row["usage"]
        tokens = usage.get("completion_tokens")
        reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        choices = (row.get("raw_response") or {}).get("choices") or [{}]
        print(f"\n{row['model']}: {row['status'].upper()}")
        print(f"  count={row['model_count']}, confidence={row['confidence']}, USD={row['cost_usd']}")
        print(f"  output tokens={tokens}, reasoning tokens={reasoning}, limit={result['max_tokens']}")
        known_cost += row["cost_usd"] or 0
        unknown_cost += bool(row["attempt_count"] and row["cost_usd"] is None)
        if row["status"] != "success":
            failures += 1
            print(f"  Reason: {row.get('error', {}).get('reason', 'Unknown failure')}")
            if choices[0].get("finish_reason") == "length":
                print("  Increase MAX_TOKENS in main3.py; the combined reasoning/answer limit was reached.")
            else:
                print("  Check the logged reason and pinned endpoint's supported parameters.")
        elif tokens is not None and tokens >= 0.85 * result["max_tokens"]:
            print("  Near the token limit; other images may need a larger MAX_TOKENS.")
    print(f"\n{len(files) - failures}/{len(files)} passed; known cost USD {known_cost:.8f}; "
          f"calls with unknown cost: {unknown_cost}")
    print("Details and failure logs: eval2/smoke-test/. Passing one image does not guarantee all six.")
    return int(failures > 0)


if __name__ == "__main__":
    raise SystemExit(run_test())
