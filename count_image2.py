"""Count objects in a local image with Pydantic AI structured output."""

import mimetypes
import os
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent, NativeOutput
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from dotenv import load_dotenv


load_dotenv()
API_KEY = os.environ["API_KEY"]
BASE_URL = os.environ.get("BASE_URL", "https://openrouter.ai/api/v1/chat/completions")
API_BASE_URL = BASE_URL.removesuffix("/chat/completions")


class ImageCount(BaseModel):
    count: Annotated[int, Field(strict=True, ge=0)]


def count_image(model: str, image: str | Path, label: str, temperature: float = 0) -> int:
    image = Path(image)
    media_type = mimetypes.guess_type(image.name)[0] or "image/jpeg"
    agent = Agent(
        OpenAIChatModel(
            model,
            provider=OpenAIProvider(base_url=API_BASE_URL, api_key=API_KEY),
        ),
        output_type=NativeOutput(ImageCount),
        model_settings={"temperature": temperature},
    )
    result = agent.run_sync([
        f"Count the {label} in this image.",
        BinaryContent(data=image.read_bytes(), media_type=media_type),
    ])
    return result.output.count
