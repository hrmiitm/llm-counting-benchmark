/* The manifest and result files are the only sources of benchmark data. */
'use strict';
const compare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const validCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function organize(sources, warnings) {
  const groups = new Map();
  for (const { name, rows } of sources) {
    rows.forEach((row, index) => {
      if (!row || !/^(?:group)?\d+$/.test(String(row.group)) ||
          typeof row.model !== 'string' || !row.model.trim() ||
          typeof row.image !== 'string' || !row.image ||
          !validCount(row['actual-count'])) {
        warnings.push(`${name}, row ${index + 1}: invalid group, model, image, or actual count; skipped.`);
        return;
      }
      const id = String(row.group).replace(/^group/, '');
      if (!groups.has(id)) groups.set(id, { images: new Map(), models: new Map() });
      const group = groups.get(id);
      if (group.images.has(row.image) && group.images.get(row.image)['actual-count'] !== row['actual-count']) {
        warnings.push(`${name}, row ${index + 1}: conflicting actual count for ${row.image}; skipped.`);
        return;
      }
      group.images.set(row.image, row);
      // Separate temperatures; later manifest entries replace duplicate predictions.
      const key = JSON.stringify([row.model, row.model_temp ?? null]);
      if (!group.models.has(key)) group.models.set(key, {
        name: row.model, temperature: row.model_temp,
        provider: row.model.includes('/') ? row.model.split('/')[0] : 'Other', predictions: new Map(),
      });
      group.models.get(key).predictions.set(row.image, row);
    });
  }
  return groups;
}
// Fixed domain across both tables: 0% green, 50% yellow, 100%+ red.
// Blend slightly toward a light neutral to soften saturation and dark extremes.
const errorColor = value => d3.interpolateRgb(
  d3.interpolateRdYlGn(1 - Math.min(1, Math.max(0, value))), '#f2f4f7',
)(0.18);
function shade(node, value) {
  if (value === null) return;
  const color = d3.rgb(errorColor(value));
  node.style.backgroundColor = color.formatRgb();
  const linear = channel => { const c = channel / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  const luminance = .2126 * linear(color.r) + .7152 * linear(color.g) + .0722 * linear(color.b);
  node.style.color = luminance > .179 ? '#000' : '#fff';
}
function deviation(model, item) {
  const predicted = model.predictions.get(item.image)?.model_count;
  return validCount(predicted) && item['actual-count'] > 0 ? Math.abs(predicted - item['actual-count']) / item['actual-count'] : null;
}
function mean(values) {
  const valid = values.filter(value => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}
// Missing values stay last in both directions.
function order(a, b, ascending) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return (typeof a === 'number' ? a - b : compare(a, b)) * (ascending ? 1 : -1);
}
function renderGroup(id, group) {
  const section = el('section');
  const heading = el('div', undefined, 'section-heading');
  const title = el('h2', `Group ${id}`); title.id = `group-${id}`;
  section.setAttribute('aria-labelledby', title.id);
  heading.append(title, el('p', `${group.images.size} images · ${group.models.size} model configurations`));
  section.append(heading);
  const images = [...group.images.values()];
  const models = [...group.models.values()];
  const scores = new Map(models.map(model => [model, mean(images.map(item => deviation(model, item)))]));
  const imageScores = new Map(images.map(item => [item.image, mean(models.map(model => deviation(model, item)))]));
  let sortKey = 'error'; let ascending = true;
  const controls = el('fieldset'); controls.append(el('legend', 'Show in cells'));
  const modes = new Map();
  for (const [key, text] of [['deviation', 'Percentage deviation'], ['ratio', 'Predicted / actual'], ['percentage', 'Predicted / actual (%)'], ['predicted', 'Predicted count'], ['difference', 'Difference (actual − predicted)']]) {
    const label = el('label'); const input = el('input');
    input.type = 'checkbox'; input.checked = key === 'deviation' || key === 'ratio'; input.name = key;
    modes.set(key, input); label.append(input, document.createTextNode(text)); controls.append(label);
  }
  const sorting = el('div', undefined, 'sorting');
  const groupedLabel = el('label'); const grouped = el('input'); grouped.type = 'checkbox';
  groupedLabel.append(grouped, document.createTextNode('Group models by provider'));
  const columnLabel = el('label', 'Image order '); const columns = el('select'); columns.setAttribute('aria-label', 'Image order');
  for (const [value, text] of [['original', 'Original order'], ['easy', 'Lowest mean error first'], ['hard', 'Highest mean error first'], ['row', 'Selected model: lowest error first'], ['row-desc', 'Selected model: highest error first']]) {
    const option = el('option', text); option.value = value; columns.append(option);
  }
  columnLabel.append(columns);
  const modelLabel = el('label', 'Order images for '); const modelSelect = el('select'); modelSelect.setAttribute('aria-label', 'Order images for');
  models.forEach((model, index) => { const option = el('option', `${model.name} (T ${model.temperature ?? '—'})`); option.value = index; modelSelect.append(option); });
  modelLabel.append(modelSelect); modelLabel.hidden = true;
  sorting.append(groupedLabel, columnLabel, modelLabel);
  const wrap = el('div', undefined, 'table-wrap'); wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `Group ${id} results, scroll horizontally for all images`);
  section.append(controls, sorting, wrap);
  function directionButtons(axis, key, label, activeDirection, onSort) {
    const buttons = el('div', undefined, 'sort-directions');
    for (const [direction, text] of [['asc', '↑ Asc'], ['desc', '↓ Desc']]) {
      const button = el('button', text, 'direction-button'); button.type = 'button';
      button.dataset.axis = axis; button.dataset.key = key; button.dataset.direction = direction;
      button.setAttribute('aria-label', `Sort ${axis === 'column' ? 'models' : 'images'} by ${label}, ${direction === 'asc' ? 'ascending' : 'descending'}`);
      button.setAttribute('aria-pressed', String(activeDirection === direction));
      button.addEventListener('click', () => {
        onSort(direction); draw();
        [...wrap.querySelectorAll('.direction-button')].find(node => node.dataset.axis === axis && node.dataset.key === String(key) && node.dataset.direction === direction)?.focus({ preventScroll: true });
      });
      buttons.append(button);
    }
    return buttons;
  }
  function sortHeader(text, key) {
    const th = el('th'); th.scope = 'col'; th.setAttribute('aria-sort', sortKey === key ? ascending ? 'ascending' : 'descending' : 'none');
    th.append(el('span', text, 'column-title'), directionButtons('column', key, text,
      sortKey === key ? ascending ? 'asc' : 'desc' : null,
      direction => { sortKey = key; ascending = direction === 'asc'; }));
    return th;
  }
  function draw() {
    modelLabel.hidden = !columns.value.startsWith('row');
    const orderedImages = [...images].sort((a, b) => {
      const mode = columns.value;
      if (mode === 'original') return compare(a.id ?? a.image, b.id ?? b.image);
      const score = item => mode.startsWith('row') ? deviation(models[Number(modelSelect.value)], item) : imageScores.get(item.image);
      return order(score(a), score(b), mode === 'easy' || mode === 'row') || compare(a.id ?? a.image, b.id ?? b.image);
    });
    const sortedModels = [...models].sort((a, b) => {
      const value = model => sortKey === 'model' ? model.name : sortKey === 'error' ? scores.get(model) : deviation(model, group.images.get(sortKey));
      return order(value(a), value(b), ascending) || compare(a.name, b.name) || compare(a.temperature, b.temperature);
    });
    const table = el('table');
    table.append(el('caption', `Group ${id} · Column buttons sort models${grouped.checked ? ' within each provider' : ''}. Row buttons sort images by that model’s percentage deviation.`));
    const thead = el('thead'); const head = el('tr'); head.append(sortHeader('Model', 'model'));
    for (const item of orderedImages) {
      const th = sortHeader(item.label || item.image, item.image);
      const link = el('a', undefined, 'image-link'); link.href = `data/group${id}/${encodeURIComponent(item.image)}`; link.target = '_blank'; link.rel = 'noopener';
      const img = el('img'); img.src = link.href; img.alt = `Open ${item.label || item.image}`; img.loading = 'lazy'; link.append(img);
      th.prepend(link); th.append(el('small', `${item.image} · actual ${item['actual-count']}`)); head.append(th);
    }
    head.append(sortHeader('Normalized error', 'error')); thead.append(head); table.append(thead);
    const batches = new Map();
    for (const model of sortedModels) {
      const key = grouped.checked ? model.provider : '';
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(model);
    }
    const entries = [...batches]; if (grouped.checked) entries.sort(([a], [b]) => compare(a, b));
    for (const [provider, batch] of entries) {
      const body = el('tbody');
      if (provider) {
        const tr = el('tr', undefined, 'provider'); const th = el('th', provider); th.colSpan = images.length + 2; th.scope = 'rowgroup'; tr.append(th); body.append(tr);
      }
      for (const model of batch) {
        const tr = el('tr'); const name = el('th', model.name, 'model'); name.scope = 'row';
        name.append(el('small', `${model.provider} · Temperature ${model.temperature ?? '—'}`));
        const modelIndex = models.indexOf(model);
        name.append(directionButtons('row', modelIndex, `${model.name} (temperature ${model.temperature ?? 'unspecified'})`,
          columns.value.startsWith('row') && Number(modelSelect.value) === modelIndex ? columns.value === 'row' ? 'asc' : 'desc' : null,
          direction => { modelSelect.value = String(modelIndex); columns.value = direction === 'asc' ? 'row' : 'row-desc'; }));
        tr.append(name);
        for (const item of orderedImages) {
          const row = model.predictions.get(item.image); const td = el('td'); const error = deviation(model, item);
          if (!row || !validCount(row.model_count)) { td.textContent = '—'; td.title = 'No valid prediction'; }
          else {
            const predicted = row.model_count; const actual = item['actual-count']; const diff = actual - predicted;
            shade(td, error);
            td.title = `Predicted ${predicted}; actual ${actual}; ${predicted === actual ? 'exact count' : predicted > actual ? 'overcount' : 'undercount'}; absolute deviation ${error === null ? 'undefined (actual is zero)' : `${(100 * error).toFixed(2)}%`}`;
            if (modes.get('deviation').checked) td.append(el('span', error === null ? 'N/A' : `${(100 * error).toFixed(1)}%`, 'metric'));
            if (modes.get('ratio').checked) td.append(el('span', `${predicted} / ${actual}`, 'metric'));
            if (modes.get('percentage').checked) td.append(el('span', actual > 0 ? `${(100 * predicted / actual).toFixed(1)}% of actual` : 'N/A (actual = 0)', 'metric'));
            if (modes.get('predicted').checked) td.append(el('span', `Pred: ${predicted}`, 'metric'));
            if (modes.get('difference').checked) td.append(el('span', `Δ ${diff > 0 ? '+' : ''}${diff}`, 'metric'));
            if (!td.childNodes.length) { td.textContent = '·'; td.setAttribute('aria-label', td.title); }
          }
          tr.append(td);
        }
        const score = scores.get(model);
        const count = images.filter(item => deviation(model, item) !== null).length;
        const normalized = el('td', score === null ? '—' : `${(100 * score).toFixed(1)}%`, 'normalized'); shade(normalized, score);
        normalized.append(el('small', 'mean deviation'), el('small', `${count}/${images.length} evaluated`)); tr.append(normalized); body.append(tr);
      }
      table.append(body);
    }
    wrap.replaceChildren(table);
  }
  controls.addEventListener('change', draw); sorting.addEventListener('change', draw); draw(); return section;
}
async function load() {
  const warnings = [];
  const results = document.querySelector('#results');
  const summary = document.querySelector('#summary');
  try {
    const manifestURL = new URL('eval/include.txt', document.baseURI);
    const response = await fetch(manifestURL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot load eval/include.txt (HTTP ${response.status}).`);
    const files = [...new Set((await response.text()).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')))];
    const sources = await Promise.all(files.map(async name => {
      try {
        const url = new URL(name, manifestURL);
        if (!url.href.startsWith(new URL('.', manifestURL).href) || !url.pathname.endsWith('.json') || url.search || url.hash) throw new Error('use a JSON path within eval/');
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('expected a JSON array');
        return { name, rows };
      } catch (error) { warnings.push(`${name}: ${error.message}`); return null; }
    }));
    const loaded = sources.filter(Boolean);
    const groups = organize(loaded, warnings);
    const modelNames = new Set(); let imageCount = 0;
    for (const [id, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
      results.append(renderGroup(id, group)); imageCount += group.images.size;
      for (const model of group.models.values()) modelNames.add(model.name);
    }
    summary.replaceChildren(...[`${modelNames.size} models`, `${imageCount} images`, `${groups.size} groups`, `${loaded.length}/${files.length} result files loaded`].map(text => el('span', text)));
    if (!groups.size) results.append(el('p', 'No results to display. Add result JSON filenames to eval/include.txt.', 'empty'));
  } catch (error) {
    summary.textContent = 'Results unavailable';
    warnings.push(`${error.message} Serve this folder over HTTP or open its GitHub Pages URL.`);
  }
  if (warnings.length) {
    const errors = document.querySelector('#errors'); errors.hidden = false;
    errors.textContent = `Some results could not be loaded:\n${warnings.join('\n')}`;
  }
}
const ramp = document.querySelector('.color-ramp');
ramp.style.background = `linear-gradient(to right, ${Array.from({ length: 101 }, (_, i) => `${errorColor(i / 100)} ${i}%`).join(', ')})`;
load();
