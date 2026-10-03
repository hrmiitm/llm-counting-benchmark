'use strict';

// Definitions only: app.js calls these after loading and joining the JSON files.
function confidenceSamples(row) {
  return row.imageRecords.flatMap(image => {
    const p = prediction(row.model, image), probability = number(p?.confidence);
    if (image.actual === null || image.conflict || p?.status !== 'success'
      || count(p.model_count) === null || probability === null || probability < 0 || probability > 1) return [];
    return [{ probability, correct: Number(p.model_count === image.actual), image }];
  });
}
function calibrationPoints(samples) {
  // Five equal-width bands; confidence 1 belongs in the final band.
  return Array.from({ length: 5 }, (_, i) => {
    const bin = samples.filter(s => Math.min(4, Math.floor(s.probability * 5)) === i);
    return bin.length ? { x: mean(bin.map(s => s.probability)), y: mean(bin.map(s => s.correct)),
      n: bin.length, correct: bin.reduce((sum, s) => sum + s.correct, 0), low: i / 5, high: (i + 1) / 5 } : null;
  }).filter(Boolean);
}
function riskPoints(samples, totalImages) {
  if (!totalImages) return [];
  // Every point is an actual threshold. Equal-confidence predictions stay together.
  return [...new Set(samples.map(s => s.probability))].sort((a, b) => b - a).map(threshold => {
    const accepted = samples.filter(s => s.probability >= threshold);
    const errors = accepted.reduce((sum, s) => sum + 1 - s.correct, 0);
    return { x: accepted.length / totalImages, y: errors / accepted.length, n: accepted.length, errors, threshold };
  });
}
function settingCounts(rows, get) {
  const counts = new Map();
  for (const row of rows) { const label = String(get(row.model)); counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts].sort(([a], [b]) => compare(a, b)).map(([label, n]) => counts.size === 1 ? label : `${label} ×${n}`).join(' / ');
}
function renderOverview(rows) {
  const setup = $('#setup-notes'), observations = $('#model-observations');
  setup.replaceChildren(); observations.replaceChildren();
  if (!rows.length) {
    setup.append(node('li', 'No model configurations match the current filters.'));
    observations.append(node('li', 'Select models to see observations.')); return;
  }
  const images = new Map(rows.flatMap(row => row.imageRecords.map(image => [image.key, image])));
  setup.append(node('li', `${rows.length} configurations · ${images.size} images · count + confidence (0–1).`));
  setup.append(node('li', `Temp ${settingCounts(rows, m => m.temp ?? 'omitted')} · reasoning ${settingCounts(rows, m => m.effort)} · ${settingCounts(rows, m => m.maxTokens ?? 'unspecified')} token cap.`));
  const noTools = rows.filter(({ model: m }) => Array.isArray(m.settings.tools) && !m.settings.tools.length && m.settings.toolChoice === 'none').length;
  const pinned = rows.filter(({ model: m }) => m.provider !== 'unspecified' && m.settings.fallbacks === false).length;
  setup.append(node('li', `${noTools === rows.length ? 'Tools off' : `Tools off ${noTools}/${rows.length}`} · ${pinned === rows.length ? 'one provider/model, no fallback' : `providers pinned ${pinned}/${rows.length}`} · ground truth joined separately.`));
  const samples = rows.map(row => ({ row, samples: confidenceSamples(row) }));

  // Compare counting error only when every eligible visible image was scored.
  const eligible = [...images.values()].filter(i => !i.conflict && i.actual !== null && i.actual > 0);
  const complete = rows.filter(row => eligible.length && row.count === eligible.length
    && eligible.every(i => value('percent', row.model, i) !== null))
    .sort((a, b) => a.deviation - b.deviation || compare(a.model.key, b.model.key));
  if (complete.length) {
    const best = complete[0];
    const item = node('li', `Lowest mean deviation: ${configurationName(best.model, true)}, ${fmt(best.deviation)}% (${best.count} images).`);
    item.title = 'Compared only configurations with predictions for every visible image with positive ground truth.'; observations.append(item);
  } else observations.append(node('li', 'Mean-deviation ranking needs complete predictions and ground truth.'));
  const priced = rows.filter(row => row.meanCost !== null && !row.unknown
    && [...images.values()].every(i => prediction(row.model, i) && !['skipped', 'missing'].includes(prediction(row.model, i).status)))
    .sort((a, b) => a.meanCost - b.meanCost || compare(a.model.key, b.model.key));
  if (priced.length) {
    const cheapest = priced[0];
    observations.append(node('li', `Lowest cost/call: ${configurationName(cheapest.model, true)}, ${money(cheapest.meanCost)}.`));
  }
  const gaps = samples.filter(s => s.samples.length).map(({ row, samples }) => {
    const confidence = mean(samples.map(s => s.probability)), accuracy = mean(samples.map(s => s.correct));
    return { row, confidence, accuracy, n: samples.length, gap: Math.abs(confidence - accuracy) };
  }).sort((a, b) => b.gap - a.gap || compare(a.row.model.key, b.row.model.key));
  if (gaps.length) {
    const largest = gaps[0];
    observations.append(node('li', `Largest observed gap: ${configurationName(largest.row.model, true)}, ${fmt(largest.confidence * 100)}% confidence vs ${fmt(largest.accuracy * 100)}% exact (n=${largest.n}).`));
  }
}

