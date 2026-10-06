import { PILOT_RUN, DL_SOURCES, prepareData, statistics, calibrationBins, confidenceCutoff } from './insights-data.mjs';

const $ = selector => document.querySelector(selector);
const state = { models: [], images: [], selected: 'all', scope: 'all' };
const pct = value => `${(value * 100).toFixed(1)}%`;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function svgNode(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function bullets(selector, texts) { $(selector).replaceChildren(...texts.map(text => element('li', text))); }
async function json(path) {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
function family(model) { return model.exemplar ? 'Specialist + visual examples' : model.kind === 'llm' ? 'Vision LLM' : 'Text-only specialist'; }

function renderModels() {
  const groups = [
    ['Anthropic vision LLMs', 'anthropic/'], ['DeepSeek vision LLMs', 'deepseek/'],
    ['Google vision LLMs', 'google/'], ['OpenAI vision LLMs', 'openai/']
  ];
  const items = groups.map(([label, prefix]) => `${label}: ${state.models.filter(model => model.name.startsWith(prefix)).map(model => model.label).join(', ')}. Vision-language models; exact internal architecture not recorded.`);
  for (const model of state.models.filter(model => model.kind === 'dl')) {
    items.push(`${model.label}: ${model.config.architecture}. ${model.exemplar ? 'Visual exemplar input; no text.' : 'Text-specified target.'}`);
  }
  bullets('#model-list', items);
}

function renderConclusions() {
  const all = state.models.map(model => statistics(model));
  const bestLLM = all.filter(model => model.kind === 'llm').sort((a, b) => a.deviation - b.deviation)[0];
  const bestDL = all.filter(model => model.kind === 'dl' && !model.exemplar).sort((a, b) => a.deviation - b.deviation)[0];
  const confidence = all.filter(model => model.kind === 'llm').sort((a, b) => a.brier - b.brier);
  const accepted = confidenceCutoff(state.models);
  bullets('#conclusions', [
    `Do vision LLMs or specialists perform better? On all six images, ${bestDL.label} has ${bestDL.deviation.toFixed(1)}% mean count deviation; the best LLM, ${bestLLM.label}, has ${bestLLM.deviation.toFixed(1)}%. This is a small, mixed-split result, not evidence that every specialist beats every LLM.`,
    `Does LLM confidence mean correctness? Of ${accepted.n} LLM answers reporting at least 90% confidence, ${accepted.wrong} are wrong. Stated confidence does not behave like a reliable guarantee of an exact count in this pilot.`,
    `Which LLM confidence looks most useful here? ${confidence[0].label} has the lowest observed Brier score (${confidence[0].brier.toFixed(3)}). The charts below show its probabilities and outcomes, but six answers are too few to certify calibration.`,
    'Close counting and exact-count confidence measure different things. A near-correct estimate can correctly receive low confidence of an exact match; DL detection scores do not provide that probability.'
  ]);
}

function renderCalibration() {
  const root = $('#calibration-chart');
  const width = Math.max(260, root.clientWidth), height = 335;
  const x = value => 54 + value * (width - 80);
  const y = value => 282 - value * 243;
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Stated confidence versus exact-match accuracy for evaluated LLMs' });
  svg.append(svgNode('title', {}, 'What stated confidence actually meant'));
  for (const value of [0, .25, .5, .75, 1]) {
    svg.append(svgNode('line', { x1: x(0), x2: x(1), y1: y(value), y2: y(value), class: 'chart-grid' }));
    svg.append(svgNode('text', { x: 45, y: y(value) + 4, 'text-anchor': 'end', class: 'axis-tick' }, `${value * 100}%`));
    svg.append(svgNode('text', { x: x(value), y: 304, 'text-anchor': 'middle', class: 'axis-tick' }, `${value * 100}%`));
  }
  svg.append(svgNode('text', { x: 54, y: 18, class: 'axis-label' }, 'Exact-match accuracy'));
  svg.append(svgNode('text', { x: width / 2, y: 329, 'text-anchor': 'middle', class: 'axis-label' }, 'Mean stated confidence'));
  svg.append(svgNode('line', { x1: x(0), x2: x(1), y1: y(0), y2: y(1), class: 'chart-diagonal' }));
  const models = state.models.filter(model => model.kind === 'llm' && (state.selected === 'all' || model.name === state.selected));
  for (const model of models) {
    for (const bin of calibrationBins(model.rows)) {
      const band = `${Math.round(bin.low * 100)}–${Math.round(bin.high * 100)}%`;
      const description = `${model.label} · ${band} band: ${pct(bin.x)} mean confidence; ${bin.correct}/${bin.n} exact (${pct(bin.y)}); n=${bin.n}.`;
      const dot = svgNode('circle', { cx: x(bin.x), cy: y(bin.y), r: 3 + 2.2 * Math.sqrt(bin.n), class: 'calibration-point',
        tabindex: 0, role: 'button', 'aria-label': description, 'data-model': model.name, 'data-samples': bin.n, 'data-confidence': bin.x, 'data-accuracy': bin.y });
      dot.append(svgNode('title', {}, description));
      const show = () => { $('#calibration-detail').textContent = description; };
      for (const event of ['mouseenter', 'focus', 'click']) dot.addEventListener(event, show);
      dot.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); show(); } });
      svg.append(dot);
    }
  }
  root.replaceChildren(svg);
  if (state.selected !== 'all') {
    const model = statistics(models[0]);
    $('#calibration-detail').textContent = `${model.label}: ${pct(model.confidence)} mean confidence, ${pct(model.accuracy)} exact-match accuracy across six answers. Select a band for details.`;
  } else $('#calibration-detail').textContent = 'Hover, tap or keyboard-focus a dot for its model and sample count. Use the selector to separate overlapping points.';
  const accepted = confidenceCutoff(state.models);
  bullets('#calibration-reading', [
    `At a 90% confidence cutoff, only ${accepted.n - accepted.wrong} of ${accepted.n} accepted answers are exact. The observed wrong-count rate is ${pct(accepted.wrong / accepted.n)}.`,
    'A dot below the diagonal reports more certainty than its observed exact-match rate. A dot above it is underconfident in that band.',
    'Some bands contain only one answer. All nine LLMs saw the same six images; these are sparse observations, not independently validated confidence thresholds.'
  ]);
}

