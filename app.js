'use strict';

const $ = selector => document.querySelector(selector);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const mean = values => { const valid = values.filter(v => v !== null); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; };
const compare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const fmt = (n, digits = 1) => n === null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const money = value => value === null ? '—' : `$${value.toFixed(value > 0 && value < .01 ? 6 : 4)}`;
const metrics = [
  { key: 'actual', label: 'Actual count', short: 'Actual', format: v => fmt(v, 0), show: true },
  { key: 'percent', label: '% deviation', short: '% dev.', format: v => v === null ? '—' : `${fmt(v)}%`, show: true },
  { key: 'ratio', label: 'Predicted / actual', short: 'Pred./act.', format: (v, p) => `${fmt(count(p?.model_count), 0)} / ${fmt(v, 0)}`, show: true },
  { key: 'cost', label: 'Cost', short: 'Cost', format: money, show: true },
  { key: 'time', label: 'Time', short: 'Time', format: v => v === null ? '—' : `${fmt(v)}s`, show: true },
  { key: 'deviation', label: 'Deviation', short: 'Δ count', format: v => v === null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 0)}`, show: false },
  { key: 'confidence', label: 'Confidence', short: 'Conf.', format: v => fmt(v, 3), show: true },
];
const state = { groups: [], warnings: [], files: 0, metric: 'percent', query: '', group: '', providerGrouping: '', chartModel: '', summarySort: { key: 'deviation', direction: 'asc' }, sorts: new Map() };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function safePath(path, root = '') {
  return typeof path === 'string' && !path.startsWith('/') && !/[\\?#]/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.' || !part)
    && (!root || path.startsWith(root));
}
function jsonURL(path) { return new URL(path.split('/').map(encodeURIComponent).join('/'), document.baseURI); }
async function fetchJSON(path) {
  const response = await fetch(jsonURL(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Local directory listings discover additions on refresh. Static hosting uses a generated index.
async function discover() {
  const base = new URL('./', document.baseURI);
  async function crawl(folder, depth = 0) {
    if (depth > 12) throw new Error('Directory nesting exceeds 12 levels.');
    const response = await fetch(new URL(folder, base), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Directory listing unavailable (${response.status}).`);
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (!document.title.startsWith('Directory listing for')) throw new Error('Server does not expose directory listings.');
    const files = [], folders = [];
    for (const link of document.querySelectorAll('a[href]')) {
      const url = new URL(link.getAttribute('href'), new URL(folder, base));
      if (url.origin !== base.origin || !url.pathname.startsWith(new URL(folder, base).pathname)) continue;
      const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
      if (path === folder) continue;
      if (path.endsWith('/') && safePath(path.slice(0, -1), 'eval2/')) folders.push(path);
      else if (safePath(path, 'eval2/') && path.endsWith('.json') && path !== 'eval2/manifest.json') files.push(path);
    }
    const children = await Promise.allSettled([...new Set(folders)].map(folder => crawl(folder, depth + 1)));
    for (const result of children) {
      if (result.status === 'fulfilled') files.push(...result.value);
      else state.warnings.push(result.reason.message);
    }
    return files;
  }
  try { return [...new Set(await crawl('eval2/'))].sort(compare); }
  catch {
    const manifest = await fetchJSON('eval2/manifest.json');
    if (!Array.isArray(manifest.files)) throw new Error('Invalid eval2/manifest.json; run python3 build_manifest.py.');
    const valid = manifest.files.filter(path => safePath(path, 'eval2/') && path.endsWith('.json') && path !== 'eval2/manifest.json');
    if (valid.length !== manifest.files.length) state.warnings.push('Invalid paths in the manifest were ignored.');
    return [...new Set(valid)].sort(compare);
  }
}

