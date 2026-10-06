import { EFFORTS, finite, mean, isResultPath, nameOf, prepareData, confidenceRows,
  coverageCurve, acceptance, reasoningPairs } from './reasoning-data.mjs';

const $ = selector => document.querySelector(selector);
const pct = (n, digits = 2) => finite(n) ? `${n.toFixed(digits)}%` : 'Unavailable';
const usd = n => finite(n) ? `$${n.toFixed(6)}` : 'Unknown';
const cap = n => finite(n) ? n.toLocaleString('en-US') : 'Unrecorded';
const titleEffort = e => e[0].toUpperCase() + e.slice(1);
const state = { model: 'all', efforts: [...EFFORTS], cutoff: 90, scale: 'linear' };
let data = null, loading = false, notices = [], lastSources = [], refreshTimer;
const colors = new Map();

function node(tag, text, attrs = {}) {
  const element = document.createElement(tag);
  if (text !== null && text !== undefined) element.textContent = text;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}
function readState() {
  const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
  state.model = query.get('model') ?? 'all';
  state.efforts = query.has('efforts') ? query.get('efforts').split(',').filter(e => EFFORTS.includes(e)) : [...EFFORTS];
  const cutoff = Number(query.get('cutoff') ?? 90);
  state.cutoff = Number.isFinite(cutoff) ? Math.min(100, Math.max(0, cutoff)) : 90;
  state.scale = query.get('scale') === 'log' ? 'log' : 'linear';
}
function writeState(section = location.hash.split('?')[0].slice(1) || 'reasoning', push = false) {
  const query = new URLSearchParams({ model: state.model, efforts: state.efforts.join(','),
    cutoff: String(state.cutoff), scale: state.scale });
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}${location.search}#${section}?${query}`);
}
function syncControls() {
  $('#model-filter').value = state.model;
  for (const input of document.querySelectorAll('input[name=effort]')) input.checked = state.efforts.includes(input.value);
  $('#confidence-cutoff').value = state.cutoff;
  $('#cutoff-value').textContent = `${state.cutoff}%`;
  $('#cost-scale').value = state.scale;
}
const selected = () => data.configs.filter(c => (state.model === 'all' || c.model === state.model) && state.efforts.includes(c.effort));
const colorOf = model => colors.get(model) ?? 'var(--series-1)';

