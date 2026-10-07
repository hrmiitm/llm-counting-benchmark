// Standard-library-only import and scoring. No inference and no LLM input files.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { prepareData } from '../reasoning-data.mjs';

const [input, ...args] = process.argv.slice(2);
if (!input || (args.length && (args[0] !== '--output' || args.length !== 2))) {
  console.error('Usage: node scripts/import-colab-dl.mjs INPUT.json [--output eval4/colab-dl.json]');
  process.exit(1);
}
try {
  const raw = await readFile(input, 'utf8'), doc = JSON.parse(raw);
  if (doc.provider !== 'Google Colab') throw new Error('Expected Google Colab DL benchmark JSON.');
  const metadata = JSON.parse(await readFile(new URL('../eval2/metadata.json', import.meta.url)));
  const prepared = prepareData([{ path: 'eval4/colab-dl.json', data: doc }], metadata);
  const models = prepared.configs.map(c => ({ model: c.name,
    images: c.rows.map(r => ({ image: r.image, predicted_count: r.count,
      absolute_percentage_count_deviation: r.deviation, inference_seconds: r.raw.inference_seconds,
      compute_cost_usd: r.cost })), mean_deviation: c.deviation,
    total_inference_seconds: c.totalInferenceSeconds, compute_cost_usd: c.totalCost,
    cost_per_image_usd: c.costPerImage, cost_per_1000_images_usd: c.costPer1000Images }));
  const destination = resolve(args[1] ?? new URL('../eval4/colab-dl.json', import.meta.url).pathname);
  if (resolve(input) !== destination) {
    try {
      if (JSON.parse(await readFile(destination, 'utf8')).provider !== 'Google Colab') throw new Error('Refusing to overwrite unrelated existing JSON.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(`${destination}.tmp`, raw); await rename(`${destination}.tmp`, destination);
  }
  console.error(`Imported ${doc.models.length} models to ${destination}; saved inputs are unchanged.`);
  console.log(JSON.stringify({ provider: doc.provider, gpu: doc.gpu, hourly_cost_usd: doc.hourly_cost_usd, models }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
