// Saved JSON and isolated Chrome only: no model requests and no result-file writes.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { prepareData, acceptance, confidenceSummary, isResultPath } from '../reasoning-data.mjs';
const base = process.env.REASONING_URL ?? 'http://127.0.0.1:8765/reasoning.html';
const cdp = process.env.REASONING_CDP ?? 'http://127.0.0.1:9222';
const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('eval2/metadata.json', root)));
const paths = (await readdir(new URL('eval4/', root))).map(p => `eval4/${p}`).filter(isResultPath).sort();
const sources = await Promise.all(paths.map(async path => ({ path, data: JSON.parse(await readFile(new URL(path, root))) })));
const expected = prepareData(sources, metadata);
const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0, override = null, colab = null; const pending = new Map(), errors = [];
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params }));
});
socket.onmessage = async event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
  if (message.method === 'Fetch.requestPaused') {
    try {
      const { requestId, request } = message.params;
      if (request.url.endsWith('/eval4/')) {
        await command('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' });
        return;
      }
      const response = request.url.endsWith('/reasoning-sources.json') ? { files: colab ? [...paths.filter(p => p !== 'eval4/colab-dl.json'), 'eval4/colab-dl.json'] : paths }
        : colab && request.url.endsWith('/eval4/colab-dl.json') ? colab
          : override && request.url.endsWith(`/${override.path}`) ? override.data : null;
      if (response) await command('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(response)).toString('base64') });
      else await command('Fetch.continueRequest', { requestId });
    } catch (error) { errors.push(error.message); }
  }
};
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function ready() {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(`document.querySelector('#load-status')?.classList.contains('error')`)) throw new Error(await evaluate(`document.querySelector('#load-status').textContent`));
    if (await evaluate(`document.querySelector('#page-content')?.hidden===false && document.querySelector('#refresh')?.disabled===false`)) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error('Page 4 did not load.');
}
async function choose(model) {
  await evaluate(`document.querySelector('#model-filter').value=${JSON.stringify(model)};document.querySelector('#model-filter').dispatchEvent(new Event('change'))`);
}
try {
  await command('Runtime.enable'); await command('Page.enable'); await command('Network.enable');
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base }); await command('Page.bringToFront'); await ready();
  assert.equal(await evaluate(`document.querySelectorAll('.plot').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#records-body tr').length`), expected.configs.length);
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`), expected.configs.filter(c => c.costEligible).length);
  assert.equal(await evaluate(`document.querySelector('#coverage').open`), false, 'Coverage is optional and closed initially');
  assert.equal(await evaluate(`document.querySelector('#records').open`), false, 'Detailed table is collapsed initially');
  const summaries = expected.configs.map(confidenceSummary).filter(Boolean);
  const confidencePoints = await evaluate(`[...document.querySelectorAll('.confidence-point')].map(p=>({model:p.dataset.model,effort:p.dataset.effort,confidence:Number(p.dataset.x),deviation:Number(p.dataset.deviation),images:Number(p.dataset.imageCount)}))`);
  assert.equal(confidencePoints.length, summaries.length, 'One confidence point per model/effort, not per image');
  for (const summary of summaries) {
    const point = confidencePoints.find(p => p.model === summary.model && p.effort === summary.effort);
    assert.equal(point.confidence, summary.confidence * 100);
    assert.equal(point.deviation, summary.deviation);
    assert.equal(point.images, summary.n);
  }
  await evaluate(`document.querySelector('#coverage').open=true`);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate(`(()=>[...document.querySelectorAll('.plot svg')].every(svg=>{const points=[...svg.querySelectorAll('.mark')].map(p=>({error:Number(p.dataset.deviation),y:p.getBBox().y+p.getBBox().height/2})).sort((a,b)=>a.error-b.error);return points.every((p,i)=>!i||p.y<=points[i-1].y+1e-6);}))()`), true, 'Larger counting error must appear higher in all three charts');
  assert.ok((await evaluate(`document.querySelector('#coverage .section-intro').textContent`)).includes('curve rises'));
  const records = await evaluate(`[...document.querySelectorAll('#records-body tr')].map(r=>({model:r.dataset.model,effort:r.dataset.effort,deviation:r.dataset.deviation,cost:r.dataset.cost}))`);
  for (const c of expected.configs) {
    const row = records.find(r => r.model === c.model && r.effort === c.effort);
    assert.equal(Number(row.deviation), c.deviation);
    if (c.totalCost !== null) assert.equal(Number(row.cost), c.totalCost);
  }
  const label = await evaluate(`document.querySelector('.cost-point').getAttribute('aria-label')`);
  await evaluate(`document.querySelector('.cost-point').focus()`);
  assert.ok((await evaluate(`document.querySelector('#cost-detail').textContent`)).startsWith(label),
    JSON.stringify({ label, observed: await evaluate(`document.querySelector('#cost-detail').textContent`) }));
  for (const model of expected.models) {
    await choose(model);
    assert.deepEqual(await evaluate(`[...new Set([...document.querySelectorAll('.confidence-point')].map(p=>p.dataset.model))]`), summaries.some(c => c.model === model) ? [model] : []);
    assert.equal(await evaluate(`document.querySelectorAll('#records-body tr').length`), expected.configs.filter(c => c.model === model).length);
  }
  await evaluate(`const high=document.querySelector('input[name=effort][value=high]');high.checked=false;high.dispatchEvent(new Event('change'));document.querySelector('#cost-scale').value='log';document.querySelector('#cost-scale').dispatchEvent(new Event('change'))`);
  await evaluate(`document.querySelector('.hero-aside a[href="#coverage"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#model-filter').value`), expected.models.at(-1), 'Section navigation preserves the model filter');
  assert.ok((await evaluate(`location.hash`)).startsWith('#coverage?'));
  const shared = await evaluate(`location.href`); await command('Page.navigate', { url: shared }); await ready();
  assert.equal(await evaluate(`document.querySelector('input[name=effort][value=high]').checked`), false);
  assert.equal(await evaluate(`document.querySelector('#cost-scale').value`), 'log');
  assert.equal(await evaluate(`document.querySelector('#model-filter').value`), expected.models.at(-1));
  await choose('all');
  await evaluate(`document.querySelector('input[name=effort][value=high]').checked=true;document.querySelector('input[name=effort][value=high]').dispatchEvent(new Event('change'));document.querySelector('#cost-scale').value='linear';document.querySelector('#cost-scale').dispatchEvent(new Event('change'));document.querySelector('#confidence-cutoff').value=90;document.querySelector('#confidence-cutoff').dispatchEvent(new Event('input'))`);
  const accepted = acceptance(expected.configs, .9);
  assert.ok((await evaluate(`document.querySelector('#cutoff-reading').textContent`)).includes(`${accepted.accepted}/${accepted.denominator}`));
  await evaluate(`document.querySelector('#coverage').open=false`);
  for (const width of [1440, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 650 });
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, `Page overflow at ${width}`);
    assert.equal(await evaluate(`(()=>[...document.querySelectorAll('.plot svg')].every(svg=>{const b=svg.getBoundingClientRect();return [...svg.querySelectorAll('text')].every(t=>{const r=t.getBoundingClientRect();return r.left>=b.left-1&&r.right<=b.right+1;});}))()`), true, `Clipped chart labels at ${width}`);
    for (const theme of ['light', 'dark']) {
      if (await evaluate(`document.documentElement.dataset.theme!==${JSON.stringify(theme)}`)) await evaluate(`document.querySelector('#theme-toggle').click()`);
      await evaluate(`scrollTo({top:0,behavior:'instant'})`);
      const metrics = await command('Page.getLayoutMetrics');
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: metrics.cssContentSize.height, scale: 1 } });
      await writeFile(`/tmp/count-reasoning-${theme}-${width}.png`, Buffer.from(screenshot.data, 'base64'));
      if (width === 1440) {
        await evaluate(`document.querySelector('#cost').scrollIntoView({behavior:'instant'})`);
        const chart = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(`/tmp/count-reasoning-cost-${theme}.png`, Buffer.from(chart.data, 'base64'));
      }
    }
  }
  // Simulate the rendered GitHub Pages file index, with directory listings disabled.
  await command('Fetch.enable', { patterns: [{ urlPattern: '*reasoning-sources.json' }, { urlPattern: '*eval4/' }] });
  await command('Page.navigate', { url: base }); await ready();
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`), expected.configs.filter(c => c.costEligible).length);
  // Change one fetched JSON without editing disk: prove the page recomputes its values.
  const original = sources.find(s => s.data.reasoning?.effort === 'low');
  override = structuredClone(original); override.data.results[0].model_count += 100;
  await command('Fetch.enable', { patterns: [{ urlPattern: '*reasoning-sources.json' }, { urlPattern: '*eval4/' }, { urlPattern: `*${original.path}` }] });
  await evaluate(`document.querySelector('#refresh').click()`); await ready();
  const altered = prepareData(sources.map(s => s.path === override.path ? override : s), metadata).configs.find(c => c.path === override.path);
  const changeObserved = await evaluate(`[...document.querySelectorAll('#records-body tr')].find(r=>r.dataset.model===${JSON.stringify(altered.model)}&&r.dataset.effort==='low').dataset.deviation`);
  assert.equal(Number(changeObserved), altered.deviation);
  assert.equal(await evaluate(`[...document.querySelectorAll('.confidence-point')].find(p=>p.dataset.model===${JSON.stringify(altered.model)}&&p.dataset.effort==='low').dataset.deviation`), String(altered.deviation));
  override.data.results[0].cost_usd = null;
  await evaluate(`document.querySelector('#refresh').click()`); await ready();
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`), expected.configs.filter(c => c.costEligible).length - 1);
  assert.ok((await evaluate(`document.querySelector('#data-notices').textContent`)).includes('unknown charges'));
  assert.equal(await evaluate(`document.querySelectorAll('.confidence-point').length`), summaries.length);
  override.data.results[0].confidence = null;
  await evaluate(`document.querySelector('#refresh').click()`); await ready();
  assert.equal(await evaluate(`document.querySelectorAll('.confidence-point').length`), summaries.length - 1);
  override = null;
  // Synthetic Colab records stay in memory; no invented benchmark file is saved.
  colab = { provider: 'Google Colab', gpu: 'Test GPU (fixture)', hourly_cost_usd: null,
    models: ['CountGD', 'CountGD++', 'CounTX', 'YOLO-World-S'].map(model => ({ model,
      images: metadata.map((r, i) => ({ image: r.image, predicted_count: 100.375 + i, inference_seconds: .125 + i / 10 })) })) };
  await command('Fetch.enable', { patterns: [{ urlPattern: '*reasoning-sources.json' }, { urlPattern: '*eval4/colab-dl.json' }] });
  await command('Page.navigate', { url: base }); await ready();
  const llmSources = sources.filter(s => s.data.provider !== 'Google Colab');
  const combined = prepareData([...llmSources, { path: 'eval4/colab-dl.json', data: colab }], metadata);
  const llmPoints = combined.configs.filter(c => !c.isDL && c.costEligible).length;
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`), llmPoints, 'Absent hourly rate cannot create zero-cost DL points');
  assert.equal(await evaluate(`document.querySelector('#quality').hidden`), false);
  assert.equal(await evaluate(`document.querySelectorAll('.quality-row').length`), combined.configs.filter(c => c.complete).length);
  const llmConfidence = combined.configs.map(confidenceSummary).filter(Boolean).length;
  assert.equal(await evaluate(`document.querySelectorAll('.confidence-point').length`), llmConfidence);
  colab.hourly_cost_usd = .75; // Test arithmetic only, never a suggested cloud price.
  await evaluate(`document.querySelector('#refresh').click()`); await ready();
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`), llmPoints + 4);
  await choose('CountGD');
  assert.equal(await evaluate(`document.querySelectorAll('.cost-point').length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll('.confidence-point').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#confidence').hidden`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.quality-row').length`), 1);
  for (const width of [1440, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 650 });
    await evaluate(`document.querySelector('#quality').open=true;document.querySelector('#records').open=true`);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, `DL overflow at ${width}`);
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(`/tmp/count-colab-import-${width}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  await choose('all');
  assert.equal(await evaluate(`document.querySelector('#confidence').hidden`), false);
  assert.equal(await evaluate(`document.querySelectorAll('.confidence-point').length`), llmConfidence);
  colab = null; await command('Fetch.disable');
  await command('Network.setBlockedURLs', { urls: ['*/eval4/*_group1.json*'] });
  await command('Page.navigate', { url: base });
  for (let i = 0; i < 150; i++) {
    if (await evaluate(`document.querySelector('#load-status')?.classList.contains('error')`)) break;
    if (i === 149) throw new Error('Missing-data state did not appear.');
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  assert.equal(await evaluate(`document.querySelector('#page-content').hidden`), true);
  assert.deepEqual(errors, []);
  console.log('PASS: full-image mean confidence/error points, conventional Y axes, optional details, raw-data values, model/effort filters, focus, URL state, mobile/light/dark layouts, static-host discovery, changed JSON and missing-data guards.');
} finally { await command('Page.close'); socket.close(); }