async function fetchJSON(path) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function discover() {
  // GitHub Pages renders this new Liquid index automatically at build time.
  try {
    const index = await fetchJSON('reasoning-sources.json');
    if (!Array.isArray(index.files)) throw new Error('Invalid file index.');
    return [...new Set(index.files.filter(isResultPath))].sort();
  } catch {
    // Python's local server exposes a directory listing; no generated index needed.
    const response = await fetch('eval4/', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('The eval4 file index is unavailable. Publish reasoning-sources.json through the existing GitHub Pages build.');
    const document = new DOMParser().parseFromString(await response.text(), 'text/html');
    const paths = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
      .filter(path => /^[^/]+\.json$/.test(path)).map(path => `eval4/${decodeURIComponent(path)}`).filter(isResultPath);
    if (!paths.length) throw new Error('No eval4 result files were discovered.');
    return [...new Set(paths)].sort();
  }
}
async function load() {
  if (loading) return;
  const initial = !data;
  loading = true; $('#refresh').disabled = true;
  $('#load-status').textContent = 'Reading the saved eval4 results…';
  try {
    const [paths, metadata] = await Promise.all([discover(), fetchJSON('eval2/metadata.json')]);
    if (!paths.length) throw new Error('No eval4 result files were found.');
    const outcomes = await Promise.allSettled(paths.map(async path => ({ path, data: await fetchJSON(path) })));
    const sources = outcomes.filter(r => r.status === 'fulfilled').map(r => r.value);
    notices = outcomes.flatMap((r, i) => r.status === 'rejected' ? [`Could not load ${paths[i]}; this result is not represented.`] : []);
    data = prepareData(sources, metadata);
    if (!data.configs.length) throw new Error('No valid model/effort envelopes are available in eval4.');
    lastSources = sources.filter(s => data.configs.some(c => c.path === s.path));
    data.models.forEach((model, i) => colors.set(model, `var(--series-${i % 10 + 1})`));
    if (state.model !== 'all' && !data.models.includes(state.model)) state.model = 'all';
    const select = $('#model-filter'); select.replaceChildren(node('option', 'All LLMs', { value: 'all' }));
    data.models.forEach(model => select.append(node('option', nameOf(model), { value: model })));
    const strip = $('#image-strip'); strip.replaceChildren();
    for (const image of data.images) {
      const link = node('a', null, { href: `data/group${encodeURIComponent(image.group)}/${encodeURIComponent(image.image)}`,
        'aria-label': `Open ${image.label} image` });
      link.append(node('img', null, { src: link.getAttribute('href'), alt: image.label, loading: 'lazy' })); strip.append(link);
    }
    const sourcesList = $('#source-links'); sourcesList.replaceChildren();
    lastSources.forEach(source => { const li = node('li'); li.append(node('a', source.path, { href: source.path })); sourcesList.append(li); });
    $('#loaded-at').textContent = `Last read ${new Date().toLocaleString()}. Published JSON is fetched again on refresh; no benchmark values are embedded in this page.`;
    const stats = data.configs.flatMap(c => c.rows);
    $('#load-status').textContent = `${data.models.length} LLMs · ${data.configs.length} reasoning configurations · ${data.images.length} selected images · ${stats.filter(r => r.success).length} successful answers. Data source: eval4.`;
    $('#load-status').classList.remove('error'); $('#page-content').hidden = false;
    syncControls(); render();
    const section = location.hash.split('?')[0].slice(1);
    if (initial && ['cost', 'confidence', 'coverage', 'answers', 'records'].includes(section)) document.getElementById(section).scrollIntoView({ behavior: 'instant' });
  } catch (error) {
    $('#page-content').hidden = true; $('#load-status').classList.add('error');
    $('#load-status').textContent = `Charts unavailable: ${error.message} No conclusions are displayed from stale or missing data.`;
    const retry = node('button', 'Retry loading', { type: 'button' }); retry.addEventListener('click', load);
    $('#load-status').append(document.createTextNode(' '), retry);
  } finally { loading = false; $('#refresh').disabled = false; }
}

function renderLegend() {
  const legend = $('#model-legend'); legend.replaceChildren();
  const all = node('button', 'All LLMs', { type: 'button', 'aria-pressed': String(state.model === 'all') });
  all.addEventListener('click', () => { state.model = 'all'; syncControls(); render(); writeState(); }); legend.append(all);
  for (const model of data.models) {
    const button = node('button', null, { type: 'button', 'aria-pressed': String(state.model === model) });
    const dot = node('span', null, { class: 'legend-dot', 'aria-hidden': 'true' }); dot.style.setProperty('--color', colorOf(model));
    button.append(dot, document.createTextNode(nameOf(model)));
    button.addEventListener('click', () => { state.model = state.model === model ? 'all' : model; syncControls(); render(); writeState(); });
    legend.append(button);
  }
}
function headline(label, value, detail) {
  const box = node('div', null, { class: 'headline' }); box.append(node('span', label), node('strong', value), node('small', detail)); return box;
}
function renderHeadlines(configs) {
  const complete = configs.filter(c => c.complete), eligible = configs.filter(c => c.costEligible);
  const best = [...complete].sort((a, b) => a.deviation - b.deviation)[0];
  const cheap = [...eligible].sort((a, b) => a.totalCost - b.totalCost)[0];
  $('#headlines').replaceChildren(
    headline('Closest counts', best ? pct(best.deviation) : 'Unavailable', best ? `${best.name} · ${titleEffort(best.effort)}` : 'Requires the complete image set'),
    headline(`Lowest ${data.images.length}-image cost`, cheap ? usd(cheap.totalCost) : 'Unavailable', cheap ? `${cheap.name} · ${titleEffort(cheap.effort)}` : 'Requires complete answers and known cost'),
    headline('Comparable cost points', `${eligible.length} / ${configs.length}`, 'Complete image coverage and known charges'));
}

const SVG = 'http://www.w3.org/2000/svg';
function svgNode(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}
function plot(target, configs, kind) {
  const container = $(target); container.replaceChildren();
  let points;
  if (kind === 'cost') points = configs.filter(c => c.costEligible && (state.scale !== 'log' || c.totalCost > 0));
  if (kind === 'confidence') points = configs.flatMap(confidenceRows);
  if (kind === 'coverage') points = configs.flatMap(coverageCurve);
  if (!points.length) { container.append(node('p', 'No eligible points for this selection. Select another model or reasoning level; missing answers are never shown as zero error.', { class: 'empty-plot' })); return; }
  const width = Math.max(280, Math.round(container.getBoundingClientRect().width)), height = width < 500 ? 380 : 430;
  const left = width < 500 ? 47 : 64, right = 25, top = 62, bottom = 64, pw = width - left - right, ph = height - top - bottom;
  const maxError = Math.max(5, Math.ceil(Math.max(...points.map(p => p.deviation)) * 1.15 / 5) * 5);
  let x;
  const minCost = Math.min(...points.map(p => p.totalCost ?? Infinity)), maxCost = Math.max(...points.map(p => p.totalCost ?? 0));
  const logMin = Math.log10(minCost) - .12, logMax = Math.max(logMin + .35, Math.log10(maxCost) + .12);
  if (kind === 'cost') x = state.scale === 'log'
    ? value => left + (Math.log10(value) - logMin) / (logMax - logMin) * pw
    : value => left + value / (maxCost * 1.12 || 1) * pw;
  else x = value => left + value / 100 * pw;
  const y = value => top + value / maxError * ph; // Zero is at the TOP in all three plots.
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'group', 'aria-label':
    `${kind === 'cost' ? 'Cost' : kind === 'confidence' ? 'Confidence' : 'Coverage'} versus counting deviation. Zero error is at the top.` });
  container.append(svg);
  svg.append(svgNode('text', { x: left, y: 23, class: 'axis-title' }, `${kind === 'confidence' ? 'Absolute' : 'Mean absolute'} count deviation (%)`));
  svg.append(svgNode('text', { x: left, y: 43, class: 'guide' }, '↑ LOWER ERROR / BETTER'));
  for (let i = 0; i <= 4; i++) {
    const value = maxError * i / 4, py = y(value);
    svg.append(svgNode('line', { x1: left, y1: py, x2: width - right, y2: py, class: 'grid' }));
    svg.append(svgNode('text', { x: left - 9, y: py + 4, 'text-anchor': 'end', class: 'axis-text' }, value % 1 ? value.toFixed(1) : String(value)));
  }
  const ticks = kind === 'coverage' ? [0, ...data.images.map((_, i) => (i + 1) / data.images.length * 100)]
    : kind === 'cost' ? Array.from({ length: 5 }, (_, i) => state.scale === 'log' ? 10 ** (logMin + (logMax - logMin) * i / 4) : maxCost * 1.12 * i / 4)
      : [0, 25, 50, 75, 100];
  for (const tick of ticks) {
    const px = x(tick);
    svg.append(svgNode('line', { x1: px, y1: top, x2: px, y2: height - bottom, class: 'grid' }));
    const label = kind === 'cost' ? `$${tick.toFixed(tick < .01 ? 4 : 3)}` : `${Math.round(tick)}%`;
    svg.append(svgNode('text', { x: px, y: height - bottom + 22, 'text-anchor': 'middle', class: 'axis-text' }, label));
  }
  const xTitle = kind === 'cost' ? 'Cost of the same image set, USD → more expensive'
    : kind === 'confidence' ? 'Model-reported confidence (%) →' : 'Coverage (%) → more answers kept';
  svg.append(svgNode('text', { x: left + pw / 2, y: height - 12, 'text-anchor': 'middle', class: 'axis-title' },
    width < 500 && kind === 'cost' ? 'Same-image cost, USD →' : xTitle));
  const dash = effort => effort === 'medium' ? '7 4' : effort === 'high' ? '2 4' : '';
  if (kind === 'cost') {
    for (const model of new Set(points.map(p => p.model))) {
      if (new Set(data.configs.filter(c => c.model === model).map(c => c.signature)).size > 1) continue;
      for (let i = 0; i < EFFORTS.length - 1; i++) {
        const a = points.find(p => p.model === model && p.effort === EFFORTS[i]);
        const b = points.find(p => p.model === model && p.effort === EFFORTS[i + 1]);
        if (a && b) svg.append(svgNode('path', { d: `M ${x(a.totalCost)} ${y(a.deviation)} L ${x(b.totalCost)} ${y(b.deviation)}`,
          stroke: colorOf(model), class: 'series-line', 'data-model': model }));
      }
    }
  } else if (kind === 'coverage') {
    for (const config of configs) {
      const curve = coverageCurve(config);
      if (curve.length > 1) svg.append(svgNode('path', { d: curve.map((p, i) => `${i ? 'L' : 'M'} ${x(p.coverage)} ${y(p.deviation)}`).join(' '),
        stroke: colorOf(config.model), 'stroke-dasharray': dash(config.effort), class: 'series-line',
        'data-model': config.model, 'data-effort': config.effort }));
    }
  } else {
    const px = x(state.cutoff);
    svg.append(svgNode('line', { x1: px, y1: top, x2: px, y2: height - bottom,
      stroke: 'var(--mark-outline)', 'stroke-dasharray': '4 5', 'aria-hidden': 'true' }));
  }
  for (const p of points) {
    const px = x(kind === 'cost' ? p.totalCost : kind === 'confidence' ? p.confidence * 100 : p.coverage), py = y(p.deviation);
    let detail;
    if (kind === 'cost') detail = `${p.name}, ${titleEffort(p.effort)}: ${usd(p.totalCost)} for ${p.n} images; mean deviation ${pct(p.deviation)}; ${cap(p.data.max_tokens)}-token cap.`;
    if (kind === 'confidence') detail = `${nameOf(p.model)}, ${titleEffort(p.effort)} · ${p.image} (${p.label}): prediction ${p.count}, supplied count ${p.actual}; deviation ${pct(p.deviation)}; confidence ${pct(p.confidence * 100, 1)}.`;
    if (kind === 'coverage') detail = `${nameOf(p.model)}, ${titleEffort(p.effort)}: keep ${p.accepted}/${p.denominator} answers (${pct(p.coverage, 1)} coverage), confidence at least ${pct(p.confidence * 100, 1)}; mean deviation ${pct(p.deviation)}. Images: ${p.images.join(', ')}.`;
    const size = kind === 'confidence' ? 4.5 : 6;
    const attrs = { fill: colorOf(p.model), class: `mark ${kind}-point`, tabindex: '0', role: 'button', 'aria-label': detail,
      'data-model': p.model, 'data-effort': p.effort, 'data-deviation': p.deviation,
      'data-x': kind === 'cost' ? p.totalCost : kind === 'confidence' ? p.confidence * 100 : p.coverage };
    let mark;
    if (p.effort === 'low') mark = svgNode('circle', { ...attrs, cx: px, cy: py, r: size });
    else if (p.effort === 'medium') mark = svgNode('path', { ...attrs, d: `M ${px} ${py - size - 1} L ${px + size + 1} ${py} L ${px} ${py + size + 1} L ${px - size - 1} ${py} Z` });
    else mark = svgNode('rect', { ...attrs, x: px - size, y: py - size, width: size * 2, height: size * 2, rx: 1 });
    mark.append(svgNode('title', {}, detail));
    const inspect = () => {
      const box = $(`#${kind}-detail`); box.replaceChildren(document.createTextNode(detail));
      if (kind === 'confidence') box.append(document.createTextNode(' '), node('a', 'Open image ↗', {
        href: `data/group${encodeURIComponent(p.group)}/${encodeURIComponent(p.image)}`, target: '_blank', rel: 'noopener' }));
      if (kind === 'cost') box.append(document.createTextNode(' '), node('a', 'Raw JSON ↗', { href: p.path, target: '_blank', rel: 'noopener' }));
    };
    for (const event of ['mouseenter', 'focus', 'click']) mark.addEventListener(event, inspect);
    mark.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); inspect(); } });
    svg.append(mark);
    if (kind === 'cost' && state.model !== 'all') svg.append(svgNode('text', { x: px + 10, y: py - 9, class: 'point-label' }, titleEffort(p.effort)));
  }
}

