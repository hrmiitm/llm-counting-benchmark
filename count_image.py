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
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": f"Count the {label} in this image. Reply with only an integer."},
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
    return int(answer.strip())