function identity(row) {
  const group = String(row.group ?? '').replace(/^group/, '');
  if (!/^[\w-]+$/.test(group) || !safePath(row.image)) return null;
  return { group, key: `${group}/${row.image}` };
}
function organize(sources) {
  const images = new Map(), configurations = new Map();
  for (const { path, data } of sources) {
    const rows = Array.isArray(data) ? data : data?.results;
    if (!Array.isArray(rows)) { state.warnings.push(`${path}: no result or metadata array found.`); continue; }
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = identity(row);
      if (!id) { state.warnings.push(`${path}: invalid group/image identifier.`); continue; }
      if (!images.has(id.key)) images.set(id.key, { ...id, image: row.image, id: row.id ?? row.image, label: row.label ?? row.image, actual: null, conflict: false });
      const image = images.get(id.key);
      if (row.id !== undefined) image.id = row.id;
      if (row.label) image.label = row.label;
      const actual = count(row['actual-count']);
      if (actual !== null) {
        if (image.actual !== null && image.actual !== actual) {
          image.conflict = true;
          state.warnings.push(`${id.key}: conflicting ground truths; deviation is unavailable.`);
        }
        image.actual = actual;
      }
      const model = row.model ?? data.model;
      if (typeof model !== 'string' || !model.trim()) continue; // Ground truth only.
      const temp = 'model_temp' in row ? row.model_temp : 'model_temp' in data ? data.model_temp : 'unspecified';
      const reasoning = row.reasoning ?? data.reasoning;
      const effort = reasoning?.enabled === false || data.reasoning_enabled === false ? 'off'
        : row.reasoning_effort ?? reasoning?.effort ?? (reasoning?.enabled === true || data.reasoning_enabled === true ? 'on' : 'unspecified');
      const provider = row.provider_endpoint ?? data.provider_endpoint ?? row.response_provider ?? 'unspecified';
      const maxTokens = row.max_tokens ?? data.max_tokens ?? null;
      const prompt = row.prompt_version ?? data.prompt_version ?? data.prompt ?? data.prompt_template ?? '';
      const settings = { tools: row.tools ?? data.tools, toolChoice: row.tool_choice ?? data.tool_choice, fallbacks: row.allow_fallbacks ?? data.allow_fallbacks };
      const configKey = JSON.stringify([model, temp, effort, provider, maxTokens, prompt, reasoning?.exclude ?? null, settings]);
      if (!configurations.has(configKey)) configurations.set(configKey, {
        key: configKey, name: model, vendor: model.includes('/') ? model.split('/')[0] : 'Other',
        temp, effort, provider, maxTokens, prompt, settings, predictions: new Map(),
      });
      const config = configurations.get(configKey);
      const stamp = row.finished_at_utc ?? row.started_at_utc ?? row.run_id ?? data.run_id ?? '';
      const parsedTime = Date.parse(stamp);
      const timestamp = Number.isFinite(parsedTime) ? parsedTime : 0;
      const previous = config.predictions.get(id.key);
      // Sorted paths provide a deterministic tiebreaker; never add duplicate predictions/costs.
      if (!previous || timestamp >= previous.timestamp) {
        let confidence = number(row.confidence);
        if ((row.confidence_scale ?? data.confidence_scale) === '0-100') confidence = confidence === null ? null : confidence / 100;
        if (confidence !== null && (confidence < 0 || confidence > 1)) {
          state.warnings.push(`${path}: confidence outside 0–1 for ${row.image}; displayed as missing.`);
          confidence = null;
        }
        const prediction = { ...row, confidence, timestamp, source: path };
        prediction.status ??= count(row.model_count) === null ? 'missing' : 'success';
        config.predictions.set(id.key, prediction);
      }
    }
  }
  const groupIds = new Set();
  for (const config of configurations.values()) for (const key of config.predictions.keys()) groupIds.add(images.get(key).group);
  return [...groupIds].sort(compare).map(id => ({
    id, images: [...images.values()].filter(image => image.group === id).sort((a, b) => compare(a.id, b.id)),
    models: [...configurations.values()].filter(model => [...model.predictions.keys()].some(key => images.get(key).group === id)),
  }));
}
function prediction(model, image) { return model.predictions.get(image.key); }
function configurationName(model, short = false) {
  const matches = [...new Map(state.groups.flatMap(group => group.models).map(m => [m.key, m])).values()]
    .filter(m => m.name === model.name).sort((a, b) => compare(a.key, b.key));
  const name = short ? model.name.slice(model.name.indexOf('/') + 1) : model.name;
  return `${name}${matches.length > 1 ? ` [${matches.findIndex(m => m.key === model.key) + 1}]` : ''}`;
}
function value(metric, model, image) {
  const p = prediction(model, image), actual = image.conflict ? null : image.actual;
  const predicted = p?.status === 'success' ? count(p.model_count) : null;
  if (metric === 'actual' || metric === 'ratio') return actual;
  if (metric === 'cost') return number(p?.cost_usd ?? p?.usage?.cost);
  if (metric === 'time') return number(p?.latency_seconds);
  if (metric === 'confidence') return predicted === null ? null : number(p.confidence);
  if (predicted === null || actual === null) return null;
  if (metric === 'deviation') return predicted - actual;
  return actual > 0 ? Math.abs(predicted - actual) / actual * 100 : null;
}
function sortValue(metric, model, image) {
  if (metric === 'ratio') {
    const p = prediction(model, image), actual = value('actual', model, image);
    return p?.status === 'success' && actual > 0 && count(p.model_count) !== null ? p.model_count / actual : null;
  }
  return value(metric, model, image);
}
function totals(model, images) {
  const rows = images.map(image => prediction(model, image)).filter(Boolean);
  const costs = rows.map(row => ['skipped', 'missing'].includes(row.status) ? 0 : number(row.cost_usd ?? row.usage?.cost));
  const calls = rows.filter(row => row.status !== 'skipped' && row.status !== 'missing');
  const times = calls.map(row => number(row.latency_seconds));
  const deviations = images.map(image => value('percent', model, image));
  return {
    deviation: mean(deviations), count: deviations.filter(v => v !== null).length,
    knownCost: costs.some(v => v !== null) ? costs.reduce((sum, v) => sum + (v ?? 0), 0) : null,
    unknown: costs.filter(v => v === null).length,
    meanCost: mean(calls.map(row => number(row.cost_usd ?? row.usage?.cost))),
    meanTime: mean(times),
    totalTime: times.some(v => v !== null) ? times.reduce((sum, v) => sum + (v ?? 0), 0) : null,
    unknownTime: times.filter(v => v === null).length,
    failed: rows.filter(row => row.status === 'failed' || row.status === 'skipped').length,
  };
}
function order(a, b, direction) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return (typeof a === 'number' ? a - b : compare(a, b)) * (direction === 'asc' ? 1 : -1);
}
function shade(element, deviation) {
  if (deviation === null) return;
  const t = Math.max(0, Math.min(deviation / 100, 1));
  const stops = document.documentElement.dataset.theme === 'dark'
    ? [[42, 79, 59], [90, 76, 35], [99, 49, 46]]
    : [[182, 224, 196], [247, 227, 160], [237, 175, 167]];
  const local = t < .5 ? t * 2 : (t - .5) * 2, a = t < .5 ? stops[0] : stops[1], b = t < .5 ? stops[1] : stops[2];
  element.style.backgroundColor = `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * local)).join(',')})`;
}
function metricLine(label, text, primary = false) {
  const line = node('div', undefined, `metric${primary ? ' primary' : ''}`);
  line.append(node('span', label, 'metric-label'), node('span', text, 'metric-value'));
  return line;
}
function arrows(label, selected, callback) {
  const container = node('div', undefined, 'arrows');
  for (const [direction, symbol] of [['asc', '↑'], ['desc', '↓']]) {
    const button = node('button', symbol); button.type = 'button';
    button.title = `${label} · ${direction === 'asc' ? 'ascending' : 'descending'}`;
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(selected === direction));
    button.addEventListener('click', () => {
      const scope = button.closest('[data-sort-scope]')?.dataset.sortScope;
      callback(direction);
      const section = [...document.querySelectorAll('[data-sort-scope]')].find(section => section.dataset.sortScope === scope);
      [...(section?.querySelectorAll('.arrows button') ?? [])].find(next => next.getAttribute('aria-label') === button.title)?.focus({ preventScroll: true });
    });
    container.append(button);
  }
  return container;
}
function imageURL(image) {
  return jsonURL(`data/group${image.group}/${image.image}`);
}
function renderGroup(group) {
  const section = node('section', undefined, 'group');
  section.dataset.group = group.id;
  section.dataset.sortScope = `group:${group.id}`;
  const models = group.models.filter(model => `${model.name} ${model.provider}`.toLowerCase().includes(state.query));
  if (!models.length) return null;
  const sorts = state.sorts.get(group.id) ?? { rows: { key: 'overall', direction: 'asc' }, columns: null };
  state.sorts.set(group.id, sorts);
  const stats = new Map(models.map(model => [model.key, totals(model, group.images)]));
  const imageList = [...group.images], modelList = [...models];
  if (sorts.columns) {
    const selected = group.models.find(model => model.key === sorts.columns.model);
    if (selected) imageList.sort((a, b) => order(sortValue(state.metric, selected, a), sortValue(state.metric, selected, b), sorts.columns.direction) || compare(a.id, b.id));
  }
  function rowScore(model) {
    const key = sorts.rows.key;
    if (key === 'name') return model.name;
    if (key === 'cost') return stats.get(model.key).knownCost;
    if (key === 'overall') return stats.get(model.key).deviation;
    const image = group.images.find(image => image.key === key);
    return image ? sortValue(state.metric, model, image) : null;
  }
  modelList.sort((a, b) => (state.providerGrouping ? order(a.vendor, b.vendor, state.providerGrouping) : 0) || order(rowScore(a), rowScore(b), sorts.rows.direction) || compare(a.name, b.name));
  const heading = node('div', undefined, 'group-heading');
  heading.append(node('h2', `Group ${group.id}`), node('p', `${models.length} configurations · ${group.images.length} images`));
  const wrap = node('div', undefined, 'table-wrap'); wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `Group ${group.id} results; scroll to explore`);
  const compact = matchMedia('(max-width:650px)').matches;
  const table = node('table'); table.style.minWidth = `${(compact ? 168 : 240) + imageList.length * 155 + 174}px`;
  table.setAttribute('aria-label', `Group ${group.id} model counting comparison`);
  const thead = node('thead'), headers = node('tr');
  function sortRows(key, direction) { sorts.rows = { key, direction }; redraw(); saveCompareView(); }
  function sortColumns(model, direction) { sorts.columns = { model, direction }; redraw(); saveCompareView(); }
  function redraw() {
    const x = wrap.scrollLeft, y = wrap.scrollTop;
    const replacement = renderGroup(group); section.replaceWith(replacement);
    const next = replacement.querySelector('.table-wrap'); next.scrollLeft = x; next.scrollTop = y;
  }
  const modelHeader = node('th'); modelHeader.scope = 'col';
  modelHeader.append(node('span', 'Model / configuration'), arrows('Sort models by name', sorts.rows.key === 'name' ? sorts.rows.direction : null, direction => sortRows('name', direction)));
  headers.append(modelHeader);
  for (const image of imageList) {
    const th = node('th'); th.scope = 'col';
    th.dataset.image = image.key;
    if (sorts.rows.key === image.key) th.setAttribute('aria-sort', sorts.rows.direction === 'asc' ? 'ascending' : 'descending');
    const link = node('a', undefined, 'image-link'); link.href = imageURL(image); link.target = '_blank'; link.rel = 'noopener';
    const img = node('img'); img.src = imageURL(image); img.alt = image.label; img.loading = 'lazy';
    const text = node('div', undefined, 'image-label'); text.append(node('span', image.label), node('div', image.image, 'image-id'));
    link.append(img, text); th.append(link);
    if (metrics.find(m => m.key === 'actual').show) {
      const actual = node('div', 'Actual ', 'actual'); actual.append(node('strong', fmt(image.conflict ? null : image.actual, 0))); th.append(actual);
    }
    th.append(arrows(`Sort models by ${image.label}: ${state.metric}`, sorts.rows.key === image.key ? sorts.rows.direction : null, direction => sortRows(image.key, direction)));
    headers.append(th);
  }
  const overallHeader = node('th'); overallHeader.scope = 'col';
  overallHeader.append(node('div', 'Overall'), arrows('Sort models by mean deviation', sorts.rows.key === 'overall' ? sorts.rows.direction : null, direction => sortRows('overall', direction)));
  const costSort = node('div', undefined, 'actual'); costSort.append(node('span', 'Total cost '), arrows('Sort models by total known cost', sorts.rows.key === 'cost' ? sorts.rows.direction : null, direction => sortRows('cost', direction))); overallHeader.append(costSort);
  headers.append(overallHeader); thead.append(headers); table.append(thead);
  const tbody = node('tbody');
  let lastVendor = null;
  for (const model of modelList) {
    if (state.providerGrouping && model.vendor !== lastVendor) {
      const providerRow = node('tr', undefined, 'provider-heading');
      providerRow.dataset.provider = model.vendor;
      const providerCell = node('th', `${model.vendor} · ${modelList.filter(m => m.vendor === model.vendor).length} models`);
      providerCell.colSpan = imageList.length + 2; providerRow.append(providerCell); tbody.append(providerRow);
      lastVendor = model.vendor;
    }
    const tr = node('tr'), title = node('th', undefined, 'model-cell'); title.scope = 'row';
    tr.dataset.config = model.key;
    title.append(arrows(`Sort images for ${model.name}: ${state.metric}`, sorts.columns?.model === model.key ? sorts.columns.direction : null, direction => sortColumns(model.key, direction)));
    title.append(node('div', model.vendor, 'model-vendor'), node('div', configurationName(model, true), 'model-name'));
    const spec = node('div', undefined, 'model-spec');
    spec.append(node('div', `T ${model.temp === null ? 'omitted' : model.temp} · reasoning ${model.effort}`), node('div', `${model.provider}${model.maxTokens !== null ? ` · ${fmt(model.maxTokens, 0)} tokens` : ''}`));
    spec.title = model.prompt ? `Prompt: ${model.prompt}` : 'Prompt not recorded'; title.append(spec); tr.append(title);
    for (const image of imageList) {
      const td = node('td', undefined, 'result-cell'), p = prediction(model, image);
      td.dataset.image = image.key;
      shade(td, value('percent', model, image));
      td.title = p ? `Source: ${p.source}\n${p.error?.reason ?? ''}` : 'No prediction for this image';
      if (!p) td.append(node('div', 'No result', 'missing'));
      else {
        if (p.status !== 'success') td.append(node('div', p.status, 'status-note'));
        for (const metric of metrics.filter(m => m.show && m.key !== 'actual')) {
          const v = value(metric.key, model, image);
          const text = metric.key === 'ratio' && p.status !== 'success' ? '—' : metric.format(v, p);
          const line = metricLine(metric.short, text, metric.key === 'percent'); line.dataset.metric = metric.key; td.append(line);
        }
        if (!metrics.some(m => m.show && m.key !== 'actual')) td.append(node('div', '—', 'missing'));
      }
      tr.append(td);
    }
    const overall = node('td', undefined, 'overall'), score = stats.get(model.key);
    shade(overall, score.deviation);
    overall.append(metricLine('Mean dev.', score.deviation === null ? '—' : `${fmt(score.deviation)}%`, true), metricLine('Total cost', `${money(score.knownCost)}${score.unknown ? '*' : ''}`));
    overall.append(node('div', `${score.count}/${group.images.length} scored${score.failed ? ` · ${score.failed} failed/skipped` : ''}${score.unknown ? ` · ${score.unknown} cost unknown` : ''}`, 'coverage'));
    tr.append(overall); tbody.append(tr);
  }
  table.append(tbody); wrap.append(table); section.append(heading, wrap); return section;
}

