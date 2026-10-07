import { EFFORTS, finite, isResultPath, nameOf, prepareData, confidenceSummary,
  coverageCurve, acceptance, reasoningPairs } from './reasoning-data.mjs?v=3';

const $ = selector => document.querySelector(selector);
const pct = (n, digits = 2) => finite(n) ? `${n.toFixed(digits)}%` : 'Unavailable';
const usd = n => finite(n) ? `$${n.toFixed(6)}` : 'Unknown';
const cap = n => finite(n) ? n.toLocaleString('en-US') : 'Unrecorded';
const titleEffort = e => e === 'none' ? 'Colab GPU' : e[0].toUpperCase() + e.slice(1);
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
const selected = () => data.configs.filter(c => (state.model === 'all' || c.model === state.model) && (c.isDL || state.efforts.includes(c.effort)));
const colorOf = model => colors.get(model) ?? 'var(--series-1)';
function revealSection(section, behavior) {
  const element = document.getElementById(section);
  if (!element) return;
  if (element.tagName === 'DETAILS') { element.open = true; renderPlots(); }
  element.scrollIntoView(behavior ? { behavior } : undefined);
}

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
    const select = $('#model-filter'); select.replaceChildren(node('option', data.configs.some(c => c.isDL) ? 'All models' : 'All LLMs', { value: 'all' }));
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
    $('#load-status').textContent = `${data.models.length} models · ${data.configs.length} configurations · ${data.images.length} images · predictions from eval4.`;
    $('#load-status').classList.remove('error'); $('#page-content').hidden = false;
    syncControls(); render();
    const section = location.hash.split('?')[0].slice(1);
    if (initial && ['cost', 'confidence', 'coverage', 'answers', 'records'].includes(section)) revealSection(section, 'instant');
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
  if (kind === 'confidence') points = configs.map(confidenceSummary).filter(Boolean);
  if (kind === 'coverage') points = configs.flatMap(coverageCurve);
  if (!points.length) { container.append(node('p', 'No eligible points for this selection. Select another model or reasoning level; missing answers are never shown as zero error.', { class: 'empty-plot' })); return; }
  const width = Math.max(280, Math.round(container.getBoundingClientRect().width)), height = width < 500 ? 380 : 430;
  const left = width < 500 ? 54 : 72, right = 30, top = 62, bottom = 64, pw = width - left - right, ph = height - top - bottom;
  const maxError = Math.max(5, Math.ceil(Math.max(...points.map(p => p.deviation)) * 1.15 / 5) * 5);
  let x;
  const minCost = Math.min(...points.map(p => p.totalCost ?? Infinity)), maxCost = Math.max(...points.map(p => p.totalCost ?? 0));
  const logMin = Math.log10(minCost) - .12, logMax = Math.max(logMin + .35, Math.log10(maxCost) + .12);
  if (kind === 'cost') x = state.scale === 'log'
    ? value => left + (Math.log10(value) - logMin) / (logMax - logMin) * pw
    : value => left + value / (maxCost * 1.12 || 1) * pw;
  else x = value => left + value / 100 * pw;
  const y = value => top + ph - value / maxError * ph; // Conventional Y axis: zero at bottom.
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'group', 'aria-label':
    `${kind === 'cost' ? 'Cost' : kind === 'confidence' ? 'Mean confidence' : 'Coverage'} versus mean counting error. Zero error is at the bottom; error increases upward.` });
  container.append(svg);
  svg.append(svgNode('text', { x: left, y: 23, class: 'axis-title' }, 'Mean counting error (%)'));
  svg.append(svgNode('text', { x: left, y: 43, class: 'guide' }, '↓ LOWER IS BETTER'));
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
  const xTitle = kind === 'cost' ? 'Total cost for all images, USD'
    : kind === 'confidence' ? 'Mean confidence (%)' : 'Coverage (%)';
  svg.append(svgNode('text', { x: left + pw / 2, y: height - 12, 'text-anchor': 'middle', class: 'axis-title' },
    width < 500 && kind === 'cost' ? 'Same-image cost, USD →' : xTitle));
  const dash = effort => effort === 'medium' ? '7 4' : effort === 'high' ? '2 4' : '';
  if (kind === 'cost' || kind === 'confidence') {
    for (const model of new Set(points.map(p => p.model))) {
      if (new Set(data.configs.filter(c => c.model === model).map(c => c.signature)).size > 1) continue;
      for (let i = 0; i < EFFORTS.length - 1; i++) {
        const a = points.find(p => p.model === model && p.effort === EFFORTS[i]);
        const b = points.find(p => p.model === model && p.effort === EFFORTS[i + 1]);
        if (a && b) svg.append(svgNode('path', { d: `M ${x(kind === 'cost' ? a.totalCost : a.confidence * 100)} ${y(a.deviation)} L ${x(kind === 'cost' ? b.totalCost : b.confidence * 100)} ${y(b.deviation)}`,
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
  }
  for (const p of points) {
    const px = x(kind === 'cost' ? p.totalCost : kind === 'confidence' ? p.confidence * 100 : p.coverage), py = y(p.deviation);
    let detail;
    if (kind === 'cost') detail = `${p.name}, ${titleEffort(p.effort)}: ${usd(p.totalCost)} for ${p.n} images; mean deviation ${pct(p.deviation)}; ${p.isDL ? `${p.data.gpu}; ${p.totalInferenceSeconds.toFixed(6)}s inference; ${usd(p.costPerImage)}/image; ${usd(p.costPer1000Images)}/1,000 images (compute estimate).` : `${cap(p.data.max_tokens)}-token cap.`}`;
    if (kind === 'confidence') detail = `${p.name}, ${titleEffort(p.effort)}: mean confidence ${pct(p.confidence * 100, 1)}; mean error ${pct(p.deviation)} across all ${p.imageCount} images.`;
    if (kind === 'coverage') detail = `${nameOf(p.model)}, ${titleEffort(p.effort)}: keep ${p.accepted}/${p.denominator} answers (${pct(p.coverage, 1)} coverage), confidence at least ${pct(p.confidence * 100, 1)}; mean deviation ${pct(p.deviation)}. Images: ${p.images.join(', ')}.`;
    const size = 7;
    const attrs = { fill: colorOf(p.model), class: `mark ${kind}-point`, tabindex: '0', role: 'button', 'aria-label': detail,
      'data-model': p.model, 'data-effort': p.effort, 'data-deviation': p.deviation,
      'data-image-count': kind === 'confidence' ? p.imageCount : '',
      'data-x': kind === 'cost' ? p.totalCost : kind === 'confidence' ? p.confidence * 100 : p.coverage };
    let mark;
    if (p.isDL) mark = svgNode('path', { ...attrs, d: `M ${px} ${py - size} L ${px + size} ${py + size} L ${px - size} ${py + size} Z` });
    else if (p.effort === 'low') mark = svgNode('circle', { ...attrs, cx: px, cy: py, r: size });
    else if (p.effort === 'medium') mark = svgNode('path', { ...attrs, d: `M ${px} ${py - size - 1} L ${px + size + 1} ${py} L ${px} ${py + size + 1} L ${px - size - 1} ${py} Z` });
    else mark = svgNode('rect', { ...attrs, x: px - size, y: py - size, width: size * 2, height: size * 2, rx: 1 });
    mark.append(svgNode('title', {}, detail));
    const inspect = () => {
      const box = $(`#${kind}-detail`); box.replaceChildren(document.createTextNode(detail));
      if (kind === 'cost' || kind === 'confidence') box.append(document.createTextNode(' '), node('a', 'Raw JSON ↗', { href: p.path, target: '_blank', rel: 'noopener' }));
    };
    for (const event of ['mouseenter', 'focus', 'click']) mark.addEventListener(event, inspect);
    mark.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); inspect(); } });
    svg.append(mark);
    if (kind !== 'coverage' && state.model !== 'all' && !p.isDL) {
      const label = titleEffort(p.effort), labelWidth = label.length * 8;
      const fitsRight = px + 12 + labelWidth < width - 4;
      svg.append(svgNode('text', { x: fitsRight ? px + 12 : px - 12, y: py - 12,
        'text-anchor': fitsRight ? 'start' : 'end', class: 'point-label' }, label));
    }
  }
  const legend = node('div', null, { class: 'chart-model-legend', 'aria-label': 'Models in this chart' });
  for (const model of new Set(points.map(p => p.model))) {
    const button = node('button', null, { type: 'button', 'aria-label': `Inspect ${nameOf(model)}` });
    const dot = node('span', null, { class: 'legend-dot', 'aria-hidden': 'true' }); dot.style.setProperty('--color', colorOf(model));
    button.append(dot, document.createTextNode(nameOf(model)));
    button.addEventListener('click', () => { state.model = state.model === model ? 'all' : model; syncControls(); render(); writeState(); });
    legend.append(button);
  }
  container.append(legend);
}

