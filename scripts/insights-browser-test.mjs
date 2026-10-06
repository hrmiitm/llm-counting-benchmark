// Uses the same local Chrome/CDP workflow as the existing website checks.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.INSIGHTS_URL ?? 'http://127.0.0.1:8765/insights.html';
const target = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0; const pending = new Map(); const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
};
const command = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}
async function loaded() {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.querySelector('#insights-content')?.hidden === false`)) return;
    if (await evaluate(`document.querySelector('#insights-status')?.classList.contains('error')`)) throw new Error(await evaluate(`document.querySelector('#insights-status').textContent`));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Page 3 did not load');
}
try {
  await command('Runtime.enable'); await command('Page.enable'); await command('Network.enable');
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base }); await command('Page.bringToFront'); await loaded();
  await new Promise(resolve => setTimeout(resolve, 180));
  if (await evaluate(`document.documentElement.dataset.theme!=='light'`)) await evaluate(`document.querySelector('#theme-toggle').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.chart-section').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('.rank-row').length`), 14);
  assert.equal(await evaluate(`document.querySelectorAll('.confidence-row').length`), 9);
  assert.equal(await evaluate(`document.querySelectorAll('#insights-sources a').length`), 14);
  assert.equal(await evaluate(`document.querySelector('.page-nav [aria-current]').textContent.trim()`), '03 Models & conclusions');
  const metadata = JSON.parse(await readFile(new URL('../eval2/metadata.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../eval2/manifest.json', import.meta.url)));
  const truth = Object.fromEntries(metadata.map(row => [row.image, row['actual-count']]));
  const docs = await Promise.all(manifest.files.filter(path => path.endsWith('_group1.json')).map(async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url)))));
  const dl = await Promise.all(['YOLO-World-S', 'FamNet', 'CounTX', 'CountGD', 'CountGD++'].map(async name => JSON.parse(await readFile(new URL(`../DL-MODELS/results/${name}.json`, import.meta.url)))));
  const observed = await evaluate(`[...document.querySelectorAll('.rank-row')].map(row=>({name:row.dataset.model,value:Number(row.dataset.deviation)}))`);
  for (const doc of [...docs, ...dl]) {
    const expected = doc.results.reduce((sum, row) => sum + Math.abs(row.model_count - truth[row.image]) / truth[row.image] * 100, 0) / 6;
    assert.equal(observed.find(row => row.name === doc.model).value, expected);
  }
  assert.equal(observed[0].name, 'CountGD');
  const point = await evaluate(`document.querySelector('.calibration-point').getAttribute('aria-label')`);
  await evaluate(`document.querySelector('.calibration-point').focus()`);
  assert.equal(await evaluate(`document.querySelector('#calibration-detail').textContent`), point);
  const options = await evaluate(`[...document.querySelector('#confidence-model').options].slice(1).map(option=>option.value)`);
  for (const model of options) {
    await evaluate(`document.querySelector('#confidence-model').value=${JSON.stringify(model)};document.querySelector('#confidence-model').dispatchEvent(new Event('change'))`);
    assert.deepEqual(await evaluate(`[...new Set([...document.querySelectorAll('.calibration-point')].map(point=>point.dataset.model))]`), [model]);
    assert.equal(await evaluate(`[...document.querySelectorAll('.calibration-point')].reduce((n,point)=>n+Number(point.dataset.samples),0)`), 6);
  }
  await evaluate(`document.querySelector('#confidence-model').value='all';document.querySelector('#confidence-model').dispatchEvent(new Event('change'));document.querySelector('#comparison-scope').value='nontrain';document.querySelector('#comparison-scope').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`document.querySelector('.rank-row').dataset.model`), 'CountGD++');
  assert.ok((await evaluate(`document.querySelector('#comparison-note').textContent`)).includes('three training images excluded'));
  const shared = await evaluate(`location.href`);
  await command('Page.navigate', { url: shared }); await loaded();
  assert.equal(await evaluate(`document.querySelector('#comparison-scope').value`), 'nontrain');
  await evaluate(`document.querySelector('#comparison-scope').value='all';document.querySelector('#comparison-scope').dispatchEvent(new Event('change'))`);
  for (const width of [1440, 390, 360, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 650 });
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, `Overflow at ${width}`);
    assert.equal(await evaluate(`(()=>{const svg=document.querySelector('#calibration-chart svg'),b=svg.getBoundingClientRect();return [...svg.querySelectorAll('text')].every(t=>{const r=t.getBoundingClientRect();return r.left>=b.left-1&&r.right<=b.right+1;});})()`), true, `Clipped chart text at ${width}`);
    await evaluate(`scrollTo(0,0)`);
    const light = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(`/tmp/count-insights-${width}.png`, Buffer.from(light.data, 'base64'));
    await evaluate(`document.querySelector('#theme-toggle').click()`);
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
    const dark = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(`/tmp/count-insights-dark-${width}.png`, Buffer.from(dark.data, 'base64'));
    await evaluate(`document.querySelector('#theme-toggle').click()`);
  }
  await command('Network.setBlockedURLs', { urls: ['*/DL-MODELS/results/CountGD.json*'] });
  await command('Page.navigate', { url: base });
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`document.querySelector('#insights-status')?.classList.contains('error')`)) break;
    if (i === 99) throw new Error('Missing-data notice did not appear');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate(`document.querySelector('#insights-content').hidden`), true);
  await command('Network.setBlockedURLs', { urls: [] });
  assert.deepEqual(errors, []);
  console.log('PASS: all 14 raw-data rankings, nine selectable LLMs, subset winner, focus details, URL state, desktop/mobile/light/dark layouts and missing-data guard.');
} finally {
  await command('Page.close'); socket.close();
}
