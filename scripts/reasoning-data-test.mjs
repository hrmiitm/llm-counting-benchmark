import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { prepareData, coverageCurve, acceptance, reasoningPairs, confidenceSummary, countAccuracy, priceDLConfig, EFFORTS } from '../reasoning-data.mjs';

const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('eval2/metadata.json', root)));
const inputMetadata = JSON.parse(await readFile(new URL('data/group1/metadata.json', root)));
assert.equal(metadata.length, 6);
const keys = rows => rows.map(r => `${r.group}|${r.image}`).sort();
assert.deepEqual(keys(metadata), keys(inputMetadata), 'Scoring metadata uses the existing six images');
for (const row of metadata) assert.equal(row['actual-count'], inputMetadata.find(r => String(r.group) === String(row.group) && r.image === row.image)['actual-count']);
const paths = (await readdir(new URL('eval4/', root))).filter(p => p.endsWith('_group1.json')).sort();
const sources = await Promise.all(paths.map(async path => ({ path: `eval4/${path}`,
  data: JSON.parse(await readFile(new URL(`eval4/${path}`, root))) })));
const data = prepareData(sources, metadata);
assert.equal(data.configs.length, sources.length);
for (const config of data.configs) {
  const raw = sources.find(s => s.path === config.path).data;
  assert.deepEqual(keys(raw.results), keys(metadata), `${raw.model}/${raw.reasoning.effort}: exact six-image set`);
  assert.equal(new Set(keys(raw.results)).size, 6, 'Each image appears once');
  const valid = raw.results.filter(r => r.status === 'success');
  const truth = new Map(metadata.map(r => [`${r.group}|${r.image}`, r['actual-count']]));
  const deviations = valid.map(r => Math.abs(r.model_count - truth.get(`${r.group}|${r.image}`)) / truth.get(`${r.group}|${r.image}`) * 100);
  assert.equal(config.deviation, deviations.reduce((n, x) => n + x, 0) / deviations.length);
  const accuracies = valid.map(r => {
    const actual = truth.get(`${r.group}|${r.image}`);
    return r.model_count === 0 && actual === 0 ? 100 : Math.min(r.model_count, actual) / Math.max(r.model_count, actual) * 100;
  });
  assert.equal(config.accuracy, accuracies.reduce((n, x) => n + x, 0) / accuracies.length);
  assert.equal(config.totalCost, raw.results.reduce((sum, r) => sum + r.cost_usd, 0));
  const summary = confidenceSummary(config);
  if (config.complete && valid.every(r => typeof r.confidence === 'number')) {
    assert.equal(summary.imageCount, metadata.length);
    assert.equal(summary.confidence, valid.reduce((n, r) => n + r.confidence, 0) / valid.length);
    assert.equal(summary.deviation, config.deviation);
    assert.equal(summary.accuracy, config.accuracy);
  }
  const curve = coverageCurve(config);
  assert.equal(curve.at(-1).accepted, valid.filter(r => typeof r.confidence === 'number').length);
  for (const point of curve) {
    const accepted = valid.filter(r => r.confidence >= point.confidence);
    const errors = accepted.map(r => Math.abs(r.model_count - truth.get(`${r.group}|${r.image}`)) / truth.get(`${r.group}|${r.image}`) * 100);
    assert.equal(point.coverage, accepted.length / metadata.length * 100);
    assert.ok(Math.abs(point.deviation - errors.reduce((n, x) => n + x, 0) / errors.length) < 1e-10);
  }
}

const dl = JSON.parse(await readFile(new URL('eval4/colab-dl.json', root)));
const dlData = prepareData([{ path: 'eval4/colab-dl.json', data: dl }], metadata);
const pricing = JSON.parse(await readFile(new URL('dl-pricing.json', root)));
for (const config of dlData.configs) {
  const raw = dl.models.find(m => m.model === config.model);
  assert.deepEqual(raw.images.map(r => r.image).sort(), metadata.map(r => r.image).sort());
  const errors = raw.images.map(r => { const actual = metadata.find(m => m.image === r.image)['actual-count']; return Math.abs(r.predicted_count - actual) / actual * 100; });
  assert.equal(config.deviation, errors.reduce((sum, x) => sum + x, 0) / 6);
  const accuracies = raw.images.map(r => { const actual = metadata.find(m => m.image === r.image)['actual-count']; return Math.min(r.predicted_count, actual) / Math.max(r.predicted_count, actual) * 100; });
  assert.equal(config.accuracy, accuracies.reduce((sum, x) => sum + x, 0) / 6);
  assert.equal(config.totalInferenceSeconds, raw.images.reduce((sum, r) => sum + r.inference_seconds, 0));
  assert.equal(confidenceSummary(config), null);
  for (const rate of pricing.presets.map(p => p.hourly_cost_usd)) {
    assert.equal(priceDLConfig(config, rate).totalCost, rate === null ? null : raw.images.reduce((sum, r) => sum + r.inference_seconds, 0) / 3600 * rate);
  }
}
for (const [predicted, actual, expected] of [[0, 0, 100], [0, 100, 0], [100, 0, 0], [98, 100, 98], [200, 100, 50], [100, 200, 50], [5.5, 10, 55]]) {
  assert.ok(Math.abs(countAccuracy(predicted, actual) - expected) < 1e-10);
}
for (const [predicted, actual] of [[null, 10], [10, null], [-1, 10], [Infinity, 10]]) assert.equal(countAccuracy(predicted, actual), null);