function renderReadings(configs) {
  const eligible = configs.filter(c => c.costEligible), pairs = reasoningPairs(configs);
  const better = pairs.filter(p => p.errorReduction > 1e-9).length;
  $('#cost-caption').textContent = `${eligible.length} comparable points for the same ${data.images.length} images. Missing predictions or unknown charges exclude a configuration from this plot. Mean error weights each image equally. ${state.scale === 'log' ? 'Log spacing represents cost ratios; zero-cost points are omitted.' : 'Linear spacing represents dollar differences.'}`;
  $('#cost-reading').textContent = pairs.length
    ? `${better} of ${pairs.length} comparable low-to-high model pairs reduce mean deviation at high effort. The cost of each change is visible horizontally; a move down and right pays more for a worse count. Inspect a model to separate its path.`
    : 'Select low and high for a model with complete, matching configurations to compare the extra cost with the change in counting error.';
  const accepted = acceptance(configs, state.cutoff / 100);
  const high = configs.flatMap(confidenceRows).filter(r => r.confidence >= state.cutoff / 100);
  $('#confidence-reading').textContent = high.length
    ? `At confidence of at least ${state.cutoff}%, ${high.length} selected answers have mean deviation ${pct(mean(high.map(r => r.deviation)))}. The largest deviation among them is ${pct(Math.max(...high.map(r => r.deviation)))}. Confidence alone is not a numerical error bound.`
    : `No selected valid answers reach ${state.cutoff}% confidence. Lower the cutoff or inspect another model.`;
  $('#cutoff-reading').textContent = accepted.accepted
    ? `Keep ${accepted.accepted}/${accepted.denominator} possible answers (${pct(accepted.coverage, 1)} coverage). Mean deviation: ${pct(accepted.deviation)}, compared with ${pct(accepted.baseline)} across all confidence-bearing answers in this selection.`
    : configs.length ? `Keep 0/${accepted.denominator} possible answers at this cutoff. Mean error is undefined when no answers are accepted.` : 'Select a reasoning level to explore confidence-based coverage.';
  const improvements = configs.map(c => {
    const curve = coverageCurve(c); return curve.length > 1 ? curve[0].deviation < curve.at(-1).deviation : null;
  }).filter(x => x !== null);
  $('#coverage-reading').textContent = improvements.length
    ? `${improvements.filter(Boolean).length} of ${improvements.length} selected curves have lower error in their highest-confidence group than when all valid answers are kept. Follow each curve: admitting a less confident answer can improve or worsen the average. This pilot does not validate a cutoff for new images.`
    : 'More than one distinct confidence group is needed to assess how error changes with coverage. Equal confidence scores provide no ranking within a tie.';
}

