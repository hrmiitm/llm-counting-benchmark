"""Count objects in a local image with an OpenRouter vision model."""

import base64
import json
import mimetypes
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE_URL = os.environ.get('BASE_URL', 'https://openrouter.ai/api/v1/chat/completions')
API_KEY = os.environ.get('API_KEY', 'my-api-key')

def count_image(model, image, label, temperature=0) -> int:
    image = Path(image)
    mime = mimetypes.guess_type(image.name)[0] or "image/jpeg"
    encoded = base64.b64encode(image.read_bytes()).decode()
    payload = {
        "model": model,
        "temperature": temperature,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "object_count",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "count": {
                            "type": "integer",
                            "minimum": 0,
                            "description": f"Number of {label} visible in the image.",
                        },
                    },
                    "required": ["count"],
                    "additionalProperties": False,
                },
            },
        },
        "provider": {"require_parameters": True},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": f"Count the {label} in this image. You will always answer with an integer. In case you are not sure you can guess but you will always output an intger."},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}},
            ],
        }],
    }
    request = Request(
        BASE_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    try:
        with urlopen(request, timeout=90) as response:
            answer = json.load(response)["choices"][0]["message"]["content"]
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"API error {error.code}: {detail}") from error

    try:
        count = json.loads(answer)["count"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise ValueError(f"Model returned an invalid structured response: {answer!r}") from error
    if type(count) is not int or count < 0:
        raise ValueError(f"Model returned an invalid count: {count!r}")
    return count