const fixtureMetadata = [
  { group: '1', image: 'a.jpg', label: 'objects', 'actual-count': 100 },
  { group: '1', image: 'b.jpg', label: 'objects', 'actual-count': 100 },
  { group: '1', image: 'c.jpg', label: 'objects', 'actual-count': 100 },
];
const fixture = { model: 'example/model', run_id: '2026-10-01T00:00:00Z', prompt: 'same prompt',
  model_temp: null, max_tokens: 32768, provider_endpoint: 'example', tools: [], tool_choice: 'none',
  allow_fallbacks: false, reasoning: { enabled: true, exclude: true, effort: 'low' }, confidence_scale: '0-1',
  results: [98, 110, 140].map((count, i) => ({ group: '1', image: `${'abc'[i]}.jpg`, model_count: count,
    confidence: [.9, .9, .1][i], cost_usd: .01, status: 'success', attempt_count: 1 })) };
const single = doc => [{ path: 'eval4/example_model.json', data: doc }];
let config = prepareData(single(fixture), fixtureMetadata).configs[0];
assert.equal(config.rows[0].deviation, 2, 'Close answers receive a small numerical deviation');
assert.equal(confidenceSummary(config).confidence, (.9 + .9 + .1) / 3);
assert.equal(confidenceSummary(config).deviation, (2 + 10 + 40) / 3);
assert.equal(confidenceSummary(config).accuracy, (98 + 100 / 110 * 100 + 100 / 140 * 100) / 3);
assert.equal(confidenceSummary(config).imageCount, 3);
assert.deepEqual(coverageCurve(config).map(p => p.accepted), [2, 3], 'Equal confidence enters together');
assert.equal(acceptance([config], .95).deviation, null, 'No accepted answers has no mean error');
const failed = structuredClone(fixture);
failed.results[2] = { ...failed.results[2], status: 'failed', model_count: null, confidence: null, cost_usd: null };
config = prepareData(single(failed), fixtureMetadata).configs[0];
assert.equal(config.complete, false); assert.equal(config.costEligible, false); assert.equal(config.totalCost, null);
assert.equal(confidenceSummary(config), null, 'Partial image sets must not become full-run mean points');
assert.equal(config.knownCost, .02); assert.equal(config.unknownCosts, 1);
assert.equal(coverageCurve(config).at(-1).coverage, 2 / 3 * 100, 'Failures reduce maximum coverage');
const unknown = structuredClone(fixture); unknown.results[0].cost_usd = null;
config = prepareData(single(unknown), fixtureMetadata).configs[0];
assert.equal(config.complete, true); assert.equal(config.costEligible, false); assert.equal(config.unknownCosts, 1);
assert.ok(confidenceSummary(config), 'Unknown cost does not invalidate a full confidence/error summary');
const missingConfidence = structuredClone(fixture); missingConfidence.results[0].confidence = null;
assert.equal(confidenceSummary(prepareData(single(missingConfidence), fixtureMetadata).configs[0]), null,
  'Missing confidence cannot be averaged over a different cohort from counting error');
const smoke = { path: 'eval4/smoke-test/newer.json', data: { ...fixture, run_id: '2099-01-01T00:00:00Z' } };
assert.equal(prepareData([...single(fixture), smoke], fixtureMetadata).configs[0].data.run_id, fixture.run_id);
const levels = EFFORTS.map(effort => ({ path: `eval4/${effort}.json`, data: { ...structuredClone(fixture), reasoning: { ...fixture.reasoning, effort } } }));
assert.equal(reasoningPairs(prepareData(levels, fixtureMetadata).configs).length, 1);
levels[1].data.max_tokens = 4096;
assert.equal(reasoningPairs(prepareData(levels, fixtureMetadata).configs).length, 0, 'Different settings block reasoning-effect conclusions');
assert.ok(prepareData(levels, fixtureMetadata).warnings.some(w => w.includes('different non-effort settings')));
levels[1].data.max_tokens = 32768;
levels[1].data.reasoning.max_tokens = 2000;
assert.equal(reasoningPairs(prepareData(levels, fixtureMetadata).configs).length, 0, 'Other reasoning controls must also match');
const conflicting = [...fixtureMetadata, { ...fixtureMetadata[0], 'actual-count': 200 }];
assert.equal(prepareData(single(fixture), conflicting).configs[0].rows[0].deviation, null);
const duplicate = structuredClone(fixture); duplicate.results.push(duplicate.results[0]);
assert.equal(prepareData(single(duplicate), fixtureMetadata).configs[0].complete, false);
assert.equal(confidenceSummary(prepareData(single(duplicate), fixtureMetadata).configs[0]), null);
const wrongImages = structuredClone(fixture); wrongImages.results[0].image = 'foreign.jpg';
assert.equal(confidenceSummary(prepareData(single(wrongImages), fixtureMetadata).configs[0]), null);
const wrongGroup = structuredClone(fixture); wrongGroup.results[0].group = '2';
assert.equal(confidenceSummary(prepareData(single(wrongGroup), fixtureMetadata).configs[0]), null);
const zeros = structuredClone(fixture); zeros.results[0].model_count = 0;
const zeroTruth = fixtureMetadata.map(r => ({ ...r, 'actual-count': 0 }));
const zeroSummary = confidenceSummary(prepareData(single(zeros), zeroTruth).configs[0]);
assert.equal(zeroSummary.accuracy, 100 / 3, 'Zero truths have defined count accuracy even though percentage deviation is undefined');
const changed = structuredClone(fixture); changed.results[0].model_count = 1000;
assert.notEqual(prepareData(single(changed), fixtureMetadata).configs[0].deviation,
  prepareData(single(fixture), fixtureMetadata).configs[0].deviation, 'Changed JSON changes computed values');
console.log(`PASS: ${sources.length} saved configurations independently scored; tied confidence, partial coverage, unknown costs, conflicting counts, smoke exclusion, settings mismatch and changed-JSON behavior.`);