function renderReadings(configs) {
  const eligible = configs.filter(c => c.costEligible), pairs = reasoningPairs(configs);
  const better = pairs.filter(p => p.errorReduction > 1e-9).length;
  $('#cost-caption').textContent = `Each point covers the same ${data.images.length} images. Incomplete results and unknown costs are excluded. ${state.scale === 'log' ? 'Log spacing compares cost ratios.' : 'Linear spacing compares dollar differences.'}`;
  $('#cost-reading').textContent = pairs.length
    ? `${better} of ${pairs.length} models have lower mean error at High than Low. Moving down is an improvement; moving up and right means paying more for higher error.`
    : 'Select low and high for a model with complete, matching configurations to compare the extra cost with the change in counting error.';
  const accepted = acceptance(configs, state.cutoff / 100);
  const summaries = configs.map(confidenceSummary).filter(Boolean);
  const confident = [...summaries].sort((a, b) => b.confidence - a.confidence)[0];
  $('#confidence-reading').textContent = confident
    ? `Highest mean confidence: ${confident.name} (${titleEffort(confident.effort)}), ${pct(confident.confidence * 100, 1)}, with ${pct(confident.deviation)} mean error. Higher confidence does not guarantee lower error.`
    : 'A summary point needs a valid count and confidence for every image. No selected configuration has that full coverage.';
  $('#cutoff-reading').textContent = accepted.accepted
    ? `Keep ${accepted.accepted}/${accepted.denominator} possible answers (${pct(accepted.coverage, 1)} coverage). Mean deviation: ${pct(accepted.deviation)}, compared with ${pct(accepted.baseline)} across all confidence-bearing answers in this selection.`
    : configs.some(c => c.isDL) && !accepted.denominator ? 'DL models do not report P(exact count); confidence-based coverage is unavailable.' : configs.length ? `Keep 0/${accepted.denominator} possible answers at this cutoff. Mean error is undefined when no answers are accepted.` : 'Select a reasoning level to explore confidence-based coverage.';
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
    ['Which setting gives the closest counts?', best ? `${best.name} (${titleEffort(best.effort)}) has the lowest mean deviation among complete selected configurations: ${pct(best.deviation)} over ${best.n} images. A small deviation means close counts; it is not an exact-match score.` : 'No selected configuration has complete scoring coverage. Partial means are shown in the table but are not ranked against complete runs.'],
    ['Which setting costs the least for the same images?', cheap ? `${cheap.name} (${titleEffort(cheap.effort)}): ${usd(cheap.totalCost)} for the full image set, with ${pct(cheap.deviation)} mean deviation. ${cheap.isDL ? 'This is an inference-time compute estimate from your hourly rate, excluding startup and idle time.' : 'This is the saved API charge, not a current price estimate.'}` : 'A fair total-cost ranking requires complete answers for the full image set and known costs. None of the selected configurations meets both conditions.'],
    ['Does high reasoning actually improve counting?', pairs.length ? (pairs.length > 1
      ? `${pairs.filter(p => p.errorReduction > 1e-9).length} of ${pairs.length} models improve at High compared with Low. Select one model to see its change in error and cost.`
      : pairs.map(p => `${p.name}: High ${p.errorReduction > 0 ? 'reduces' : p.errorReduction < 0 ? 'increases' : 'does not change'} mean error ${p.errorReduction ? `by ${Math.abs(p.errorReduction).toFixed(2)} percentage points` : ''}; cost changes from ${usd(p.low.totalCost)} to ${usd(p.high.totalCost)}.`).join(' ')) + ' These are observations from this pilot.' : 'Select low and high levels with complete results and matching settings to compare reasoning effort.'],
    ['Do the most confident answers have smaller errors?', accepted.accepted ? `At your ${state.cutoff}% cutoff, accepted answers have ${pct(accepted.deviation)} mean deviation; all valid, confidence-bearing answers have ${pct(accepted.baseline)}. ${accepted.deviation < accepted.baseline ? 'Selection improves the observed average in this view.' : accepted.deviation > accepted.baseline ? 'Selection worsens the observed average in this view.' : 'The observed average is unchanged.'} Inspect individual curves before using a pooled result.` : 'No answers meet your selected cutoff, so their mean error cannot be calculated. Lower the cutoff to compare accepted and unfiltered answers.'],
    ['How much coverage do I give up?', accepted.denominator ? `Your ${state.cutoff}% cutoff keeps ${accepted.accepted} of ${accepted.denominator} possible LLM answers (${pct(accepted.coverage, 1)}). The denominator includes missing or failed LLM answers. The same images repeat across LLM configurations; DL models are excluded.` : 'No LLM confidence data is selected. DL models do not report P(exact count), so confidence-based coverage is unavailable.'],
    ['Why is a close answer treated as useful?', 'Deviation measures distance from the supplied count. For example, a prediction of 98 against a supplied count of 100 has 2% deviation. An exact-match metric would give it no credit, but these charts represent it as a close count. Each image receives equal weight.'],
    ['What does a confidence point represent?', 'One model at one reasoning level, averaged across all images. The horizontal position is its mean stated confidence; the vertical position is its mean absolute percentage count deviation. Both means use the same full image set. This does not establish formal probability calibration: confidence means P(exact count), while numerical error measures closeness.'],
    ['Why might a point or a model be missing?', !configs.length ? 'No reasoning configurations are selected. Enable at least one level to see its results.' : partial.length ? partial.map(c => `${c.name}, ${c.effort}: ${c.successful}/${c.n} valid answers; ${c.failed} failed, ${c.skipped} skipped, ${c.missing} missing; ${c.unknownCosts} unknown charges.`).join(' ') + ' Partial means are not compared against complete runs. Confidence points also require valid confidence for every image.' : `All ${configs.length} selected configurations have complete answers and known charges. A confidence point also requires valid confidence for every image. Missing runs and smoke tests are excluded; partial runs remain in the detailed table.`],
    ['Did only reasoning effort change?', configs.every(c => c.isDL) && configs.length ? 'DL entries are one Colab GPU configuration per model, not a reasoning-level sweep. The Colab script reuses the pinned counting configurations; its compact export does not independently document every configuration field.' : `The page checks recorded prompts, sampling, token caps, provider pins, tools, fallbacks and timeouts within each LLM. Lines and reasoning comparisons are withheld if those settings differ across efforts. The selected LLM token caps are ${[...new Set(configs.filter(c => !c.isDL).map(c => cap(c.data.max_tokens)))].join(' / ') || 'unavailable'}. Cross-model differences cannot be attributed to effort alone.`],
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
    const cost = node('td', c.totalCost !== null ? usd(c.totalCost) : c.isDL ? 'Unknown (no hourly rate)' : `${usd(c.knownCost)} known`);
    if (c.isDL) {
      cost.append(node('small', `${c.totalInferenceSeconds.toFixed(6)}s inference`));
      if (c.totalCost !== null) cost.append(node('small', `${usd(c.costPerImage)}/image · ${usd(c.costPer1000Images)}/1,000`));
    } else if (c.totalCost === null) cost.append(node('small', `${c.unknownCosts} unknown charges · incomplete comparison`)); tr.append(cost);
    const confidence = node('td', c.isDL ? 'Not reported' : pct(c.confidence === null ? null : c.confidence * 100, 1));
    const confidenceCount = c.rows.filter(r => r.confidence !== null).length;
    if (!c.isDL && confidenceCount < c.n) confidence.append(node('small', `${confidenceCount}/${c.n} confidence values`));
    tr.append(confidence, node('td', c.isDL ? '—' : cap(c.data.max_tokens)));
    const source = node('td'); source.append(node('a', 'JSON ↗', { href: c.path, 'aria-label': `Raw JSON for ${c.name} at ${c.effort}` })); tr.append(source); body.append(tr);
  }
}
function renderPlots() {
  if (!data || $('#page-content').hidden) return;
  const configs = selected(); plot('#cost-chart', configs, 'cost'); plot('#confidence-chart', configs, 'confidence');
  if ($('#coverage').open) plot('#coverage-chart', configs, 'coverage');
}
function renderQuality(configs) {
  $('#quality').hidden = !data.configs.some(c => c.isDL);
  const rows = configs.filter(c => c.complete).sort((a, b) => a.deviation - b.deviation);
  const root = $('#quality-chart'); root.replaceChildren();
  const max = Math.max(1, ...rows.map(c => c.deviation));
  for (const c of rows) {
    const row = node('div', null, { class: 'quality-row', 'data-model': c.model, 'data-deviation': c.deviation });
    const track = node('div', null, { class: 'quality-track', 'aria-hidden': 'true' });
    const bar = node('span'); bar.style.width = `${c.deviation / max * 100}%`; bar.style.background = colorOf(c.model); track.append(bar);
    row.append(node('span', `${c.name} · ${titleEffort(c.effort)}`), track, node('strong', pct(c.deviation)));
    root.append(row);
  }
}
function render() {
  $('#cost-detail').textContent = 'Hover, tap or keyboard-focus a point for its cost and counting deviation.';
  $('#confidence-detail').textContent = 'Select a model-level point to see its mean confidence and mean error.';
  $('#coverage-detail').textContent = 'Select a curve point to see its confidence cutoff, accepted images and mean error.';
  const configs = selected();
  const onlyDL = configs.length && configs.every(c => c.isDL);
  $('#confidence').hidden = !!onlyDL; $('#coverage').hidden = !!onlyDL;
  renderLegend(); renderHeadlines(configs); renderReadings(configs); renderQuestions(configs); renderRecords(configs); renderPlots(); renderQuality(configs);
  $('#dl-symbol').hidden = !data.configs.some(c => c.isDL);
  $('#selection-note').textContent = `${state.model === 'all' ? 'All models' : nameOf(state.model)} · ${onlyDL ? 'Colab GPU' : state.efforts.map(titleEffort).join(' / ') || 'no LLM reasoning levels selected'} · ${configs.length} configurations. Reasoning controls apply to LLMs only.`;
  const warnings = [...notices, ...data.warnings];
  const limit = data.warnings.filter(w => w.startsWith('Token caps differ')).join(' ');
  $('#comparison-limit').textContent = limit; $('#comparison-limit').hidden = !limit;
  for (const c of configs.filter(c => !c.costEligible)) warnings.push(`${c.name}, ${c.effort}: ${c.successful}/${c.n} valid answers and ${c.unknownCosts} unknown charges. Excluded from the full-image cost plot.`);
  for (const c of configs.filter(c => !c.isDL && !confidenceSummary(c))) warnings.push(`${c.name}, ${c.effort}: missing count or confidence for the full image set. Excluded from the mean-confidence plot.`);
  const list = $('#data-notices ul'); list.replaceChildren(...warnings.map(w => node('li', w)));
  $('#data-notices').hidden = !warnings.length;
}

readState();
for (const anchor of document.querySelectorAll('a[href^="#"]')) anchor.addEventListener('click', event => {
  const section = anchor.getAttribute('href').slice(1);
  if (document.getElementById(section)) { event.preventDefault(); writeState(section, true); revealSection(section); }
});
$('#coverage').addEventListener('toggle', renderPlots);
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