function renderComparison() {
  const models = state.models.map(model => statistics(model, state.scope)).sort((a, b) => a.deviation - b.deviation || a.label.localeCompare(b.label));
  const max = Math.max(100, Math.ceil(models.at(-1).deviation / 25) * 25);
  const root = $('#comparison-chart');
  const axis = element('div', undefined, 'rank-axis');
  for (const fraction of [0, .25, .5, .75, 1]) axis.append(element('span', `${max * fraction}%`));
  root.replaceChildren(axis);
  for (const model of models) {
    const type = model.exemplar ? 'exemplar' : model.kind;
    const row = element('div', undefined, `rank-row ${type}`); row.dataset.model = model.name; row.dataset.deviation = model.deviation;
    const label = element('div', model.label, 'model-label'); label.append(element('small', `${family(model)} · n=${model.n}`));
    const track = element('div', undefined, 'rank-track'); track.setAttribute('aria-hidden', 'true');
    const bar = element('span', undefined, 'rank-bar'); bar.style.setProperty('--bar-width', `${model.deviation / max * 100}%`); track.append(bar);
    const value = element('strong', `${model.deviation.toFixed(1)}%`, 'rank-value');
    row.append(label, track, value);
    row.title = model.rows.map(r => `${r.label}: predicted ${r.count}, supplied ${r.actual}, deviation ${r.deviation.toFixed(1)}%`).join('\n');
    root.append(row);
  }
  const bestLLM = models.find(model => model.kind === 'llm');
  const bestSpecialist = models.find(model => model.kind === 'dl' && !model.exemplar);
  const nontrainWinner = state.models.map(model => statistics(model, 'nontrain')).sort((a, b) => a.deviation - b.deviation)[0];
  $('#comparison-note').textContent = state.scope === 'all'
    ? 'All six images · mean absolute percentage deviation · 3 train, 2 validation, 1 test'
    : 'Bottle caps, books and stamps only · 2 validation, 1 test · three training images excluded';
  bullets('#comparison-reading', [
    `${bestSpecialist.label} is the closest text-only specialist in this selection (${bestSpecialist.deviation.toFixed(1)}%); ${bestLLM.label} is the closest LLM (${bestLLM.deviation.toFixed(1)}%).`,
    `The leading model changes with the image selection: ${nontrainWinner.label} leads on the three validation/test images. That is still a tiny selected subset; validation images may have influenced model selection.`,
    'YOLO-World-S retains zero boxes on all six target images at its recorded 0.25 cutoff, giving 100% deviation. Its positive control passed; this is a result of this saved inference configuration.',
    'FamNet uses three visual examples on five images and five on books. Its additional input and the mixed training split prevent a controlled claim about LLM versus specialist architecture.'
  ]);
}