function visibleRows() {
  const configurations = new Map();
  for (const group of state.groups.filter(group => !state.group || group.id === state.group)) {
    for (const model of group.models.filter(model => `${model.name} ${model.provider}`.toLowerCase().includes(state.query))) {
      if (!configurations.has(model.key)) configurations.set(model.key, { model, images: [] });
      configurations.get(model.key).images.push(...group.images);
    }
  }
  return [...configurations.values()].map(({ model, images }) => ({ model, ...totals(model, images), images: images.length, imageRecords: images }));
}
function renderSummary() {
  const rows = visibleRows();
  $('#model-summary').replaceChildren();
  if (!rows.length) return;
  const section = node('section', undefined, 'summary-section'); section.dataset.sortScope = 'summary';
  const heading = node('div', undefined, 'group-heading');
  heading.append(node('h2', 'Model summary'), node('p', 'By provider'));
  const wrap = node('div', undefined, 'table-wrap summary-wrap'); wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Model summary; scroll horizontally on small screens');
  const table = node('table', undefined, 'summary-table'); table.setAttribute('aria-label', 'Model summary grouped by provider');
  const columns = [
    ['name', 'Model', v => v], ['deviation', 'Mean deviation', v => v === null ? '—' : `${fmt(v)}%`],
    ['meanCost', 'Mean cost', money], ['meanTime', 'Mean time', v => v === null ? '—' : `${fmt(v)}s`],
    ['knownCost', 'Total cost', money], ['totalTime', 'Total time', v => v === null ? '—' : `${fmt(v)}s`],
  ];
  const thead = node('thead'), header = node('tr');
  for (const [key, label] of columns) {
    const th = node('th'); th.scope = 'col';
    if (state.summarySort.key === key) th.setAttribute('aria-sort', state.summarySort.direction === 'asc' ? 'ascending' : 'descending');
    th.append(node('span', label), arrows(`Sort summary models by ${label.toLowerCase()}`, state.summarySort.key === key ? state.summarySort.direction : null, direction => { state.summarySort = { key, direction }; renderSummary(); }));
    header.append(th);
  }
  thead.append(header); table.append(thead);
  rows.sort((a, b) => order(a.model.vendor, b.model.vendor, state.providerGrouping || 'asc') || order(state.summarySort.key === 'name' ? a.model.name : a[state.summarySort.key], state.summarySort.key === 'name' ? b.model.name : b[state.summarySort.key], state.summarySort.direction) || compare(a.model.name, b.model.name));
  let lastVendor = null, tbody;
  for (const row of rows) {
    if (row.model.vendor !== lastVendor) {
      tbody = node('tbody'); table.append(tbody);
      const groupRow = node('tr', undefined, 'provider-heading'); groupRow.dataset.provider = row.model.vendor;
      const groupCell = node('th', row.model.vendor); groupCell.colSpan = columns.length; groupCell.scope = 'rowgroup';
      groupRow.append(groupCell); tbody.append(groupRow); lastVendor = row.model.vendor;
    }
    const tr = node('tr'); tr.dataset.config = row.model.key;
    for (const [key, , format] of columns) {
      const cell = node(key === 'name' ? 'th' : 'td');
      if (key === 'name') {
        cell.scope = 'row'; cell.className = 'summary-model';
        cell.append(node('span', configurationName(row.model, true)), node('small', `T ${row.model.temp ?? 'omitted'} · ${row.model.effort} · ${row.model.provider} · ${row.model.maxTokens ?? 'unknown'} tokens`));
        cell.title = row.model.prompt ? `Prompt: ${row.model.prompt}` : 'Prompt not recorded';
      } else {
        cell.textContent = format(row[key]);
        if (key === 'deviation') { shade(cell, row.deviation); cell.title = `${row.count}/${row.images} images scored`; }
        if ((key === 'knownCost' && row.unknown) || (key === 'totalTime' && row.unknownTime)) {
          cell.append(document.createTextNode('*'));
          cell.title = `${key === 'knownCost' ? row.unknown : row.unknownTime} values unknown; total is partial`;
        }
      }
      tr.append(cell);
    }
    tbody.append(tr);
  }
  wrap.append(table); section.append(heading, wrap);
  if (rows.some(row => row.unknown || row.unknownTime)) section.append(node('p', '* Partial total: some values are unknown.', 'summary-note'));
  $('#model-summary').append(section);
  saveCompareView();
}
function render() {
  const rows = visibleRows();
  renderOverview(rows);
  renderCharts(rows);
  renderSummary();
  $('#results').replaceChildren();
  for (const group of state.groups.filter(group => !state.group || group.id === state.group)) {
    const section = renderGroup(group); if (section) $('#results').append(section);
  }
  if (!$('#results').children.length) $('#results').append(node('p', 'No matching results.', 'empty'));
  saveCompareView();
}
function renderWarnings() {
  const warnings = [...new Set(state.warnings)]; $('#warnings').hidden = !warnings.length;
  $('#warnings summary').textContent = `${warnings.length} data ${warnings.length === 1 ? 'notice' : 'notices'}`;
  $('#warnings ul').replaceChildren(...warnings.map(warning => node('li', warning)));
}
async function load() {
  $('#reload').disabled = true; state.warnings = []; $('#summary').textContent = 'Loading results…';
  $('#loaded-source-links').replaceChildren(node('li', 'Loading source files…'));
  try {
    const paths = await discover();
    const responses = await Promise.allSettled(paths.map(async path => ({ path, data: await fetchJSON(path) })));
    const sources = [];
    responses.forEach((result, i) => {
      if (result.status === 'fulfilled') sources.push(result.value);
      else state.warnings.push(`${paths[i]}: ${result.reason.message}`);
    });
    state.groups = organize(sources); state.files = sources.length;
    $('#loaded-source-links').replaceChildren(...sources.map(({ path }) => {
      const item = node('li'), link = node('a', path);
      link.href = jsonURL(path); item.append(link); return item;
    }));
    if (!sources.length) $('#loaded-source-links').append(node('li', 'No JSON source files loaded.'));
    restoreCompareView();
    const images = state.groups.reduce((sum, group) => sum + group.images.length, 0);
    const configurations = new Set(state.groups.flatMap(group => group.models.map(model => model.key))).size;
    $('#summary').textContent = `${configurations} configurations · ${images} images · ${sources.length} files`;
    $('#group-filter').replaceChildren(node('option', 'All groups'));
    $('#group-filter').firstChild.value = '';
    for (const group of state.groups) { const option = node('option', `Group ${group.id}`); option.value = group.id; $('#group-filter').append(option); }
    if (!state.groups.some(group => group.id === state.group)) state.group = '';
    $('#group-filter').value = state.group;
    $('#loaded-at').textContent = `refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (!paths.length) state.warnings.push('No JSON files discovered in eval2/.');
    if (state.groups.some(group => group.images.some(image => image.actual === null))) state.warnings.push('Some images have no ground truth. Add their group/image/actual-count records to an eval2 metadata JSON file.');
    render();
  } catch (error) {
    $('#loaded-source-links').replaceChildren(node('li', 'Source files unavailable; inspect the data manifest above.'));
    $('#summary').textContent = 'Could not load results';
    $('#model-summary').replaceChildren();
    $('#confidence-charts').replaceChildren();
    $('#setup-notes').replaceChildren(node('li', 'Benchmark configuration unavailable until results load.'));
    $('#model-observations').replaceChildren(node('li', 'No observations available.'));
    $('#results').replaceChildren(node('p', 'Run python3 build_manifest.py, then serve this folder with python3 -m http.server 8765. On static hosting, publish eval2/manifest.json with the result files.', 'empty load-error'));
    state.warnings.push(error.message);
  } finally { renderWarnings(); $('#reload').disabled = false; }
}
function saveCompareView() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.group) params.set('group', state.group);
  if (state.metric !== 'percent') params.set('metric', state.metric);
  if (state.providerGrouping) params.set('provider', state.providerGrouping);
  if (state.chartModel) params.set('chart', state.chartModel);
  if (metrics.some(m => m.show !== (m.key !== 'deviation'))) params.set('show', metrics.filter(m => m.show).map(m => m.key).join(','));
  if (state.summarySort.key !== 'deviation' || state.summarySort.direction !== 'asc') params.set('summary', JSON.stringify(state.summarySort));
  const sorts = [...state.sorts].filter(([, s]) => s.columns || s.rows.key !== 'overall' || s.rows.direction !== 'asc');
  if (sorts.length) params.set('sorts', JSON.stringify(sorts));
  const url = new URL(location.href); url.hash = params.size ? `explore?${params}` : '';
  history.replaceState(null, '', url);
}
function restoreCompareView() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  state.query = (params.get('q') ?? '').toLowerCase();
  state.group = state.groups.some(g => g.id === params.get('group')) ? params.get('group') : '';
  state.metric = metrics.some(m => m.key === params.get('metric')) ? params.get('metric') : 'percent';
  state.providerGrouping = ['asc', 'desc'].includes(params.get('provider')) ? params.get('provider') : '';
  state.chartModel = params.get('chart') ?? '';
  for (const metric of metrics) metric.show = params.has('show') ? params.get('show').split(',').includes(metric.key) : metric.key !== 'deviation';
  state.summarySort = { key: 'deviation', direction: 'asc' }; state.sorts.clear();
  try {
    const summary = JSON.parse(params.get('summary') ?? 'null');
    if (summary && ['name', 'deviation', 'meanCost', 'meanTime', 'knownCost', 'totalTime'].includes(summary.key) && ['asc', 'desc'].includes(summary.direction)) state.summarySort = summary;
    const raw = params.get('sorts') ?? '[]';
    const sorts = raw.length <= 20000 ? JSON.parse(raw) : [];
    if (Array.isArray(sorts)) for (const entry of sorts) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, sort] = entry, group = state.groups.find(g => g.id === id);
      if (!group || !sort?.rows || !['asc', 'desc'].includes(sort.rows.direction)
          || !['overall', 'name', 'cost', ...group.images.map(i => i.key)].includes(sort.rows.key)) continue;
      if (sort.columns && (!group.models.some(m => m.key === sort.columns.model) || !['asc', 'desc'].includes(sort.columns.direction))) continue;
      state.sorts.set(id, { rows: sort.rows, columns: sort.columns ?? null });
    }
  } catch { /* Invalid shared state falls back to the default view. */ }
  $('#search').value = state.query; $('#sort-metric').value = state.metric;
  $('#provider-grouping').value = state.providerGrouping; $('#group-filter').value = state.group;
  [...$('#metrics').querySelectorAll('input')].forEach((checkbox, i) => { checkbox.checked = metrics[i].show; });
}
window.addEventListener('hashchange', () => { if (state.groups.length) { restoreCompareView(); render(); } });
for (const metric of metrics) {
  const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = metric.show;
  checkbox.addEventListener('change', () => { metric.show = checkbox.checked; render(); });
  label.append(checkbox, document.createTextNode(metric.label)); $('#metrics').append(label);
  const option = node('option', metric.label); option.value = metric.key; $('#sort-metric').append(option);
}
$('#sort-metric').value = state.metric;
$('#sort-metric').addEventListener('change', event => { state.metric = event.target.value; render(); });
$('#group-filter').addEventListener('change', event => { state.group = event.target.value; render(); });
$('#provider-grouping').addEventListener('change', event => { state.providerGrouping = event.target.value; render(); });
$('#search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); render(); });
$('#reload').addEventListener('click', load);
window.addEventListener('themechange', () => { if (state.groups.length) render(); });
load();
