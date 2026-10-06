"""CPU default; configuration and results live under DL-MODELS."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import benchmark, digest


def load(folder, config, device):
    import torch
    from ultralytics import YOLOWorld, settings
    from ultralytics.nn import text_model
    weights = folder / config["checkpoint"]
    clip = folder / "weights/clip/ViT-B-32.pt"
    if digest(weights) != config["weights_sha256"] or digest(clip) != config["clip_sha256"]:
        raise ValueError("Weight checksum mismatch; run setup.py")
    settings.update({"weights_dir": str(folder / "weights"), "sync": False})
    text_model.WEIGHTS_DIR = folder / "weights"
    model = YOLOWorld(str(weights)).to(device)
    model.set_classes(["person", "bus"])
    control = model.predict(str(folder / "weights/control-bus.jpg"), device=device,
                            conf=0.25, imgsz=640, verbose=False, save=False)[0]
    if len(control.boxes) == 0:
        raise RuntimeError("Known-positive control returned no detections")
    diagnostics = {}

    def hook(module, inputs, output):
        decoded = output[0] if isinstance(output, tuple) else output
        if decoded.ndim != 3 or decoded.shape[1] != 5:
            raise RuntimeError("Unexpected single-class output shape")
        scores = decoded[:, 4, :].detach()
        if not torch.isfinite(scores).all():
            raise RuntimeError("Non-finite model output")
        diagnostics.update(max_detection_score_before_nms=float(scores.max()),
                           candidates_above_cutoff=int((scores > config["inference"]["conf"]).sum()))
    model.model.register_forward_hook(hook)
    return (model, diagnostics), {"weights_sha256": digest(weights), "clip_sha256": digest(clip),
                                "warmup": "known-positive control before timed target images",
                                "control": {"image_sha256": config["control_sha256"], "classes": ["person", "bus"],
                                            "count": len(control.boxes), "max_score": float(control.boxes.conf.max())}}


def predict(state, image, item, folder, config, device):
    model, diagnostic = state
    diagnostic.clear()
    model.set_classes([item["label"]])
    settings = {k: v for k, v in config["inference"].items() if k != "tiling"}
    result = model.predict(str(image), device=device, save=False, verbose=False, **settings)[0]
    if not diagnostic:
        raise RuntimeError("Missing decoded score diagnostics")
    boxes = result.boxes.cpu()
    detections = [{"xyxy": box, "score": score, "label": result.names[int(cls)]}
                  for box, score, cls in zip(boxes.xyxy.tolist(), boxes.conf.tolist(), boxes.cls.tolist())]
    return {"count": len(detections), "inference_seconds": result.speed["inference"] / 1000,
            "image_shape": list(result.orig_shape), "class_prompt": item["label"],
            "detections": detections, **diagnostic,
            "zero_detection_reason": "all_scores_below_cutoff" if not detections and diagnostic["candidates_above_cutoff"] == 0 else None}


if __name__ == "__main__":
    raise SystemExit(benchmark(Path(__file__).resolve().parent, load, predict))
