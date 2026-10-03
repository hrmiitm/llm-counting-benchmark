// Independently recompute the displayed results from raw JSON, without app helpers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const average = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const finite = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
const validCount = x => Number.isInteger(x) && x >= 0;
const imageKey = r => `${String(r.group).replace(/^group/, '')}/${r.image}`;
const numericText = text => text === '—' ? null : Number(text.replace(/[$,%s*\s]/g, ''));
function checkNumber(text, expected, tolerance, label) {
  if (expected === null) assert.equal(text, '—', label);
  else assert.ok(Math.abs(numericText(text) - expected) <= tolerance + 1e-10, `${label}: ${text} vs ${expected}`);
}
function stats(cells) {
  const records = cells.filter(c => c.raw);
  const attempted = records.filter(c => !['skipped', 'missing'].includes(c.raw.status));
  const costs = records.map(c => ['skipped', 'missing'].includes(c.raw.status) ? 0 : c.cost);
  const times = attempted.map(c => c.time);
  const deviations = cells.map(c => c.percent).filter(v => v !== null);
  return { deviation: average(deviations), count: deviations.length,
    meanCost: average(attempted.map(c => c.cost).filter(v => v !== null)),
    meanTime: average(times.filter(v => v !== null)),
    knownCost: costs.some(v => v !== null) ? costs.reduce((a, b) => a + (b ?? 0), 0) : null,
    totalTime: times.some(v => v !== null) ? times.reduce((a, b) => a + (b ?? 0), 0) : null,
    unknown: costs.filter(v => v === null).length, unknownTime: times.filter(v => v === null).length };
}
export async function auditResults(evaluate) {
  const manifest = JSON.parse(await readFile(new URL('../eval2/manifest.json', import.meta.url), 'utf8'));
  const sources = new Map(await Promise.all(manifest.files.map(async path => [path,
    JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))])));
  const truth = new Map();
  for (const data of sources.values()) for (const r of Array.isArray(data) ? data : data.results ?? []) {
    if (!validCount(r['actual-count'])) continue;
    const key = imageKey(r), old = truth.get(key);
    truth.set(key, old === undefined || old === r['actual-count'] ? r['actual-count'] : null);
  }
  const view = await evaluate(`(()=>({
    groups:[...document.querySelectorAll('.group')].map(section=>{
      const g=state.groups.find(g=>g.id===section.dataset.group);
      return {headers:[...section.querySelectorAll('thead th[data-image]')].map(th=>({key:th.dataset.image,actual:th.querySelector('.actual strong')?.textContent})),
        rows:[...section.querySelectorAll('tr[data-config]')].map(tr=>{
          const m=g.models.find(m=>m.key===tr.dataset.config);
          return {config:m.key,name:m.name,cells:[...tr.querySelectorAll('.result-cell')].map(td=>({
            key:td.dataset.image,source:m.predictions.get(td.dataset.image)?.source,
            metrics:Object.fromEntries([...td.querySelectorAll('[data-metric]')].map(line=>[line.dataset.metric,line.querySelector('.metric-value').textContent]))})),
            overall:[...tr.querySelectorAll('.overall .metric-value')].map(el=>el.textContent),coverage:tr.querySelector('.coverage').textContent};
        })};
    }),
    summary:[...document.querySelectorAll('.summary-table tr[data-config]')].map(tr=>({config:tr.dataset.config,values:[...tr.cells].slice(1).map(c=>c.textContent)})),
    calibration:[...document.querySelectorAll('[data-chart="calibration"] circle')].map(dot=>({config:dot.dataset.config,x:(+dot.getAttribute('cx')-55)/440,y:(247-+dot.getAttribute('cy'))/204,n:+dot.dataset.samples})),
    risk:[...document.querySelectorAll('[data-chart="risk"] circle')].map(dot=>({config:dot.dataset.config,x:(+dot.getAttribute('cx')-55)/440,y:(247-+dot.getAttribute('cy'))/204,n:+dot.dataset.samples,threshold:+dot.dataset.threshold})),
    observations:[...document.querySelectorAll('#model-observations li')].map(li=>li.textContent)
  }))()`);
  const configurations = new Map(); let checked = 0;
  for (const group of view.groups) {
    for (const h of group.headers) checkNumber(h.actual, truth.get(h.key) ?? null, 0, `ground truth ${h.key}`);
    for (const row of group.rows) {
      const cells = row.cells.map(cell => {
        const data = sources.get(cell.source);
        const raw = (Array.isArray(data) ? data : data?.results ?? []).filter(r => imageKey(r) === cell.key)
          .sort((a,b) => (Date.parse(b.finished_at_utc ?? b.started_at_utc ?? b.run_id ?? data.run_id) || 0) - (Date.parse(a.finished_at_utc ?? a.started_at_utc ?? a.run_id ?? data.run_id) || 0))[0];
        const actual = truth.get(cell.key) ?? null;
        const successful = raw && (raw.status ?? (validCount(raw.model_count) ? 'success' : 'missing')) === 'success';
        const predicted = successful && validCount(raw.model_count) ? raw.model_count : null;
        let confidence = successful ? finite(raw?.confidence) : null;
        if ((raw?.confidence_scale ?? data?.confidence_scale) === '0-100' && confidence !== null) confidence /= 100;
        if (confidence !== null && (confidence < 0 || confidence > 1 || predicted === null)) confidence = null;
        const cost = finite(raw?.cost_usd ?? raw?.usage?.cost), time = finite(raw?.latency_seconds);
        const deviation = predicted !== null && actual !== null ? predicted - actual : null;
        const percent = deviation !== null && actual > 0 ? Math.abs(deviation) / actual * 100 : null;
        const expected = { ...cell, raw, actual, predicted, confidence, cost, time, deviation, percent };
        for (const [metric, digits] of [['percent',1],['time',1],['confidence',3],['deviation',0]]) {
          checkNumber(cell.metrics[metric], expected[metric], .5 * 10 ** -digits, `${row.name} ${cell.key} ${metric}`);
        }
        checkNumber(cell.metrics.cost, cost, cost > 0 && cost < .01 ? .0000005 : .00005, `${row.name} ${cell.key} cost`);
        if (successful) {
          const [pred, act] = cell.metrics.ratio.split(' / ');
          checkNumber(pred, predicted, 0, 'predicted count'); checkNumber(act, actual, 0, 'actual count');
        } else assert.equal(cell.metrics.ratio, '—');
        checked++; return expected;
      });
      const totals = stats(cells);
      checkNumber(row.overall[0], totals.deviation, .05, `${row.name} overall deviation`);
      checkNumber(row.overall[1].replace('*',''), totals.knownCost, totals.knownCost > 0 && totals.knownCost < .01 ? .0000005 : .00005, `${row.name} overall cost`);
      assert.equal(row.overall[1].includes('*'), totals.unknown > 0);
      assert.ok(row.coverage.startsWith(`${totals.count}/${cells.length} scored`));
      if (!configurations.has(row.config)) configurations.set(row.config, {name:row.name,cells:[]});
      configurations.get(row.config).cells.push(...cells);
    }
  }
  for (const [config, model] of configurations) {
    const totals = stats(model.cells); model.totals = totals;
    const summary = view.summary.find(row => row.config === config); assert.ok(summary);
    for (const [i,key,tolerance] of [[0,'deviation',.05],[1,'meanCost',.00005],[2,'meanTime',.05],[3,'knownCost',.00005],[4,'totalTime',.05]]) {
      const precision = key.toLowerCase().includes('cost') && totals[key] > 0 && totals[key] < .01 ? .0000005 : tolerance;
      checkNumber(summary.values[i].replace('*',''), totals[key], precision, `${model.name} summary ${key}`);
    }
    assert.equal(summary.values[3].includes('*'), totals.unknown > 0);
    assert.equal(summary.values[4].includes('*'), totals.unknownTime > 0);
    const valid = model.cells.filter(c => c.predicted !== null && c.actual !== null && c.confidence !== null);
    const bins = Array.from({length:5},(_,i)=>valid.filter(c=>Math.min(4,Math.floor(c.confidence*5))===i)).filter(b=>b.length);
    const dots = view.calibration.filter(dot => dot.config === config);
    assert.equal(dots.length, bins.length);
    bins.forEach((bin,i)=>{
      assert.equal(dots[i].n, bin.length);
      assert.ok(Math.abs(dots[i].x-average(bin.map(c=>c.confidence))) < 1e-10);
      assert.ok(Math.abs(dots[i].y-bin.filter(c=>c.predicted===c.actual).length/bin.length) < 1e-10);
    });
    const risks = view.risk.filter(dot => dot.config === config);
    const thresholds = [...new Set(valid.map(c=>c.confidence))].sort((a,b)=>b-a);
    assert.equal(risks.length, thresholds.length);
    thresholds.forEach((threshold,i)=>{
      const accepted=valid.filter(c=>c.confidence>=threshold), errors=accepted.filter(c=>c.predicted!==c.actual).length;
      assert.equal(risks[i].threshold, threshold); assert.equal(risks[i].n, accepted.length);
      assert.ok(Math.abs(risks[i].x-accepted.length/model.cells.filter(c=>c.actual!==null).length) < 1e-10);
      assert.ok(Math.abs(risks[i].y-errors/accepted.length) < 1e-10);
    });
    model.confidence = average(valid.map(c=>c.confidence));
    model.accuracy = valid.length ? valid.filter(c=>c.predicted===c.actual).length/valid.length : null;
    model.gap = valid.length ? Math.abs(model.confidence-model.accuracy) : null;
  }
  const models = [...configurations.values()];
  for (const [index,key,desc] of [[0,'deviation',false],[1,'meanCost',false],[2,'gap',true]]) {
    const get=m=>key==='gap'?m.gap:m.totals[key];
    const valid=models.filter(m=>get(m)!==null).sort((a,b)=>(get(a)-get(b))*(desc?-1:1));
    if (valid.length) {
      assert.ok(view.observations[index].includes(valid[0].name.split('/').at(-1)), `highlight ${key}`);
      if (key === 'deviation') checkNumber(view.observations[index].match(/[\d.]+%/)[0],get(valid[0]),.05,'deviation highlight');
      if (key === 'meanCost') checkNumber(view.observations[index].match(/\$\d+(?:\.\d+)?/)[0],get(valid[0]),get(valid[0])<.01?.0000005:.00005,'cost highlight');
      if (key === 'gap') {
        const percentages=view.observations[index].match(/[\d.]+%/g);
        checkNumber(percentages[0],valid[0].confidence*100,.05,'confidence highlight');
        checkNumber(percentages[1],valid[0].accuracy*100,.05,'exact accuracy highlight');
      }
    }
  }
  console.log(`Raw JSON audit passed: ${checked} image cells, ${configurations.size} summaries, ${view.calibration.length} calibration dots, ${view.risk.length} risk dots, and highlights.`);
}
