"""Offline checks of the Colab worker; no downloads or real model execution."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from contextlib import nullcontext, redirect_stdout
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('colab_dl', ROOT / 'colab_dl_benchmark.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class ColabTests(unittest.TestCase):
    def test_only_selected_models_and_cuda_variants(self):
        self.assertEqual(set(module.MODELS), {'CountGD', 'CountGD++', 'CounTX', 'YOLO-World-S'})
        for name in module.MODELS:
            requirements, variant = module.gpu_requirements(ROOT / 'DL-MODELS' / name)
            self.assertTrue(all('+cpu' not in r for r in requirements))
            self.assertIn('torch==2.8.0+cu126' if name == 'YOLO-World-S' else 'torch==2.2.1+cu121', requirements)
            self.assertEqual(variant, 'cu126' if name == 'YOLO-World-S' else 'cu121')

    def test_worker_warmup_sync_clean_schema_and_no_gold(self):
        for name in module.MODELS:
            calls, synchronized = [], []
            with tempfile.TemporaryDirectory() as path:
                repo = Path(path); folder = repo / 'DL-MODELS' / name; folder.mkdir(parents=True)
                images = repo / 'data/group1'; images.mkdir(parents=True)
                rows = [dict(group='1', id=str(i), image=f'{i}.jpg', label='objects', **{'actual-count': 999}) for i in range(6)]
                (images / 'metadata.json').write_text(json.dumps(rows)); (folder / 'setup-report.json').write_text('{"environment":{}}')
                def predict(state, image, item, folder, config, device):
                    self.assertEqual(set(item), {'group', 'id', 'image', 'label'}); self.assertEqual(device, 'cuda')
                    self.assertGreater(len(synchronized), len(calls)); calls.append(item['image'])
                    return {'count': 3.125, 'inference_seconds': .25}
                runner = SimpleNamespace(load=lambda *a: (None, None), predict=predict)
                loader = SimpleNamespace(exec_module=lambda *a: None)
                torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, get_device_capability=lambda: (7, 5),
                    get_device_name=lambda: 'Mock GPU', manual_seed_all=lambda *a: None,
                    synchronize=lambda: synchronized.append(True)), version=SimpleNamespace(cuda='12.1'),
                    set_num_threads=lambda *a: None, manual_seed=lambda *a: None, use_deterministic_algorithms=lambda *a: None,
                    backends=SimpleNamespace(cudnn=SimpleNamespace()), inference_mode=nullcontext)
                common = SimpleNamespace(digest=lambda *a: 'hash', packages=lambda: {}, write_json=module.write_json,
                    environment=lambda *a: None, configuration=lambda *a: {'model': name})
                numpy = SimpleNamespace(random=SimpleNamespace(seed=lambda *a: None))
                stdout = io.StringIO(); original_path = list(sys.path)
                try:
                    with patch.dict(sys.modules, {'torch': torch, 'numpy': numpy, 'common': common,
                            'MultiScaleDeformableAttention': SimpleNamespace(ms_deform_attn_forward=lambda: None)}), \
                        patch.object(module.runpy, 'run_path'), patch.object(module, 'run'), \
                        patch.object(module.importlib.util, 'spec_from_file_location', return_value=SimpleNamespace(loader=loader)), \
                        patch.object(module.importlib.util, 'module_from_spec', return_value=runner), redirect_stdout(stdout):
                        module.worker(name, repo, 2)
                finally: sys.path[:] = original_path
                self.assertEqual(len(calls), 8); self.assertEqual(len(synchronized), 16)
                result = json.loads(stdout.getvalue().split(module.RESULT_MARKER)[1])
                self.assertEqual(result['gpu'], 'Mock GPU'); self.assertEqual(len(result['result']['images']), 6)
                for image in result['result']['images']:
                    self.assertEqual(set(image), {'image', 'predicted_count', 'inference_seconds'})
                    self.assertEqual(image['predicted_count'], 3.125)


if __name__ == '__main__': unittest.main()
