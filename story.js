'use strict';

// The narrative covers this saved main3.py pilot only. Page 2 discovers all runs.
const PILOT_RUN = '2026-10-03T11:03:45.271545+00:00';
const storyState = { models: [], images: [], answers: [], sources: [], measure: 'deviation', selectedCost: '' };
const storyQuery = selector => document.querySelector(selector);
const storyMean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const storyPercent = value => `${(value * 100).toFixed(0)}%`;
const storyName = model => model.name.split('/').at(-1);
const storyMoney = value => `$${value.toFixed(4)}`;
function storyText(selector, value) { storyQuery(selector).textContent = value; }
function storyElement(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
async function storyJSON(path) {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function prepareStory(sources, metadata) {
  if (!Array.isArray(metadata) || metadata.length !== 6) throw new Error('The story requires the six-image Group 1 ground truth.');
  const images = metadata.map(r => {
    if (String(r.group).replace(/^group/, '') !== '1' || !/^\d+\.jpg$/.test(r.image)
        || !Number.isInteger(r['actual-count']) || r['actual-count'] <= 0 || typeof r.label !== 'string') {
      throw new Error('Invalid pilot ground-truth record.');
    }
    return { image: r.image, label: r.label, actual: r['actual-count'] };
  });
  if (new Set(images.map(i => i.image)).size !== 6) throw new Error('Duplicate pilot ground-truth image.');
  const selected = sources.filter(s => s.data.run_id === PILOT_RUN);
  if (selected.length !== 9 || new Set(selected.map(s => s.data.model)).size !== 9) {
    throw new Error('The nine original pilot files are not all available.');
  }
  const models = selected.map(({ path, data }) => {
    if (typeof data.model !== 'string' || !Array.isArray(data.results)) throw new Error(`Invalid pilot results: ${path}`);
    if (data.max_tokens !== 4096 || data.reasoning?.effort !== 'low' || data.reasoning?.enabled !== true
        || data.allow_fallbacks !== false || data.tools?.length !== 0 || data.tool_choice !== 'none'
        || data.model_temp !== (data.model.startsWith('openai/') ? null : 0)
        || data.confidence_scale !== '0-1') throw new Error(`Pilot settings changed: ${path}`);
    // Latest row wins if a file contains duplicate image records.
    const latest = new Map();
    for (const row of data.results) {
      if (String(row.group).replace(/^group/, '') !== '1') continue;
      const previous = latest.get(row.image);
      const stamp = Date.parse(row.finished_at_utc ?? row.started_at_utc) || 0;
      if (!previous || stamp >= previous.stamp) latest.set(row.image, { row, stamp });
    }
    const model = { name: data.model, source: path };
    model.answers = images.map(image => {
      const row = latest.get(image.image)?.row;
      if (!row || row.status !== 'success' || !Number.isInteger(row.model_count) || row.model_count < 0
          || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1
          || !Number.isFinite(row.cost_usd) || row.cost_usd < 0) {
        throw new Error(`Incomplete count, confidence, or cost in ${path}: ${image.image}`);
      }
      return { model, image, count: row.model_count, confidence: row.confidence, cost: row.cost_usd,
        exact: row.model_count === image.actual, deviation: Math.abs(row.model_count - image.actual) / image.actual * 100 };
    });
    model.deviation = storyMean(model.answers.map(a => a.deviation));
    model.exact = model.answers.filter(a => a.exact).length;
    model.cost = model.answers.reduce((sum, a) => sum + a.cost, 0);
    return model;
  }).sort((a, b) => a.deviation - b.deviation || a.name.localeCompare(b.name));
  return { images, models, answers: models.flatMap(m => m.answers), sources: selected.map(s => s.path) };
}

function renderStoryCopy() {
  const { models, images, answers } = storyState;
  const brick = answers.find(a => a.image.label === 'bricks' && a.model.name === 'deepseek/deepseek-v4-flash-vision-exp');
  const stamp = images.find(i => i.label === 'stamps');
  if (!brick || !stamp) throw new Error('The pilot examples are missing.');
  const stamped = answers.filter(a => a.image === stamp);
  const stampExact = stamped.filter(a => a.exact).length;
  const exact = answers.filter(a => a.exact).length;
  const winner = models[0];
  storyText('#hero-actual', brick.image.actual);
  storyText('#hero-predicted', brick.count);
  storyText('#hero-confidence', storyPercent(brick.confidence));
  storyText('#hero-source', `${storyName(brick.model)} · ${brick.model.name.split('/')[0]} · saved pilot answer`);
  storyText('#stamp-finding', `${stampExact} of the ${models.length} models count all ${stamp.actual} stamps correctly. In this image, exact counting looks within reach.`);
  storyText('#stamp-caption', `${stamp.actual} stamps in the metadata · ${stampExact} exact answers out of ${models.length}.`);
  storyText('#image-chart-title', `${stampExact} of the ${exact} exact answers come from the stamp image.`);
  storyText('#exact-revelation', `Across the whole test, only ${exact} of ${answers.length} answers are exactly right.`);
  storyText('#winner-finding', `${storyName(winner)} comes closest overall. Its average count deviation is ${winner.deviation.toFixed(1)}% across the six images. Yet it gets just ${winner.exact} count${winner.exact === 1 ? '' : 's'} exactly right.`);
  storyText('#brick-finding', `Return to the wall. ${storyName(brick.model)} reports ${brick.count} bricks at ${storyPercent(brick.confidence)} confidence. The metadata count is ${brick.image.actual}. That is ${Math.abs(brick.count - brick.image.actual)} bricks ${brick.count > brick.image.actual ? 'too many' : 'too few'}—a ${brick.deviation.toFixed(0)}% count deviation.`);
  const confident = answers.filter(a => a.confidence >= .9);
  storyText('#confidence-title', `At 90% confidence or above, ${confident.filter(a => !a.exact).length} of ${confident.length} answers are wrong.`);
  const luna = models.find(m => m.name === 'openai/gpt-5.6-luna');
  const sol = models.find(m => m.name === 'openai/gpt-5.6-sol');
  storyText('#cost-finding', `${storyName(luna)} costs ${storyMoney(luna.cost)} for all six images, about one-eleventh the ${storyMoney(sol.cost)} spent on ${storyName(sol)}. It also records lower average count deviation: ${luna.deviation.toFixed(1)}%, compared with ${sol.deviation.toFixed(1)}%. These charges buy model behavior; they do not buy a guaranteed count.`);
  storyText('#cost-detail', 'Select or focus a model point to inspect its recorded cost and count deviation.');
  storyText('#sample-summary', `Saved run: 3 October 2026. ${models.length} models × ${images.length} images = ${answers.length} successful answers. All counts, confidence values, and costs needed for this story are present. The story uses this one original run; page 2 can include later runs and additional files.`);
  const links = storyQuery('#source-links');
  links.append(document.createTextNode('Ground truth: '));
  const truthLink = storyElement('a', 'metadata.json'); truthLink.href = 'eval2/metadata.json'; links.append(truthLink);
  links.append(storyElement('br'), document.createTextNode('Saved model results: '));
  for (const model of models) {
    const link = storyElement('a', storyName(model)); link.href = model.source; links.append(link);
  }
  const select = storyQuery('#cost-model');
  select.replaceChildren(storyElement('option', 'Choose a model'));
  select.firstChild.value = '';
  for (const model of models) { const option = storyElement('option', model.name); option.value = model.name; select.append(option); }
}

function renderImageStory() {
  const { images, answers, models } = storyState;
  const root = storyQuery('#image-chart');
  const sorted = [...images].sort((a, b) => answers.filter(x => x.image === b && x.exact).length - answers.filter(x => x.image === a && x.exact).length);
  for (const image of sorted) {
    const matching = answers.filter(a => a.image === image);
    const n = matching.filter(a => a.exact).length;
    const row = storyElement('div', undefined, 'image-result');
    const link = storyElement('a', image.label); link.href = `data/group1/${image.image}`; link.target = '_blank'; link.rel = 'noopener';
    const marks = storyElement('div', undefined, 'image-marks'); marks.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < models.length; i++) marks.append(storyElement('span', undefined, `image-mark${i < n ? ' exact' : ''}`));
    const value = storyElement('strong', `${n}/${models.length}`); value.setAttribute('aria-label', `${n} of ${models.length} models exactly correct`);
    row.append(link, marks, value); root.append(row);
  }
}

function renderRanking() {
  const deviation = storyState.measure === 'deviation';
  storyText('#ranking-title', deviation ? `${storyName(storyState.models[0])} has the smallest average count deviation.` : 'A low-deviation leader can still miss the exact count.');
  storyText('#ranking-subtitle', deviation ? 'Mean absolute percentage deviation · lower is better' : 'Exactly correct answers out of six · higher is better');
  storyText('#ranking-note', deviation ? 'Each image has equal weight. A deviation of 0% means every count matches exactly. Bar scale runs from 0% to the largest observed mean deviation.' : 'Exact matching gives no credit for being one object away. Bar scale runs from zero to six answers.');
  const models = [...storyState.models].sort((a, b) => deviation ? a.deviation - b.deviation : b.exact - a.exact || a.deviation - b.deviation);
  const max = deviation ? Math.max(...models.map(m => m.deviation)) : storyState.images.length;
  storyQuery('#ranking-chart').replaceChildren(...models.map(model => {
    const row = storyElement('div', undefined, `ranking-row${model === storyState.models[0] ? ' highlight' : ''}`);
    row.dataset.model = model.name;
    const label = storyElement('div', storyName(model), 'ranking-label'); label.append(storyElement('small', model.name.split('/')[0]));
    const track = storyElement('div', undefined, 'ranking-track'); track.setAttribute('aria-hidden', 'true');
    const bar = storyElement('div', undefined, 'ranking-bar'); bar.style.setProperty('--bar-width', `${(deviation ? model.deviation : model.exact) / max * 100}%`); track.append(bar);
    row.append(label, track, storyElement('div', deviation ? `${model.deviation.toFixed(1)}%` : `${model.exact} / ${storyState.images.length}`, 'ranking-value'));
    return row;
  }));
}

function answerDescription(answer) {
  return `${storyName(answer.model)} · ${answer.image.label}: predicted ${answer.count}, ground truth ${answer.image.actual}; ${storyPercent(answer.confidence)} confidence; ${answer.exact ? 'exactly correct' : 'wrong count'}.`;
}
function renderConfidence() {
  const root = storyQuery('#confidence-chart');
  for (const image of storyState.images) {
    const group = storyElement('div', undefined, 'answer-group'); group.append(storyElement('h4', image.label));
    const marks = storyElement('div', undefined, 'answer-marks');
    for (const answer of storyState.answers.filter(a => a.image === image)) {
      const button = storyElement('button', answer.exact ? '✓' : '×', `answer-dot ${answer.exact ? 'exact' : 'wrong'}`);
      button.type = 'button'; button.dataset.confidence = answer.confidence; button.dataset.exact = String(answer.exact);
      button.tabIndex = marks.children.length ? -1 : 0;
      button.dataset.description = answerDescription(answer);
      button.setAttribute('aria-label', button.dataset.description); button.setAttribute('aria-pressed', 'false');
      const selectAnswer = () => {
        root.querySelectorAll('[aria-pressed=true]').forEach(dot => dot.setAttribute('aria-pressed', 'false'));
        for (const dot of marks.children) dot.tabIndex = dot === button ? 0 : -1;
        button.setAttribute('aria-pressed', 'true'); storyText('#answer-detail', answerDescription(answer));
      };
      button.addEventListener('click', selectAnswer);
      button.addEventListener('focus', selectAnswer);
      button.addEventListener('keydown', event => {
        const dots = [...marks.children], index = dots.indexOf(button);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[event.key];
        if (step !== undefined) { event.preventDefault(); dots[(index + step + dots.length) % dots.length].focus(); }
      });
      marks.append(button);
    }
    group.append(marks); root.append(group);
  }
  updateConfidence();
}
function updateConfidence(event) {
  const threshold = Number(storyQuery('#confidence-cutoff').value) / 100;
  storyText('#cutoff-value', storyPercent(threshold));
  const accepted = storyState.answers.filter(a => a.confidence >= threshold);
  const exact = accepted.filter(a => a.exact).length;
  storyText('#cutoff-summary', accepted.length ? `${accepted.length} of ${storyState.answers.length} answers accepted. ${exact} exact; ${accepted.length - exact} wrong. Wrong-count rate: ${storyPercent(1 - exact / accepted.length)}.` : `No answers meet this cutoff. No wrong-count rate can be calculated.`);
  for (const dot of storyQuery('#confidence-chart').querySelectorAll('button')) {
    const excluded = Number(dot.dataset.confidence) < threshold;
    dot.classList.toggle('excluded', excluded);
    dot.setAttribute('aria-label', `${dot.dataset.description} ${excluded ? 'Below cutoff.' : 'Accepted at this cutoff.'}`);
  }
  saveStoryView(event?.type === 'input' ? 'confidence' : undefined);
}

function saveStoryView(section) {
  const url = new URL(location.href);
  const anchor = section ?? url.hash.slice(1).split('?')[0];
  const params = new URLSearchParams();
  if (storyState.measure !== 'deviation') params.set('measure', storyState.measure);
  const cutoff = storyQuery('#confidence-cutoff').value;
  if (cutoff !== '90') params.set('cutoff', cutoff);
  url.hash = `${anchor || (params.size ? 'confidence' : '')}${params.size ? `?${params}` : ''}`;
  history.replaceState(null, '', url);
}
function restoreStoryView() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  storyState.measure = params.get('measure') === 'exact' ? 'exact' : 'deviation';
  const cutoff = params.get('cutoff');
  storyQuery('#confidence-cutoff').value = cutoff !== null && /^\d{1,3}$/.test(cutoff) && Number(cutoff) <= 100 ? cutoff : 90;
  document.querySelectorAll('[data-measure]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.measure === storyState.measure)));
}

function showCostModel(model) {
  if (!model) return;
  storyState.selectedCost = model.name;
  storyQuery('#cost-model').value = model.name;
  storyText('#cost-detail', `${model.name}: ${storyMoney(model.cost)} for six requests; ${model.deviation.toFixed(1)}% average count deviation; ${model.exact} of six answers exact.`);
  for (const point of document.querySelectorAll('.cost-point')) point.setAttribute('aria-pressed', String(point.dataset.model === model.name));
}

function renderCost() {
  const root = storyQuery('#cost-chart');
  const width = Math.round(root.getBoundingClientRect().width);
  if (width < 1) return;
  const compact = width < 550;
  const height = compact ? 410 : 390;
  const margin = { left: 62, right: compact ? 18 : 35, top: 28, bottom: 60 };
  const models = storyState.models;
  const costs = d3.extent(models, m => m.cost);
  const x = d3.scaleLog().domain([costs[0] / 1.35, costs[1] * 1.35]).range([margin.left, width - margin.right]);
  const y = d3.scaleLinear().domain([0, d3.max(models, m => m.deviation) * 1.16]).nice().range([height - margin.bottom, margin.top]);
  root.replaceChildren();
  const svg = d3.select(root).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'group').attr('aria-labelledby', 'cost-plot-title cost-plot-desc');
  svg.append('title').attr('id', 'cost-plot-title').text('Total recorded API cost versus average count deviation for nine models');
  svg.append('desc').attr('id', 'cost-plot-desc').text('Cost rises to the right on a logarithmic scale. Count deviation rises upward. Lower deviation is better. Focus or select each model point for the full values.');
  svg.append('g').attr('class', 'grid').attr('transform', `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(width - margin.left - margin.right)).tickFormat(() => ''));
  svg.append('g').attr('transform', `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(v => `${v}%`).tickSize(0).tickPadding(9));
  // Curate a few log ticks from the data extent, without moving the domain.
  const candidates = [.001, .002, .005, .01, .02, .05, .1, .2, .5, 1];
  let ticks = candidates.filter(v => v >= x.domain()[0] && v <= x.domain()[1]);
  if (compact && ticks.length > 4) ticks = ticks.filter((_, i) => i % 2 === 0);
  svg.append('g').attr('transform', `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).tickValues(ticks).tickFormat(v => `$${v}`).tickSize(0).tickPadding(12));
  svg.append('text').attr('class', 'axis-title').attr('data-axis', 'x').attr('x', (margin.left + width - margin.right) / 2).attr('y', height - 8).attr('text-anchor', 'middle').text('Total cost for six requests (USD, log scale)');
  svg.append('text').attr('class', 'axis-title').attr('data-axis', 'y').attr('x', margin.left).attr('y', 15).text('Average count deviation (%)');
  const short = model => storyName(model).replace('deepseek-', 'DS ').replace('gemini-', 'Gemini ').replace('gpt-5.6-', '').replace('claude-', '').replace('-flash-vision-exp', ' vision').replace('-flash-lite', ' lite').replace('-flash', ' flash').replace('haiku-4.5', 'Haiku').replace('sonnet-5.5', 'Sonnet');
  const labels = [];
  models.forEach((model, index) => {
    const px = x(model.cost), py = y(model.deviation);
    const show = () => showCostModel(model);
    const circle = svg.append('circle').attr('class', `cost-point${index === 0 ? ' highlight' : ''}`).attr('data-model', model.name).attr('cx', px).attr('cy', py).attr('r', index === 0 ? 7 : 5).attr('tabindex', 0).attr('role', 'button').attr('aria-pressed', String(storyState.selectedCost === model.name)).attr('aria-label', `${model.name}: ${storyMoney(model.cost)}, ${model.deviation.toFixed(1)}% count deviation`)
      .on('click', show).on('focus', show).on('mouseenter', show).on('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
    circle.append('title').text(`${model.name} · ${storyMoney(model.cost)} · ${model.deviation.toFixed(1)}% deviation`);
    const text = svg.append('text').attr('class', 'point-label').text(short(model));
    const tw = text.node().getBBox().width;
    // Try positions around each mark and reject overlap with previous labels or marks.
    const options = [[9, -10], [9, 18], [-tw - 9, -10], [-tw - 9, 18], [9, -25], [9, 33], [-tw - 9, -25], [-tw - 9, 33]];
    const choice = options.find(([dx, dy]) => {
      const box = { x: px + dx, y: py + dy - 11, w: tw, h: 14 };
      return box.x >= margin.left + 3 && box.x + tw <= width - margin.right && box.y >= margin.top
        && box.y + box.h < height - margin.bottom - 5
        && !labels.some(b => box.x < b.x + b.w + 4 && box.x + box.w + 4 > b.x && box.y < b.y + b.h + 4 && box.y + box.h + 4 > b.y)
        && !models.some(m => x(m.cost) > box.x - 7 && x(m.cost) < box.x + box.w + 7 && y(m.deviation) > box.y - 7 && y(m.deviation) < box.y + box.h + 7);
    });
    if (choice) { const [dx, dy] = choice; text.attr('x', px + dx).attr('y', py + dy); labels.push({ x: px + dx, y: py + dy - 11, w: tw, h: 14 }); }
    else text.remove(); // Full names and values remain available on the focusable marks.
  });
}

async function loadStory() {
  try {
    const [manifest, metadata] = await Promise.all([storyJSON('eval2/manifest.json'), storyJSON('eval2/metadata.json')]);
    if (!Array.isArray(manifest.files)) throw new Error('Invalid eval2 manifest.');
    const paths = [...new Set(manifest.files.filter(path => typeof path === 'string' && /^eval2\/[\w.-]+\.json$/.test(path) && !['eval2/metadata.json', 'eval2/manifest.json'].includes(path)))];
    const sources = await Promise.all(paths.map(async path => ({ path, data: await storyJSON(path) })));
    Object.assign(storyState, prepareStory(sources, metadata));
    storyQuery('#source-links').replaceChildren(); storyQuery('#image-chart').replaceChildren(); storyQuery('#confidence-chart').replaceChildren();
    restoreStoryView(); renderStoryCopy(); renderImageStory(); renderRanking(); renderConfidence();
    storyQuery('#story-content').hidden = false;
    renderCost();
    storyQuery('#story-status').hidden = true;
    let lastWidth = Math.round(storyQuery('#cost-chart').getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width);
      if (width !== lastWidth) { lastWidth = width; renderCost(); }
    }); observer.observe(storyQuery('#cost-chart'));
    storyQuery('#confidence-cutoff').addEventListener('input', updateConfidence);
    storyQuery('#cost-model').addEventListener('change', event => showCostModel(storyState.models.find(m => m.name === event.target.value)));
    for (const button of document.querySelectorAll('[data-measure]')) button.addEventListener('click', () => {
      storyState.measure = button.dataset.measure;
      document.querySelectorAll('[data-measure]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      renderRanking();
      saveStoryView('close');
    });
    window.addEventListener('hashchange', () => { restoreStoryView(); renderRanking(); updateConfidence(); });
    const anchor = location.hash.slice(1).split('?')[0];
    if (anchor) document.getElementById(anchor)?.scrollIntoView();
  } catch (error) {
    storyQuery('#story-content').hidden = true;
    const status = storyQuery('#story-status'); status.hidden = false; status.classList.add('error');
    status.replaceChildren(document.createTextNode(`The original pilot could not be loaded: ${error.message} Serve this folder over HTTP and include eval2/manifest.json and its result files. `));
    const link = storyElement('a', 'Open the data explorer on page 2.'); link.href = 'compare.html'; status.append(link);
    storyText('#hero-source', 'The saved pilot answer is unavailable.');
  }
}
loadStory();
