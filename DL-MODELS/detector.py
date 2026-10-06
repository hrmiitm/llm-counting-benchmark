"""Whole-image text-only wrappers; no SAM normalization or adaptive crops."""
import argparse
import sys
from pathlib import Path
from common import digest, timed_forward


def load(folder, config, device):
    import torch
    sys.path.insert(0, str(folder / "upstream"))
    from util.slconfig import SLConfig
    from util.misc import nested_tensor_from_tensor_list
    if config["model"] == "CountGD++":
        from models.GroundingDINO.groundingdino_app import build_groundingdino
        import datasets.transforms as T
    else:
        from models.GroundingDINO.groundingdino import build_groundingdino
        import datasets_inference.transforms as T
    settings = SLConfig.fromfile(str(folder / "upstream" / config["inference"]["model_config"]))
    values = settings._cfg_dict.to_dict()
    values.update(device=device, text_encoder_type=str(folder / "weights/bert-base-uncased"),
                  use_checkpoint=False, use_transformer_ckpt=False)
    args = argparse.Namespace(**values)
    model, _, _ = build_groundingdino(args)
    checkpoint = torch.load(folder / config["checkpoint"], map_location="cpu", weights_only=False)
    weights = checkpoint["model"]
    expected_keys = model.state_dict()
    unused = []
    for key in config.get("unused_checkpoint_keys", []):
        if key in expected_keys:
            raise ValueError(f"Configured unused key is required by inference: {key}")
        if key in weights:
            unused.append(key)
            del weights[key]
    model.load_state_dict(weights, strict=True)
    del checkpoint
    model = model.to(device).eval()
    transform = T.Compose([T.RandomResize([config["inference"]["resize_short_side"]],
                            max_size=config["inference"]["max_size"]),
                           T.ToTensor(), T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    return (model, transform, nested_tensor_from_tensor_list), {
        "checkpoint_sha256": digest(folder / config["checkpoint"]),
        "state_dict_loading": "strict for all inference parameters", "unused_checkpoint_keys": unused,
        "model_config_sha256": digest(folder / "upstream" / config["inference"]["model_config"]),
        "deformable_attention": "upstream PyTorch CPU fallback" if device == "cpu" else "upstream compiled CUDA extension"}


def predict(state, image_path, item, folder, config, device):
    import torch
    from PIL import Image
    model, transform, nested = state
    image = Image.open(image_path).convert("RGB")
    width, height = image.size
    tensor, _ = transform(image, None)
    tensor = tensor.unsqueeze(0).to(device)
    empty = torch.empty((0, 4), device=device)
    caption = item["label"] + " ."
    if config["model"] == "CountGD++":
        function = lambda: model(nested(tensor), nested(tensor), [empty], [], [], captions=[caption])
    else:
        function = lambda: model(tensor, [empty], [torch.tensor([0], device=device)], captions=[caption])
    output, seconds = timed_forward(torch, device, function)
    scores = output["pred_logits"][0].sigmoid()
    if not torch.isfinite(scores).all() or not torch.isfinite(output["pred_boxes"]).all():
        raise ValueError("Non-finite detector output")
    threshold = config["inference"]["confidence_threshold"]
    if config["model"] == "CountGD++":
        # Preserve the demo's positive-vs-negative token filtering, even with no
        # negative description. The separator token belongs to the positive side.
        token_ids = output["input_ids"][0]
        split = (token_ids == 1012).nonzero().flatten()
        if len(split) != 1:
            raise ValueError("Unexpected text separator layout")
        positive = scores[:, :int(split[0]) + 1].max(dim=-1).values
        negative = scores[:, int(split[0]) + 1:].max(dim=-1).values
        keep = (positive > threshold) & (positive > negative)
        raw_max = float(positive.max())
    else:
        keep = scores.max(dim=-1).values > threshold
        raw_max = float(scores.max())
    retained_scores = scores.max(dim=-1).values[keep].detach().cpu().tolist()
    boxes = output["pred_boxes"][0][keep].detach().cpu().tolist()
    detections = []
    for (cx, cy, bw, bh), score in zip(boxes, retained_scores):
        detections.append({"xyxy": [(cx - bw / 2) * width, (cy - bh / 2) * height,
                                     (cx + bw / 2) * width, (cy + bh / 2) * height],
                           "score": score, "label": item["label"]})
    return {"count": len(detections), "inference_seconds": seconds, "class_prompt": item["label"],
            "caption": caption, "image_shape": [height, width], "detections": detections,
            "max_detection_score_before_filter": raw_max, "query_count": int(scores.shape[0]),
            "preprocessed_shape": list(tensor.shape),
            "zero_detection_reason": "no_queries_retained_by_configured_filters" if not detections else None}