function renderConfidence() {
  const models = state.models.filter(model => model.kind === 'llm').map(model => statistics(model)).sort((a, b) => a.brier - b.brier);
  const root = $('#confidence-chart');
  const heading = element('div', undefined, 'gap-axis'); heading.append(element('span', 'LLM'));
  const ticks = element('span', undefined, 'ticks');
  for (const n of [0, 25, 50, 75, 100]) ticks.append(element('span', `${n}%`));
  heading.append(ticks, element('span', 'Brier ↓')); root.replaceChildren(heading);
  for (const model of models) {
    const row = element('div', undefined, 'confidence-row'); row.dataset.model = model.name; row.dataset.brier = model.brier;
    const label = element('div', model.label, 'model-label');
    label.append(element('small', `${pct(model.confidence)} stated · ${pct(model.accuracy)} exact`));
    const glyph = element('div', undefined, 'confidence-glyph');
    row.append(label, glyph, element('strong', model.brier.toFixed(3), 'brier-value')); root.append(row);
    const width = Math.max(180, glyph.clientWidth), x = value => 10 + value * (width - 20);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} 44`, role: 'img', 'aria-label': `${model.label}: ${pct(model.confidence)} mean stated confidence versus ${pct(model.accuracy)} exact-match accuracy; Brier ${model.brier.toFixed(3)}` });
    for (const n of [0, .25, .5, .75, 1]) svg.append(svgNode('line', { x1: x(n), x2: x(n), y1: 5, y2: 39, class: 'chart-grid' }));
    svg.append(svgNode('line', { x1: x(model.accuracy), x2: x(model.confidence), y1: 22, y2: 22, class: 'gap-line' }));
    svg.append(svgNode('rect', { x: x(model.confidence) - 5, y: 17, width: 10, height: 10, class: 'stated-mark' }));
    svg.append(svgNode('circle', { cx: x(model.accuracy), cy: 22, r: 6, class: 'exact-mark' }));
    glyph.append(svg);
  }
  const largest = [...models].sort((a, b) => (b.confidence - b.accuracy) - (a.confidence - a.accuracy))[0];
  const below = models.filter(model => model.confidence < model.accuracy);
  bullets('#confidence-reading', [
    `${models[0].label} has the lowest observed Brier score (${models[0].brier.toFixed(3)}); its mean stated confidence is ${pct(models[0].confidence)} and exact-match accuracy is ${pct(models[0].accuracy)}.`,
    `${largest.label} has the largest positive average gap: ${pct(largest.confidence)} stated confidence versus ${pct(largest.accuracy)} exact accuracy.`,
    `${below.map(model => model.label).join(', ')} has mean confidence below observed exact accuracy. That does not make it the best counter or establish reliable calibration; averaging can hide different errors.`,
    'Brier scores compare probability predictions for an exact answer. They do not measure how close an incorrect numerical count was; use the deviation chart for that.'
  ]);
}

function renderCharts() { renderCalibration(); renderComparison(); renderConfidence(); }
async function load() {
  try {
    const [manifest, metadata, dataset] = await Promise.all([json('eval2/manifest.json'), json('eval2/metadata.json'), json('DL-MODELS/dataset-info.json')]);
    const llmPaths = manifest.files.filter(path => /^eval2\/[^/]+_group1\.json$/.test(path));
    const paths = [...llmPaths, ...DL_SOURCES];
    const sources = await Promise.all(paths.map(async path => ({ path, data: await json(path) })));
    Object.assign(state, prepareData(sources, metadata, dataset));
    renderModels(); renderConclusions();
    for (const model of state.models.filter(model => model.kind === 'llm').sort((a, b) => a.label.localeCompare(b.label))) {
      const option = element('option', model.label); option.value = model.name; $('#confidence-model').append(option);
    }
    const sourceList = $('#insights-sources');
    for (const model of state.models) {
      const item = element('li'); const link = element('a', `${model.label} · saved configuration and six predictions`); link.href = model.path; item.append(link); sourceList.append(item);
    }
    $('#insights-content').hidden = false;
    $('#insights-status').textContent = 'Saved runs verified complete: 54 LLM answers + 30 local-model predictions. Charts are recomputed from these JSON files.';
    renderCharts();
    $('#confidence-model').addEventListener('change', event => {
      state.selected = event.target.value; renderCalibration();
      const query = new URL(location.href); state.selected === 'all' ? query.searchParams.delete('llm') : query.searchParams.set('llm', state.selected); history.replaceState(null, '', query);
    });
    $('#comparison-scope').addEventListener('change', event => {
      state.scope = event.target.value; renderComparison();
      const query = new URL(location.href); state.scope === 'all' ? query.searchParams.delete('scope') : query.searchParams.set('scope', state.scope); history.replaceState(null, '', query);
    });
    const query = new URLSearchParams(location.search);
    if (state.models.some(model => model.kind === 'llm' && model.name === query.get('llm'))) {
      state.selected = query.get('llm'); $('#confidence-model').value = state.selected;
    }
    if (query.get('scope') === 'nontrain') { state.scope = 'nontrain'; $('#comparison-scope').value = state.scope; }
    renderCharts();
    window.addEventListener('resize', () => { clearTimeout(window.insightsResize); window.insightsResize = setTimeout(renderCharts, 100); });
    window.insightsState = state;
  } catch (error) {
    $('#insights-content').hidden = true;
    $('#insights-status').classList.add('error');
    $('#insights-status').textContent = `Comparison unavailable: ${error.message} No partial rankings or conclusions are shown. Restore the saved source files and reload.`;
  }
}
load();
