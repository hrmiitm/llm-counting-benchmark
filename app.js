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
function renderGroup(id, group) {
  const section = el('section');
  const heading = el('div', undefined, 'section-heading');
  const title = el('h2', `Group ${id}`);
  title.id = `group-${id}`;
  section.setAttribute('aria-labelledby', title.id);
  heading.append(title, el('p', `${group.images.size} images · ${group.models.size} model configurations`));
  section.append(heading);
  const controls = el('fieldset');
  controls.append(el('legend', 'Show in cells'));
  const modes = new Map();
  for (const [key, text] of [['ratio', 'Predicted / actual'], ['predicted', 'Predicted count'], ['difference', 'Difference (actual − predicted)']]) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox'; input.checked = key === 'ratio'; input.name = key;
    modes.set(key, input); label.append(input, document.createTextNode(text)); controls.append(label);
  }
  const wrap = el('div', undefined, 'table-wrap');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `Group ${id} results, scroll horizontally for all images`);
  section.append(controls, wrap);
  const images = [...group.images.values()].sort((a, b) => compare(a.id ?? a.image, b.id ?? b.image));
  function draw() {
    const table = el('table');
    table.append(el('caption', `Group ${id} · Object counts by model and image`));
    const thead = el('thead'); const head = el('tr');
    const modelHeader = el('th', 'Model'); modelHeader.scope = 'col'; head.append(modelHeader);
    for (const item of images) {
      const th = el('th'); th.scope = 'col';
      const link = el('a', undefined, 'image-link');
      link.href = `data/group${id}/${encodeURIComponent(item.image)}`;
      link.target = '_blank'; link.rel = 'noopener';
      const img = el('img'); img.src = link.href; img.alt = item.label || item.image; img.loading = 'lazy';
      link.append(img, el('span', item.label || item.image));
      th.append(link, el('small', `${item.image} · actual ${item['actual-count']}`)); head.append(th);
    }
    const accuracyHeader = el('th', 'Accuracy'); accuracyHeader.scope = 'col'; head.append(accuracyHeader);
    const errorHeader = el('th', 'Normalized error ↓'); errorHeader.scope = 'col';
    errorHeader.title = 'Mean absolute percentage error across valid predictions with actual count greater than zero. Lower is better; 0% is perfect.';
    head.append(errorHeader);
    thead.append(head); table.append(thead);
    const providers = new Map();
    for (const model of [...group.models.values()].sort((a, b) => compare(a.provider, b.provider) || compare(a.name, b.name) || compare(a.temperature, b.temperature))) {
      if (!providers.has(model.provider)) providers.set(model.provider, []);
      providers.get(model.provider).push(model);
    }
    for (const [provider, models] of providers) {
      const body = el('tbody'); const providerRow = el('tr', undefined, 'provider');
      const providerCell = el('th', provider); providerCell.colSpan = images.length + 3; providerCell.scope = 'rowgroup';
      providerRow.append(providerCell); body.append(providerRow);
      for (const model of models) {
        const tr = el('tr'); const name = el('th', model.name, 'model'); name.scope = 'row';
        if (model.temperature !== undefined && model.temperature !== null) name.append(el('small', `Temperature ${model.temperature}`));
        tr.append(name); let correct = 0; let evaluated = 0; let normalizedTotal = 0; let normalizedCount = 0;
        for (const item of images) {
          const row = model.predictions.get(item.image);
          const td = el('td');
          if (!row || !validCount(row.model_count)) {
            td.textContent = '—'; td.title = 'No valid prediction';
          } else {
            evaluated++;
            const predicted = row.model_count; const actual = item['actual-count']; const diff = actual - predicted;
            if (diff === 0) correct++;
            if (actual > 0) { normalizedTotal += Math.abs(diff) / actual; normalizedCount++; }
            td.className = diff === 0 ? 'exact' : diff > 0 ? 'under' : 'over';
            td.title = `Predicted ${predicted}; actual ${actual}; difference ${diff}`;
            if (modes.get('ratio').checked) td.append(el('span', `${predicted} / ${actual}`, 'metric'));
            if (modes.get('predicted').checked) td.append(el('span', `Pred: ${predicted}`, 'metric'));
            if (modes.get('difference').checked) td.append(el('span', `Δ ${diff > 0 ? '+' : ''}${diff}`, 'metric'));
            if (!td.childNodes.length) { td.textContent = '·'; td.setAttribute('aria-label', td.title); }
          }
          tr.append(td);
        }
        const accuracy = el('td', evaluated ? `${(100 * correct / evaluated).toFixed(1)}%` : '—', 'accuracy');
        accuracy.append(el('small', `${correct}/${evaluated} exact`), el('small', `${evaluated}/${images.length} evaluated`));
        const normalized = el('td', normalizedCount ? `${(100 * normalizedTotal / normalizedCount).toFixed(1)}%` : '—', 'normalized');
        normalized.append(el('small', 'lower is better'), el('small', `${normalizedCount}/${images.length} evaluated`));
        tr.append(accuracy, normalized); body.append(tr);
      }
      table.append(body);
    }
    wrap.replaceChildren(table);
  }
  controls.addEventListener('change', draw); draw(); return section;
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
load();
