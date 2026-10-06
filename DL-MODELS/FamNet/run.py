"""Official FamNet forward path without optional test-time adaptation."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DL_ROOT, benchmark, digest, timed_forward


def load(folder, config, device):
    import torch
    sys.path.insert(0, str(folder / "upstream"))
    from model import Resnet50FPN, CountRegressor
    from utils import resizeImage, extract_features
    checkpoint = folder / config["checkpoint"]
    features = Resnet50FPN().to(device).eval()
    regressor = CountRegressor(6, pool=config["inference"]["pool"]).to(device).eval()
    regressor.load_state_dict(torch.load(checkpoint, map_location=device, weights_only=True), strict=True)
    exemplars = json.loads((folder / config["exemplars"]).read_text())
    state = (features, regressor, resizeImage(config["inference"]["max_image_dimension"]), extract_features, exemplars)
    return state, {"checkpoint_sha256": digest(checkpoint), "exemplars_sha256": digest(folder / config["exemplars"])}


def predict(state, image, item, folder, config, device):
    import numpy as np
    import torch
    from PIL import Image
    features, regressor, transform, extract_features, exemplars = state
    info = exemplars["images"][item["image"]]
    sample = transform({"image": Image.open(image).convert("RGB"), "lines_boxes": info["boxes_yxyx"]})
    tensor, boxes = sample["image"].to(device), sample["boxes"].to(device)
    settings = config["inference"]
    output, seconds = timed_forward(torch, device, lambda: regressor(extract_features(
        features, tensor.unsqueeze(0), boxes.unsqueeze(0), settings["feature_maps"], settings["exemplar_scales"])))
    density = output.detach().cpu().numpy()
    if not np.isfinite(density).all() or (density < 0).any():
        raise ValueError("Invalid density map")
    artifact = DL_ROOT / "results/artifacts/FamNet" / config["_config_sha256"] / f"{item['image']}.npy"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    np.save(artifact, density)
    return {"count": float(output.sum().item()), "inference_seconds": seconds,
            "density_map": artifact.relative_to(DL_ROOT).as_posix(), "density_sha256": digest(artifact),
            "density_shape": list(density.shape), "exemplar_boxes_yxyx": info["boxes_yxyx"],
            "dataset_split": info["dataset_split"], "preprocessed_shape": list(tensor.shape)}


if __name__ == "__main__":
    raise SystemExit(benchmark(Path(__file__).resolve().parent, load, predict))
