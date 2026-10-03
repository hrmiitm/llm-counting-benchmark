// Run against a local server and headless Chrome with --remote-debugging-port=9222.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { auditResults } from './audit-results.mjs';
const target = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.id && pending.has(message.id)) {
    const request = pending.get(message.id); pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  }
};
function command(method, params = {}) {
  return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: process.env.PORTAL_URL ?? 'http://127.0.0.1:8765/' });
  await command('Page.bringToFront');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(`typeof state !== 'undefined' && !document.querySelector('#reload').disabled && state.groups.length > 0`)) break;
    if (attempt === 99) throw new Error('Results did not load');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate(`state.warnings.length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.group tbody tr[data-config]').length`), await evaluate(`state.groups.reduce((sum,g)=>sum+g.models.length,0)`));
  await evaluate(`Promise.all([...document.images].map(image=>image.decode()))`);
  assert.equal(await evaluate(`[...document.images].every(image=>image.complete && image.naturalWidth > 0)`), true);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);

  // Confidence plots: real JSON, tied cutoffs, missing answers, and bin boundaries.
  assert.equal(await evaluate(`document.querySelectorAll('.chart-card').length`), 2);
  assert.ok(await evaluate(`document.querySelectorAll('.chart-point').length`) > 0);
  assert.equal(await evaluate(`document.querySelectorAll('#setup-notes li').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#model-observations li').length`), 3);
  await evaluate(`metrics.forEach(metric=>metric.show=true);render()`);
  await auditResults(evaluate);
  await evaluate(`metrics.find(metric=>metric.key==='deviation').show=false;render()`);
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.metric-value')).fontSize)`) >= 14);
  assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('.overview li')).fontSize)`) >= 15);
  assert.equal(await evaluate(`document.querySelector('.method-notes').open`), false);
  assert.deepEqual(await evaluate(`calibrationPoints([{probability:0,correct:1},{probability:1,correct:0},{probability:.9,correct:1}])`),
    [{x:0,y:1,n:1,correct:1,low:0,high:.2},{x:.95,y:.5,n:2,correct:1,low:.8,high:1}]);
  assert.deepEqual(await evaluate(`riskPoints([{probability:.9,correct:1},{probability:.9,correct:0},{probability:.2,correct:0}],4)`),
    [{x:.5,y:.5,n:2,errors:1,threshold:.9},{x:.75,y:2/3,n:3,errors:2,threshold:.2}]);
  assert.deepEqual(await evaluate(`riskPoints([],0)`), []);
  assert.equal(await evaluate(`(()=>{
    const rows=visibleRows();
    return rows.every(row=>{
      const usable=row.imageRecords.map(i=>({i,p:prediction(row.model,i)})).filter(({i,p})=>!i.conflict&&i.actual!==null&&p?.status==='success'&&Number.isInteger(p.model_count)&&p.model_count>=0&&typeof p.confidence==='number');
      const dots=[...document.querySelectorAll('[data-chart="calibration"] circle')].filter(dot=>dot.dataset.config===row.model.key);
      const binned=calibrationPoints(confidenceSamples(row));
      return usable.length===binned.reduce((s,p)=>s+p.n,0)&&dots.length===binned.length&&dots.every((dot,j)=>Math.abs(Number(dot.getAttribute('cx'))-(55+440*binned[j].x))<1e-8&&Math.abs(Number(dot.getAttribute('cy'))-(247-204*binned[j].y))<1e-8);
    });
  })()`), true);
  await evaluate(`document.querySelector('.chart-point').focus()`);
  assert.equal(await evaluate(`document.querySelector('.chart-detail').textContent===document.querySelector('.chart-point').getAttribute('aria-label')`), true);
  await evaluate(`document.querySelector('#chart-model').selectedIndex=1;document.querySelector('#chart-model').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.chart-point')].every(dot=>dot.dataset.config===state.chartModel)`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.chart-legend button').length`), 1);
  await evaluate(`document.querySelector('.chart-legend button').click()`);
  assert.equal(await evaluate(`state.chartModel`), '');
  await evaluate(`document.querySelector('#chart-model').value='';document.querySelector('#chart-model').dispatchEvent(new Event('change'))`);

  // Compare rendered sorting against independently computed values in both directions.
  for (const direction of ['asc', 'desc']) {
    await evaluate(`document.querySelectorAll('.group')[0].querySelectorAll('thead th:last-child > .arrows button')[${direction === 'asc' ? 0 : 1}].click()`);
    assert.equal(await evaluate(`(()=>{
      const expected=state.groups[0].models.map(m=>totals(m,state.groups[0].images).deviation).filter(v=>v!==null);
      const rows=[...document.querySelectorAll('.group tbody tr[data-config]')];
      const scores=rows.map(r=>totals(state.groups[0].models.find(m=>m.key===r.dataset.config),state.groups[0].images).deviation).filter(v=>v!==null);
      return scores.every((v,i)=>i===0||${direction === 'asc' ? 'v>=scores[i-1]' : 'v<=scores[i-1]'});
    })()`), true);
    await evaluate(`document.querySelector('.group tbody tr .arrows').querySelectorAll('button')[${direction === 'asc' ? 0 : 1}].click()`);
    assert.equal(await evaluate(`(()=>{
      const g=state.groups[0], sort=state.sorts.get(g.id).columns, m=g.models.find(m=>m.key===sort.model);
      const values=[...document.querySelectorAll('.group thead th[data-image]')].map(th=>sortValue(state.metric,m,g.images.find(i=>i.key===th.dataset.image))).filter(v=>v!==null);
      return values.every((v,i)=>i===0||${direction === 'asc' ? 'v>=values[i-1]' : 'v<=values[i-1]'});
    })()`), true);
    await evaluate(`document.querySelectorAll('.group thead th[data-image]')[0].querySelectorAll('button')[${direction === 'asc' ? 0 : 1}].click()`);
    assert.equal(await evaluate(`(()=>{
      const g=state.groups[0], sort=state.sorts.get(g.id).rows, image=g.images.find(i=>i.key===sort.key);
      const values=[...document.querySelectorAll('.group tbody tr[data-config]')].map(tr=>sortValue(state.metric,g.models.find(m=>m.key===tr.dataset.config),image)).filter(v=>v!==null);
      return values.every((v,i)=>i===0||${direction === 'asc' ? 'v>=values[i-1]' : 'v<=values[i-1]'});
    })()`), true);
  }
  await evaluate(`document.querySelector('#metrics label:last-child input').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.result-cell .metric-label')].some(n=>n.textContent==='Conf.')`), false);
  await evaluate(`document.querySelector('#metrics label:last-child input').click();document.querySelectorAll('#metrics label')[5].querySelector('input').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.result-cell .metric-label')].some(n=>n.textContent==='Δ count')`), true);
  await evaluate(`document.querySelectorAll('#metrics label')[5].querySelector('input').click();document.querySelector('#search').value='no-such-model';document.querySelector('#search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelectorAll('table').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.chart-card').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#model-observations').textContent`), 'Select models to see observations.');
  await evaluate(`document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input'))`);

  // Provider grouping changes provider order while keeping sorting within each group.
  for (const direction of ['asc', 'desc']) {
    await evaluate(`document.querySelector('#provider-grouping').value='${direction}';document.querySelector('#provider-grouping').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate(`(()=>{
      const actual=[...document.querySelectorAll('.group .provider-heading')].map(r=>r.dataset.provider);
      const expected=[...new Set(state.groups[0].models.map(m=>m.vendor))].sort((a,b)=>compare(a,b)*${direction === 'asc' ? 1 : -1});
      return JSON.stringify(actual)===JSON.stringify(expected);
    })()`), true);
    assert.equal(await evaluate(`(()=>{
      const g=state.groups[0], sort=state.sorts.get(g.id).rows, img=g.images.find(i=>i.key===sort.key);
      const rows=[...document.querySelectorAll('.group tbody tr[data-config]')].map(r=>g.models.find(m=>m.key===r.dataset.config));
      return rows.every((m,i)=>!i||m.vendor!==rows[i-1].vendor||order(sortValue(state.metric,rows[i-1],img),sortValue(state.metric,m,img),sort.direction)<=0);
    })()`), true);
  }
  assert.equal(await evaluate(`document.querySelectorAll('.summary-table tr[data-config]').length`), await evaluate(`new Set(state.groups.flatMap(g=>g.models.map(m=>m.key))).size`));
  await evaluate(`document.querySelectorAll('.summary-table thead th')[2].querySelectorAll('button')[0].click()`);
  assert.equal(await evaluate(`(()=>{
    const rows=[...document.querySelectorAll('.summary-table tr[data-config]')].map(tr=>({provider:JSON.parse(tr.dataset.config)[0].split('/')[0],cost:Number(tr.cells[2].textContent.replace('$',''))}));
    return rows.every((r,i)=>!i||r.provider!==rows[i-1].provider||r.cost>=rows[i-1].cost);
  })()`), true);
  // Skipped calls do not incur unknown charges; scale and disabled reasoning are explicit.
  assert.deepEqual(await evaluate(`(()=>{
    const g=organize([{path:'eval2/edge.json',data:{model:'edge/model',reasoning:{enabled:false,effort:'low'},allow_fallbacks:true,results:[
      {group:'edge',image:'skipped.jpg',status:'skipped',cost_usd:null},
      {group:'edge',image:'one.jpg',status:'success',model_count:0,'actual-count':0,confidence:75,confidence_scale:'0-100',cost_usd:0,latency_seconds:0,allow_fallbacks:false}
    ]}}])[0];
    const skipped=g.models.find(m=>m.predictions.has('edge/skipped.jpg')), success=g.models.find(m=>m.predictions.has('edge/one.jpg'));
    const result={unknown:totals(skipped,g.images).unknown,total:totals(skipped,g.images).knownCost,effort:success.effort,confidence:success.predictions.get('edge/one.jpg').confidence,fallbacks:success.settings.fallbacks};state.warnings=[];return result;
  })()`), {unknown:0,total:0,effort:'off',confidence:.75,fallbacks:false});
  assert.equal(await evaluate(`[...document.querySelectorAll('.table-wrap')].every(w=>w.scrollHeight<=w.clientHeight+1)`), true);
  await evaluate(`document.querySelector('#provider-grouping').value='';document.querySelector('#provider-grouping').dispatchEvent(new Event('change'))`);

  // Fixture covers new models/images/groups, failed charges, zero truth, missing costs,
  // latest-record replacement, and conflicting metadata without modifying real files.
  assert.equal(await evaluate(`(()=>{
    const fixture=[{path:'eval2/meta.json',data:[{group:'new',image:'one.jpg','actual-count':10},{group:'new',image:'zero.jpg','actual-count':0}]},
      {path:'eval2/new.json',data:{model:'new/model',model_temp:0,reasoning:{effort:'low'},results:[
        {group:'new',image:'one.jpg',model_count:15,confidence:0.8,status:'success',cost_usd:0.01,finished_at_utc:'2026-01-01'},
        {group:'new',image:'one.jpg',model_count:12,confidence:0.9,status:'success',cost_usd:0.02,latency_seconds:2,finished_at_utc:'2026-01-02'},
        {group:'new',image:'zero.jpg',model_count:1,status:'success',confidence:0.3,cost_usd:null,latency_seconds:4},
        {group:'new',image:'failed.jpg',status:'failed',cost_usd:0.03},
      ]}}];
    const g=organize(fixture)[0],m=g.models[0],one=g.images.find(i=>i.image==='one.jpg'),zero=g.images.find(i=>i.image==='zero.jpg');
    const t=totals(m,g.images);
    const samples=confidenceSamples({model:m,imageRecords:g.images});
    const conflicts=organize([...fixture,{path:'eval2/conflict.json',data:[{group:'new',image:'one.jpg','actual-count':11}]}])[0];
    const conflictedSamples=confidenceSamples({model:conflicts.models[0],imageRecords:conflicts.images});
    state.warnings=[];
    return g.images.length===3 && m.predictions.size===3 && value('percent',m,one)===20 && value('percent',m,zero)===null && Math.abs(t.knownCost-0.05)<1e-9 && t.unknown===1 && t.count===1 && t.meanCost===0.025 && t.meanTime===3 && t.totalTime===6 && t.unknownTime===1 && order(null,1,'desc')>0 && samples.length===2 && samples.every(s=>s.correct===0) && conflictedSamples.length===1 && conflictedSamples[0].image.actual===0;
  })()`), true);
  // Simulate a host without directory listings while allowing JSON downloads.
  const fallback = await evaluate(`(async()=>{
    const original=window.fetch;
    window.fetch=(resource,...args)=>String(resource).endsWith('/eval2/') ? Promise.resolve(new Response('',{status:404})) : original(resource,...args);
    try {await load();return {groups:state.groups.length,warnings:state.warnings};}
    finally {window.fetch=original;}
  })()`);
  assert.ok(fallback.groups > 0, JSON.stringify(fallback));
  assert.deepEqual(fallback.warnings, []);
  const layout = await command('Page.getLayoutMetrics');
  const desktop = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: {x:0,y:0,width:1440,height:layout.cssContentSize.height,scale:1} });
  await writeFile('/tmp/count-table-desktop.png', Buffer.from(desktop.data, 'base64'));
  const chartBounds = await evaluate(`(()=>{const r=document.querySelector('#confidence-charts').getBoundingClientRect();return {x:r.x,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`);
  const chartShot = await command('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,clip:chartBounds});
  await writeFile('/tmp/count-charts-desktop.png',Buffer.from(chartShot.data,'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('render()');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  const mobile = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/count-table-mobile.png', Buffer.from(mobile.data, 'base64'));
  await evaluate(`document.querySelector('#confidence-charts').scrollIntoView()`);
  const mobileCharts = await command('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/count-charts-mobile.png',Buffer.from(mobileCharts.data,'base64'));
  await evaluate(`document.querySelector('.group').scrollIntoView()`);
  const mobileMatrix = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/count-table-mobile-matrix.png', Buffer.from(mobileMatrix.data, 'base64'));
  assert.deepEqual(errors, []);
  console.log('Passed: JSON loading, sorting, filters, provider summary, dynamic fixtures, manifest fallback, calibration bins, tied risk cutoffs, chart selection/details, setup/observations, and desktop/mobile layouts.');
} finally { socket.close(); }