function renderQuestions(configs) {
  const complete = configs.filter(c => c.complete), eligible = configs.filter(c => c.costEligible);
  const best = [...complete].sort((a, b) => a.deviation - b.deviation)[0], cheap = [...eligible].sort((a, b) => a.totalCost - b.totalCost)[0];
  const pairs = reasoningPairs(configs), accepted = acceptance(configs, state.cutoff / 100);
  const partial = configs.filter(c => !c.costEligible);
  const questions = [
    ['Which setting gives the closest counts?', best ? `${best.name} at ${best.effort} has the lowest mean deviation among complete selected configurations: ${pct(best.deviation)} over ${best.n} images. A small deviation means close counts; it is not an exact-match score.` : 'No selected configuration has complete scoring coverage. Partial means are shown in the table but are not ranked against complete runs.'],
    ['Which setting costs the least for the same images?', cheap ? `${cheap.name} at ${cheap.effort}: ${usd(cheap.totalCost)} for the full image set, with ${pct(cheap.deviation)} mean deviation. This is the saved API charge, not a current price estimate.` : 'A fair total-cost ranking requires complete answers for the full image set and known charges. None of the selected configurations meets both conditions.'],
    ['Does high reasoning actually improve counting?', pairs.length ? pairs.map(p => `${p.name}: high ${p.errorReduction > 0 ? 'reduces' : p.errorReduction < 0 ? 'increases' : 'does not change'} mean deviation ${p.errorReduction ? `by ${Math.abs(p.errorReduction).toFixed(2)} percentage points` : ''}; cost changes from ${usd(p.low.totalCost)} to ${usd(p.high.totalCost)}.`).join(' ') + ' These are single-run observations with matching within-model settings, not a guaranteed effect.' : 'Select low and high levels with complete results and matching non-effort settings. Without those conditions, the page makes no reasoning-effect claim.'],
    ['Do the most confident answers have smaller errors?', accepted.accepted ? `At your ${state.cutoff}% cutoff, accepted answers have ${pct(accepted.deviation)} mean deviation; all valid, confidence-bearing answers have ${pct(accepted.baseline)}. ${accepted.deviation < accepted.baseline ? 'Selection improves the observed average in this view.' : accepted.deviation > accepted.baseline ? 'Selection worsens the observed average in this view.' : 'The observed average is unchanged.'} Inspect individual curves before using a pooled result.` : 'No answers meet your selected cutoff, so their mean error cannot be calculated. Lower the cutoff to compare accepted and unfiltered answers.'],
    ['How much coverage do I give up?', `Your ${state.cutoff}% cutoff keeps ${accepted.accepted} of ${accepted.denominator} possible answers (${pct(accepted.coverage, 1)}). The denominator includes missing or failed answers. In the all-model view, the same images are counted again for each model/effort configuration; this is a pooled experiment summary.`],
    ['Why is a close answer treated as useful?', 'Deviation measures distance from the supplied count. For example, a prediction of 98 against a supplied count of 100 has 2% deviation. An exact-match metric would give it no credit, but these charts represent it as a close count. Each image receives equal weight.'],
    ['Is this confidence calibration?', 'No. The saved confidence is P(exact count), while deviation measures numerical closeness. These charts explore association and selective counting error. A claim of formal probability calibration requires outcomes that match the stated probability and more evidence than this small pilot.'],
    ['Why might a point or a model be missing?', !configs.length ? 'No reasoning configurations are selected. Enable at least one level to see its results.' : partial.length ? partial.map(c => `${c.name}, ${c.effort}: ${c.successful}/${c.n} valid answers; ${c.failed} failed, ${c.skipped} skipped, ${c.missing} missing; ${c.unknownCosts} unknown charges.`).join(' ') + ' Missing means are not zero. Only valid predictions with supplied counts and valid confidence enter the confidence plots.' : `All ${configs.length} selected configurations have complete answers and known charges. Models with no saved eval4 envelopes do not appear; smoke tests are excluded. Confidence plots omit missing or invalid confidence even when a count is saved. If a later run fails or its charge is unknown, its cost point disappears and its coverage stops short of the full set.`],
    ['Did only reasoning effort change?', `The page checks recorded prompts, sampling, token caps, provider pins, tools, fallbacks and timeouts within each model. Lines and reasoning comparisons are withheld if those settings differ across efforts. Across selected models, the recorded token caps are ${[...new Set(configs.map(c => cap(c.data.max_tokens)))].join(' / ') || 'unavailable'}. Cross-model differences cannot be attributed to effort alone.`],
    ['Can I use this to choose a production model?', `Use it to identify candidates, then test your own images and error tolerance. This is a selected ${data.images.length}-image pilot, not the full FSC-147 benchmark. One answer per image and configuration gives little evidence about repeatability or generalization. The supplied counts have not been independently audited here.`],
  ];
  const container = $('#questions'), open = new Set([...container.querySelectorAll('details[open]')].map(d => d.dataset.question));
  const first = !container.children.length; container.replaceChildren();
  questions.forEach(([question, answer], i) => {
    const detail = node('details', null, { class: 'question', 'data-question': String(i) });
    detail.open = first ? i < 2 : open.has(String(i)); detail.append(node('summary', question), node('p', answer)); container.append(detail);
  });
}
function renderRecords(configs) {
  const body = $('#records-body'); body.replaceChildren();
  for (const c of configs) {
    const tr = node('tr', null, { 'data-model': c.model, 'data-effort': c.effort,
      'data-deviation': c.deviation ?? '', 'data-cost': c.totalCost ?? '', class: c.costEligible ? '' : 'partial' });
    tr.style.setProperty('--color', colorOf(c.model));
    const label = node('td', `${c.name} · ${titleEffort(c.effort)}`); label.append(node('small', c.data.provider_endpoint ?? 'Provider unrecorded')); tr.append(label);
    tr.append(node('td', `${c.successful}/${c.n}`));
    const error = node('td', pct(c.deviation)); if (!c.complete) error.append(node('small', `Partial: ${c.scored} scored images`)); tr.append(error);
    const cost = node('td', c.totalCost !== null ? usd(c.totalCost) : `${usd(c.knownCost)} known`);
    if (c.totalCost === null) cost.append(node('small', `${c.unknownCosts} unknown charges · incomplete comparison`)); tr.append(cost);
    tr.append(node('td', pct(c.confidence === null ? null : c.confidence * 100, 1)), node('td', cap(c.data.max_tokens)));
    const source = node('td'); source.append(node('a', 'JSON ↗', { href: c.path, 'aria-label': `Raw JSON for ${c.name} at ${c.effort}` })); tr.append(source); body.append(tr);
  }
}
function renderPlots() {
  if (!data || $('#page-content').hidden) return;
  const configs = selected(); plot('#cost-chart', configs, 'cost'); plot('#confidence-chart', configs, 'confidence'); plot('#coverage-chart', configs, 'coverage');
}
function render() {
  $('#cost-detail').textContent = 'Hover, tap or keyboard-focus a point for its cost and counting deviation.';
  $('#confidence-detail').textContent = 'Select a point to inspect the image, supplied count, prediction and confidence.';
  $('#coverage-detail').textContent = 'Select a curve point to see its confidence cutoff, accepted images and mean error.';
  const configs = selected(); renderLegend(); renderHeadlines(configs); renderReadings(configs); renderQuestions(configs); renderRecords(configs); renderPlots();
  $('#selection-note').textContent = `${state.model === 'all' ? 'All loaded LLMs' : nameOf(state.model)} · ${state.efforts.map(titleEffort).join(' / ') || 'no reasoning levels selected'} · ${configs.length} configurations. Select a model in the legend to separate overlapping points.`;
  const warnings = [...notices, ...data.warnings];
  const limit = data.warnings.filter(w => w.startsWith('Token caps differ')).join(' ');
  $('#comparison-limit').textContent = limit; $('#comparison-limit').hidden = !limit;
  for (const c of configs.filter(c => !c.costEligible)) warnings.push(`${c.name}, ${c.effort}: ${c.successful}/${c.n} valid answers and ${c.unknownCosts} unknown charges. Excluded from the full-image cost plot.`);
  const list = $('#data-notices ul'); list.replaceChildren(...warnings.map(w => node('li', w)));
  $('#data-notices').hidden = !warnings.length;
}

readState();
for (const anchor of document.querySelectorAll('a[href^="#"]')) anchor.addEventListener('click', event => {
  const section = anchor.getAttribute('href').slice(1);
  if (document.getElementById(section)) { event.preventDefault(); writeState(section, true); document.getElementById(section).scrollIntoView(); }
});
$('#model-filter').addEventListener('change', event => { state.model = event.target.value; render(); writeState(); });
for (const input of document.querySelectorAll('input[name=effort]')) input.addEventListener('change', () => {
  state.efforts = [...document.querySelectorAll('input[name=effort]:checked')].map(i => i.value); render(); writeState();
});
$('#cost-scale').addEventListener('change', event => { state.scale = event.target.value; render(); writeState(); });
$('#confidence-cutoff').addEventListener('input', event => { state.cutoff = Number(event.target.value); syncControls(); render(); writeState(); });
$('#refresh').addEventListener('click', load);
$('#auto-refresh').addEventListener('change', event => {
  clearInterval(refreshTimer);
  if (event.target.checked) refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 60000);
});
window.addEventListener('hashchange', () => { readState(); if (data) { if (state.model !== 'all' && !data.models.includes(state.model)) state.model = 'all'; syncControls(); render(); } });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPlots, 120); });
load();
