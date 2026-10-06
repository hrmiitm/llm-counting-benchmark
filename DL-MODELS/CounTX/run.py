"""Single-image wrapper of the official paper-reproduction sliding-window path."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DL_ROOT, benchmark, digest, timed_forward


def load(folder, config, device):
    import torch
    sys.path.insert(0, str(folder / "upstream"))
    sys.path.insert(0, str(folder / "upstream/open_clip/src"))
    import open_clip
    from models_reproduce_paper import main_counting_network
    model = main_counting_network()
    checkpoint = torch.load(folder / config["checkpoint"], map_location="cpu", weights_only=False)
    weights = checkpoint["model"]
    unused = []
    for key in config["unused_checkpoint_keys"]:
        if key in model.state_dict():
            raise ValueError(f"Configured unused key is actually required: {key}")
        if key in weights:
            unused.append(key)
            del weights[key]
    model.load_state_dict(weights, strict=True)
    del checkpoint
    model = model.to(device).eval()
    return (model, open_clip.get_tokenizer("ViT-B-16")), {"checkpoint_sha256": digest(folder / config["checkpoint"]),
            "state_dict_loading": "strict for all inference parameters", "unused_checkpoint_keys": unused}


def predict(state, image, item, folder, config, device):
    import numpy as np
    import torch
    from PIL import Image
    from torchvision import transforms
    from torchvision.transforms import InterpolationMode
    model, tokenizer = state
    settings = config["inference"]
    image = Image.open(image).convert("RGB")
    width, height = image.size
    height, width = 16 * (height // 16), 16 * (width // 16)
    if height != 384 or width < 384:
        raise ValueError("Official FSC reproduction path requires height 384 and width >=384")
    sample = transforms.ToTensor()(transforms.Resize((height, width))(image)).unsqueeze(0).to(device)
    tokens = tokenizer(item["label"]).unsqueeze(0).to(device)
    preprocess = transforms.Compose([
        transforms.Resize(224, interpolation=InterpolationMode.BICUBIC, antialias=settings["antialias"]),
        transforms.Normalize((0.48145466, 0.4578275, 0.40821073), (0.26862954, 0.26130258, 0.27577711))])

    def forward():
        density = torch.zeros((height, width), device=device)
        start, previous, windows = 0, -1, 0
        while start + 383 < width:
            output = model(preprocess(sample[:, :, :, start:start + 384]), tokens, 1)[0]
            overlapping = previous - start + 1
            pad = torch.nn.functional.pad
            old_left = pad(density[:, :start], (0, width - start))
            old_middle = pad(density[:, start:previous + 1], (start, width - previous - 1))
            old_right = pad(density[:, previous + 1:], (previous + 1, 0))
            new_middle = pad(output[:, :overlapping], (start, width - previous - 1))
            new_right = pad(output[:, overlapping:], (previous + 1, width - start - 384))
            density = old_left + old_right + old_middle / 2 + new_middle / 2 + new_right
            windows += 1
            previous = start + 383
            start += settings["window_stride"]
            if start + 383 >= width:
                if start == width - 384 + settings["window_stride"]:
                    break
                start = width - 384
        return density / settings["density_scale"], windows

    (density, windows), seconds = timed_forward(torch, device, forward)
    array = density.cpu().numpy()
    if not np.isfinite(array).all():
        raise ValueError("Non-finite density map")
    artifact = DL_ROOT / "results/artifacts/CounTX" / config["_config_sha256"] / f"{item['image']}.npy"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    np.save(artifact, array)
    return {"count": float(density.sum().item()), "inference_seconds": seconds, "class_prompt": item["label"],
            "density_map": artifact.relative_to(DL_ROOT).as_posix(), "density_sha256": digest(artifact),
            "density_shape": list(array.shape), "windows": windows}


if __name__ == "__main__":
    raise SystemExit(benchmark(Path(__file__).resolve().parent, load, predict))
