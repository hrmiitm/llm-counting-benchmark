import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareData, confidenceSummary, coverageCurve, acceptance, priceDLConfig } from '../reasoning-data.mjs';
const metadata = JSON.parse(await readFile(new URL('../eval2/metadata.json', import.meta.url)));
const document = { provider: 'Google Colab', gpu: 'Test GPU (fixture, not a measurement)', hourly_cost_usd: null,
  models: ['CountGD', 'CountGD++', 'CounTX', 'YOLO-World-S'].map(model => ({ model,
    images: metadata.map((r, i) => ({ image: r.image, predicted_count: 100.375 + i, inference_seconds: .125 + i / 10 })) })) };
const source = () => [{ path: 'eval4/colab-dl.json', data: document }];
let data = prepareData(source(), metadata);
assert.equal(data.configs.length, 4);
for (const c of data.configs) {
  assert.equal(c.totalCost, null); assert.equal(c.costPerImage, null); assert.equal(c.costPer1000Images, null);
  assert.equal(c.complete, true); assert.equal(c.costEligible, false);
  assert.equal(confidenceSummary(c), null); assert.deepEqual(coverageCurve(c), []);
  assert.equal(c.rows[0].count, 100.375, 'Density counts are not rounded');
}
assert.equal(acceptance(data.configs, .9).denominator, 0, 'DL excluded from confidence denominator');
document.hourly_cost_usd = .75; // Synthetic arithmetic-test rate, not a price recommendation.
data = prepareData(source(), metadata);
for (const c of data.configs) {
  const raw = document.models.find(m => m.model === c.name);
  const seconds = raw.images.reduce((sum, row) => sum + row.inference_seconds, 0);
  const errors = raw.images.map(r => { const truth = metadata.find(m => m.image === r.image)['actual-count']; return Math.abs(r.predicted_count - truth) / truth * 100; });
  assert.equal(c.deviation, errors.reduce((sum, e) => sum + e, 0) / errors.length);
  assert.equal(c.totalInferenceSeconds, seconds);
  assert.equal(c.totalCost, seconds / 3600 * document.hourly_cost_usd);
  assert.equal(c.costPerImage, c.totalCost / 6); assert.equal(c.costPer1000Images, c.totalCost / 6 * 1000);
  assert.equal(c.costEligible, true);
}
const original = structuredClone(document);
const snapshot = structuredClone(data);
for (const rate of [0, .526, .540047, 1.5, null]) {
  for (const c of data.configs) {
    const priced = priceDLConfig(c, rate);
    assert.equal(priced.totalCost, rate === null ? null : c.totalInferenceSeconds / 3600 * rate);
    assert.equal(priced.costPerImage, rate === null ? null : priced.totalCost / c.n);
    assert.equal(priced.costPer1000Images, rate === null ? null : priced.totalCost / c.n * 1000);
    assert.equal(priced.deviation, c.deviation);
    assert.deepEqual(priced.rows.map(r => r.count), c.rows.map(r => r.count));
    assert.equal(priced.data, c.data, 'Saved envelope is retained, not rewritten');
    assert.equal(priced.costEligible, rate !== null);
    assert.equal(priceDLConfig(c).totalCost, c.totalCost, 'Default restores the saved rate');
  }
}
assert.deepEqual(data, snapshot, 'Pricing scenarios never mutate measured data');
const llm = { isDL: false, data: { hourly_cost_usd: null }, totalCost: .02 };
assert.equal(priceDLConfig(llm, .526), llm, 'LLM charges remain unchanged');
for (const bad of [-1, Infinity, NaN, '0.526']) assert.throws(() => priceDLConfig(data.configs[0], bad));
for (const mutation of [d => { d.hourly_cost_usd = -1; }, d => { d.models[0].model = 'FamNet'; },
  d => { d.models[0].images.pop(); }, d => { d.models[0].images[0] = d.models[0].images[1]; },
  d => { d.models[0].images[0].predicted_count = null; }, d => { d.models[0].images[0].inference_seconds = -1; }]) {
  const bad = structuredClone(original); mutation(bad);
  assert.throws(() => prepareData([{ path: 'eval4/colab-dl.json', data: bad }], metadata));
}
const directory = await mkdtemp(join(tmpdir(), 'colab-dl-import-test-'));
try {
  const input = join(directory, 'input.json'), output = join(directory, 'output.json');
  const raw = JSON.stringify(original); await writeFile(input, raw);
  const child = spawnSync(process.execPath, ['scripts/import-colab-dl.mjs', input, '--output', output], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(await readFile(output, 'utf8'), raw, 'Import preserves raw JSON bytes');
  assert.equal(JSON.parse(child.stdout).models.length, 4);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('PASS: synthetic Colab import, exact-image validation, fractional predictions, unknown/explicit prices, deviation/timing/cost formulas, confidence exclusion and CLI raw-data preservation.');