const chartPalette = ['#216552', '#b94b38', '#456eb4', '#a17820', '#8256a6', '#268a9a', '#c2678c', '#637830', '#9b6743', '#56626f'];
function svgNode(tag, attributes, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes ?? {})) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}
const plotX = x => 55 + x * 440;
const plotY = y => 247 - y * 204;
function chartFrame(type) {
  const calibration = type === 'calibration';
  const title = calibration ? 'Confidence calibration' : 'Error vs coverage';
  const card = node('article', undefined, 'chart-card'); card.dataset.chart = type;
  card.append(node('h3', title), node('p', calibration
    ? '5 bins · larger dots = more answers · dashed line = ideal'
    : 'Accept confidence ≥ cutoff · tied scores stay together', 'chart-description'));
  const svg = svgNode('svg', { viewBox: '0 0 520 300', role: 'group', 'aria-label': title });
  svg.append(svgNode('title', {}, title));
  for (const t of [0, .25, .5, .75, 1]) {
    svg.append(svgNode('line', { x1: plotX(0), x2: plotX(1), y1: plotY(t), y2: plotY(t), class: 'chart-grid' }));
    svg.append(svgNode('text', { x: 46, y: plotY(t) + 4, 'text-anchor': 'end', class: 'chart-tick' }, `${t * 100}%`));
    svg.append(svgNode('text', { x: plotX(t), y: 266, 'text-anchor': 'middle', class: 'chart-tick' }, calibration ? String(t) : `${t * 100}%`));
  }
  svg.append(svgNode('text', { x: 55, y: 23, class: 'chart-axis' }, calibration ? 'Exact-match accuracy' : 'Wrong-count rate'));
  svg.append(svgNode('text', { x: 275, y: 292, 'text-anchor': 'middle', class: 'chart-axis' }, calibration ? 'Mean confidence (0–1)' : 'Coverage (% of known images)'));
  if (calibration) svg.append(svgNode('line', { x1: plotX(0), y1: plotY(0), x2: plotX(1), y2: plotY(1), class: 'chart-diagonal' }));
  const detail = node('p', 'Select a dot for values.', 'chart-detail');
  detail.setAttribute('aria-live', 'polite'); card.append(svg, detail);
  return { card, svg, detail };
}
function chartPoint(frame, point, color, radius, description, modelKey) {
  const dot = svgNode('circle', { cx: plotX(point.x), cy: plotY(point.y), r: radius, fill: color,
    stroke: 'white', 'stroke-width': 1.5, tabindex: 0, role: 'button', 'aria-label': description, class: 'chart-point' });
  dot.dataset.config = modelKey; dot.append(svgNode('title', {}, description));
  dot.dataset.samples = point.n;
  if (point.threshold !== undefined) dot.dataset.threshold = point.threshold;
  const show = () => { frame.detail.textContent = description; };
  for (const event of ['mouseenter', 'focus', 'click']) dot.addEventListener(event, show);
  dot.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); show(); } });
  frame.svg.append(dot);
}
function renderCharts(rows) {
  const container = $('#confidence-charts'); container.replaceChildren();
  if (!rows.length) return;
  const ordered = [...rows].sort((a, b) => compare(a.model.name, b.model.name) || compare(a.model.key, b.model.key));
  if (!ordered.some(row => row.model.key === state.chartModel)) state.chartModel = '';
  const section = node('section', undefined, 'charts-section');
  const heading = node('div', undefined, 'charts-heading');
  const label = node('label', 'Chart model '), select = node('select'); select.id = 'chart-model';
  select.setAttribute('aria-label', 'Select model configuration for confidence charts');
  const all = node('option', 'All shown models'); all.value = ''; select.append(all);
  for (const { model } of ordered) {
    const option = node('option', `${configurationName(model)} · T ${model.temp ?? 'omitted'} · ${model.effort} · ${model.provider} · ${model.maxTokens ?? 'unknown'} tokens`);
    option.value = model.key; select.append(option);
  }
  select.value = state.chartModel;
  select.addEventListener('change', () => { state.chartModel = select.value; renderCharts(visibleRows()); $('#chart-model').focus({ preventScroll: true }); });
  label.append(select); heading.append(node('h2', 'Confidence'), label);
  const shown = ordered.filter(row => !state.chartModel || row.model.key === state.chartModel);
  const legend = node('div', undefined, 'chart-legend');
  const frames = [chartFrame('calibration'), chartFrame('risk')];
  let sampleCount = 0;
  const sizes = [];
  const largestBin = Math.max(1, ...shown.flatMap(row => calibrationPoints(confidenceSamples(row)).map(point => point.n)));
  const allConfigs = [...new Map(state.groups.flatMap(group => group.models).map(m => [m.key, m])).values()].sort((a, b) => compare(a.key, b.key));
  for (const row of shown) {
    const index = allConfigs.findIndex(m => m.key === row.model.key);
    const color = chartPalette[index] ?? `hsl(${index * 137.508 % 360} 55% 40%)`;
    const item = node('button'); item.type = 'button'; item.title = `${row.model.name} · T ${row.model.temp ?? 'omitted'} · ${row.model.effort} · ${row.model.provider} · ${row.model.maxTokens ?? 'unknown'} tokens`;
    item.setAttribute('aria-label', `Show charts for ${configurationName(row.model)}`);
    item.addEventListener('click', () => { state.chartModel = state.chartModel === row.model.key ? '' : row.model.key; renderCharts(visibleRows()); $('#chart-model').focus({ preventScroll: true }); });
    const swatch = node('i'); swatch.style.backgroundColor = color; swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, document.createTextNode(configurationName(row.model, true))); legend.append(item);
    const samples = confidenceSamples(row); sampleCount += samples.length; sizes.push(samples.length);
    for (const point of calibrationPoints(samples)) {
      const description = `${configurationName(row.model, true)} · confidence ${fmt(point.x * 100)}% · exact ${point.correct}/${point.n} (${fmt(point.y * 100)}%) · bin [${point.low}, ${point.high}${point.high === 1 ? ']' : ')'}`;
      chartPoint(frames[0], point, color, 3 + 8 * Math.sqrt(point.n / largestBin), description, row.model.key);
    }
    const totalImages = row.imageRecords.filter(image => image.actual !== null && !image.conflict).length;
    const points = riskPoints(samples, totalImages);
    if (points.length > 1) frames[1].svg.append(svgNode('polyline', { points: points.map(p => `${plotX(p.x)},${plotY(p.y)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, opacity: .65 }));
    for (const point of points) {
      const description = `${configurationName(row.model, true)} · cutoff ≥ ${fmt(point.threshold, 3)} · accepted ${point.n}/${totalImages} (${fmt(point.x * 100)}%) · wrong ${point.errors}/${point.n} (${fmt(point.y * 100)}%)`;
      chartPoint(frames[1], point, color, 4.5, description, row.model.key);
    }
  }
  if (!sampleCount) for (const frame of frames) frame.detail.textContent = 'No valid confidence/ground-truth pairs.';
  const panels = node('div', undefined, 'chart-panels'); panels.append(...frames.map(f => f.card));
  const range = sizes.length ? Math.min(...sizes) === Math.max(...sizes) ? String(sizes[0]) : `${Math.min(...sizes)}–${Math.max(...sizes)}` : '0';
  section.append(heading, legend, panels, node('p', `${range} usable images/configuration · exact counts only · exploratory, not validated thresholds.`, 'chart-note'));
  container.append(section);
}
