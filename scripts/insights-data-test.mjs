import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareData, statistics, calibrationBins, confidenceCutoff, DL_SOURCES } from '../insights-data.mjs';
const read = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const metadata = await read('eval2/metadata.json');
const dataset = await read('DL-MODELS/dataset-info.json');
const manifest = await read('eval2/manifest.json');
const paths = [...manifest.files.filter(path => path.endsWith('_group1.json')), ...DL_SOURCES];
const sources = await Promise.all(paths.map(async path => ({ path, data: await read(path) })));
const prepared = prepareData(sources, metadata, dataset);
assert.equal(prepared.models.length, 14);
assert.equal(prepared.models.flatMap(model => model.rows).length, 84);
const truth = new Map(metadata.map(row => [row.image, row['actual-count']]));
// Independent calculations use saved rows, not the page's scoring functions.
for (const { path, data } of sources) {
  const model = prepared.models.find(model => model.path === path);
  if (!model) continue;
  for (const scope of ['all', 'nontrain']) {
    const rows = data.results.filter(row => scope === 'all' || dataset.images[row.image] !== 'train');
    const expected = rows.reduce((sum, row) => sum + Math.abs(row.model_count - truth.get(row.image)) / truth.get(row.image) * 100, 0) / rows.length;
    assert.equal(statistics(model, scope).deviation, expected);
    assert.equal(statistics(model, scope).n, scope === 'all' ? 6 : 3);
  }
  if (model.kind === 'llm') {
    const brier = data.results.reduce((sum, row) => sum + (row.confidence - Number(row.model_count === truth.get(row.image))) ** 2, 0) / 6;
    assert.equal(statistics(model).brier, brier);
    assert.equal(calibrationBins(model.rows).reduce((sum, bin) => sum + bin.n, 0), 6);
  } else {
    assert.equal(statistics(model).brier, null);
    assert.equal(calibrationBins(model.rows).length, 0);
  }
}
assert.equal(prepared.models.map(model => statistics(model)).sort((a, b) => a.deviation - b.deviation)[0].name, 'CountGD');
assert.equal(prepared.models.map(model => statistics(model, 'nontrain')).sort((a, b) => a.deviation - b.deviation)[0].name, 'CountGD++');
assert.deepEqual(confidenceCutoff(prepared.models), { n: 12, wrong: 8 });
assert.equal(prepared.models.filter(model => model.kind === 'llm').map(model => statistics(model)).sort((a, b) => a.brier - b.brier)[0].name, 'google/gemini-3.8-flash');
assert.deepEqual(calibrationBins([{ confidence: 0, correct: 0 }, { confidence: .2, correct: 1 }, { confidence: 1, correct: 1 }]).map(bin => [bin.band, bin.n]), [[0, 1], [1, 1], [4, 1]]);
assert.throws(() => prepareData(sources.slice(1), metadata, dataset), /nine original/);
const failed = structuredClone(sources); failed.find(source => source.path === DL_SOURCES[0]).data.results[0].status = 'failed';
assert.throws(() => prepareData(failed, metadata, dataset), /Unsuccessful prediction/);
const fakeConfidence = structuredClone(sources); fakeConfidence.find(source => source.path === DL_SOURCES[0]).data.results[0].confidence = .95;
assert.throws(() => prepareData(fakeConfidence, metadata, dataset), /Detection score/);
const duplicate = structuredClone(metadata); duplicate[1] = duplicate[0];
assert.throws(() => prepareData(sources, duplicate, dataset), /Duplicate/);
console.log('PASS: 84 saved predictions, 14 rankings, subset changes, confidence/Brier calculations, boundary bins and incomplete-data guards.');
