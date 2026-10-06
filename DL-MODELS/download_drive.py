"""Bounded, resumable official Google Drive downloads using pinned gdown."""
import sys
import time
from pathlib import Path
import gdown
import requests

original = requests.sessions.Session.request


def bounded_request(self, method, url, **kwargs):
    kwargs.setdefault("timeout", (30, 60))
    response = original(self, method, url, **kwargs)
    byte_range = kwargs.get("headers", {}).get("Range")
    if byte_range and response.status_code != 206:
        response.close()
        raise RuntimeError("Server refused range resume; partial bytes were not appended")
    return response


requests.sessions.Session.request = bounded_request
if __name__ == "__main__":
    file_id, output = sys.argv[1:]
    print(f"Downloading/resuming official Drive checkpoint to {output}", flush=True)
    for attempt in range(3):
        try:
            result = gdown.download(id=file_id, output=output, resume=True, use_cookies=False, quiet=True)
            if result is None or not Path(result).is_file():
                raise RuntimeError("Drive download returned no file")
            print(f"Checkpoint download complete: {Path(result).stat().st_size} bytes", flush=True)
            break
        except (requests.RequestException, RuntimeError) as exc:
            print(f"Download attempt {attempt + 1} failed: {exc}", flush=True)
            if attempt == 2:
                raise
            time.sleep(1)
