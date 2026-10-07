// Page 4's pure analysis. Prediction values come only from saved eval4 envelopes.
export const EFFORTS = ['low', 'medium', 'high'];
export const finite = n => typeof n === 'number' && Number.isFinite(n);
export const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export const imageKey = r => `${String(r.group)}|${r.image}`;
export const isResultPath = path => /^eval4\/[^/]+\.json$/.test(path)
  && !['eval4/preflight.json', 'eval4/manifest.json'].includes(path);
export const nameOf = model => model.split('/').at(-1).split('-').map(word =>
  word === 'gpt' ? 'GPT' : /^\d/.test(word) ? word : word[0]?.toUpperCase() + word.slice(1)).join(' ');

export function colabEnvelopes(source, images) {
  const doc = source.data, allowed = ['CountGD', 'CountGD++', 'CounTX', 'YOLO-World-S'];
  if (doc.provider !== 'Google Colab' || typeof doc.gpu !== 'string' || !doc.gpu.trim()
    || !Array.isArray(doc.models) || !doc.models.length) throw new Error('Invalid Colab benchmark header.');
  const rate = doc.hourly_cost_usd;
  if (rate !== null && (!finite(rate) || rate < 0)) throw new Error('hourly_cost_usd must be null or a finite nonnegative number.');
  const names = new Set();
  return doc.models.map(model => {
    if (!allowed.includes(model.model) || names.has(model.model)) throw new Error(`Unsupported/duplicate Colab model: ${model.model}`);
    names.add(model.model);
    if (!Array.isArray(model.images) || model.images.length !== images.length) throw new Error(`${model.model}: expected the complete image set.`);
    const seen = new Set();
    const results = model.images.map(row => {
      const image = images.find(i => i.image === row.image);
      if (!image || seen.has(row.image) || !finite(row.predicted_count) || row.predicted_count < 0
        || !finite(row.inference_seconds) || row.inference_seconds < 0) throw new Error(`${model.model}: invalid image/count/timing.`);
      seen.add(row.image);
      const cost = rate === null ? null : row.inference_seconds / 3600 * rate;
      if (cost !== null && !finite(cost)) throw new Error('Compute cost overflow.');
      return { group: image.group, image: row.image, label: image.label, model_count: row.predicted_count,
        inference_seconds: row.inference_seconds, confidence: null, cost_usd: cost, status: 'success', attempt_count: 1 };
    });
    return { path: source.path, data: { model: model.model, model_type: 'deep learning', gpu: doc.gpu,
      hourly_cost_usd: rate, provider_endpoint: 'Google Colab', reasoning: { enabled: false, effort: 'none' }, results } };
  });
}

function signature(data) {
  const fields = ['prompt', 'model_temp', 'max_tokens', 'provider_endpoint', 'allow_fallbacks',
    'tools', 'tool_choice', 'confidence_scale'];
  const reasoning = Object.keys(data.reasoning ?? {}).filter(k => k !== 'effort').sort().map(k => [k, data.reasoning[k]]);
  return JSON.stringify([fields.map(k => [k, Object.hasOwn(data, k), data[k]]), reasoning,
    data.request_timeout_seconds ?? 180]);
}
const timestamp = data => Math.max(0, ...[data.run_id, ...data.results.map(r => r.finished_at_utc ?? r.started_at_utc)]
  .map(x => Date.parse(x)).filter(Number.isFinite));

export function prepareData(sources, metadata) {
  if (!Array.isArray(metadata) || !metadata.length) throw new Error('Supplied scoring metadata is unavailable.');
  const warnings = [], truths = new Map();
  for (const row of metadata.filter(r => String(r.group) === '1')) {
    if (typeof row.image !== 'string' || !finite(row['actual-count']) || row['actual-count'] < 0) {
      warnings.push('An invalid supplied count was excluded.'); continue;
    }
    const key = imageKey(row), previous = truths.get(key);
    if (previous && previous.actual !== row['actual-count']) {
      previous.actual = null; warnings.push(`Conflicting supplied counts disable scoring for ${row.image}.`);
    } else if (!previous) truths.set(key, { key, group: String(row.group), image: row.image,
      label: row.label ?? row.image, actual: row['actual-count'] });
  }
  const images = [...truths.values()];
  if (!images.length) throw new Error('No Group 1 scoring images were found.');
  sources = sources.filter(s => isResultPath(s.path)).flatMap(source => source.data?.provider === 'Google Colab' ? colabEnvelopes(source, images) : [source]);
  const latest = new Map();
  for (const source of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isResultPath(source.path)) continue;
    const data = source.data;
    if (!data || !Array.isArray(data.results) || typeof data.model !== 'string'
      || (!EFFORTS.includes(data.reasoning?.effort) && !(data.model_type === 'deep learning' && data.reasoning?.effort === 'none'))) {
      warnings.push(`Not a model/effort result envelope: ${source.path}`); continue;
    }
    const key = `${data.model}|${data.reasoning.effort}`, stamp = timestamp(data);
    if (!latest.has(key) || latest.get(key).stamp <= stamp) latest.set(key, { ...source, stamp });
  }
  const configs = [...latest.values()].map(({ path, data }) => {
    const effort = data.reasoning.effort, duplicates = new Set(), indexed = new Map();
    for (const row of data.results) {
      const key = imageKey(row);
      if (!truths.has(key)) continue;
      if (indexed.has(key)) duplicates.add(key);
      indexed.set(key, row);
    }
    const rows = images.map(image => {
      const raw = indexed.get(image.key);
      const success = raw?.status === 'success' && finite(raw.model_count) && raw.model_count >= 0
        && !duplicates.has(image.key) && (!raw.reasoning_effort || raw.reasoning_effort === effort);
      const deviation = success && finite(image.actual) && image.actual > 0
        ? Math.abs(raw.model_count - image.actual) / image.actual * 100 : null;
      const confidence = success && (data.confidence_scale ?? '0-1') === '0-1'
        && finite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
      const attempted = !!raw && raw.status !== 'skipped' && (raw.attempt_count > 0 || ['success', 'failed'].includes(raw.status));
      const cost = attempted && finite(raw.cost_usd) && raw.cost_usd >= 0 ? raw.cost_usd : null;
      return { ...image, raw, status: raw?.status ?? 'missing', success, count: success ? raw.model_count : null,
        confidence, deviation, attempted, cost, model: data.model, effort,
        reason: raw?.raw_response?.error?.message ?? raw?.error?.reason ?? 'No saved answer.' };
    });
    const scored = rows.filter(r => r.deviation !== null);
    const successful = rows.filter(r => r.success).length;
    const n = images.length, costKnown = rows.every(r => r.attempted && r.cost !== null);
    const complete = successful === n && scored.length === n && data.results.length === n;
    const knownCost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
    const isDL = data.model_type === 'deep learning';
    const totalInferenceSeconds = isDL ? data.results.reduce((sum, r) => sum + r.inference_seconds, 0) : null;
    const computeCost = isDL && data.hourly_cost_usd !== null ? totalInferenceSeconds / 3600 * data.hourly_cost_usd : null;
    if (isDL && (!finite(totalInferenceSeconds) || (costKnown && (!finite(computeCost) || !finite(computeCost / n * 1000))))) throw new Error('Colab timing/cost total overflow.');
    return { id: `${data.model}|${effort}`, model: data.model, name: isDL ? data.model : nameOf(data.model), effort, path, data, isDL,
      totalInferenceSeconds, costPerImage: isDL && costKnown ? computeCost / n : null,
      costPer1000Images: isDL && costKnown ? computeCost / n * 1000 : null,
      signature: signature(data), rows, n, successful, scored: scored.length, complete,
      deviation: mean(scored.map(r => r.deviation)), knownCost,
      unknownCosts: rows.filter(r => r.attempted && r.cost === null).length,
      totalCost: complete && costKnown ? (isDL ? computeCost : knownCost) : null,
      costEligible: complete && costKnown, confidence: mean(rows.filter(r => r.confidence !== null).map(r => r.confidence)),
      failed: rows.filter(r => r.status === 'failed').length, skipped: rows.filter(r => r.status === 'skipped').length,
      missing: rows.filter(r => r.status === 'missing').length };
  }).sort((a, b) => a.model.localeCompare(b.model) || EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
  const models = [...new Set(configs.map(c => c.model))].sort();
  for (const model of models) {
    const levels = configs.filter(c => c.model === model);
    if (levels.every(c => c.isDL)) continue;
    if (new Set(levels.map(c => c.signature)).size > 1) warnings.push(
      `${nameOf(model)} has different non-effort settings across levels; its cost points are not connected and no reasoning-effect conclusion is drawn.`);
    for (const effort of EFFORTS) if (!levels.some(c => c.effort === effort)) warnings.push(`${nameOf(model)} has no ${effort} result file.`);
  }
  const budgets = [...new Set(configs.map(c => c.data.max_tokens).filter(finite))].sort((a, b) => a - b);
  if (budgets.length > 1) warnings.push(`Token caps differ across models (${budgets.map(n => n.toLocaleString('en-US')).join(' / ')}). Cross-model comparisons do not isolate reasoning effort.`);
  if (images.some(r => r.actual === 0)) warnings.push('Percentage deviation is undefined for supplied zero counts; those images are not scored.');
  if (configs.some(c => c.isDL)) warnings.push('Colab DL compute cost prices measured inference only; excludes installation, loading, warm-up and idle time. It is an estimate, not a Colab invoice. This FSC-147 pilot includes training images for dataset-trained checkpoints and is not an independent held-out evaluation.');
  return { configs, images, models, warnings: [...new Set(warnings)] };
}

export function confidenceRows(config) {
  return config.rows.filter(r => r.confidence !== null && r.deviation !== null);
}

// Reprice a view, leaving the saved envelope, predictions and timings intact.
export function priceDLConfig(config, rate = config.data.hourly_cost_usd) {
  if (!config.isDL) return config;
  if (rate !== null && (!finite(rate) || rate < 0)) throw new Error('Invalid DL hourly rate.');
  const total = rate === null ? null : config.totalInferenceSeconds / 3600 * rate;
  if (total !== null && (!finite(total) || !finite(total / config.n * 1000))) throw new Error('DL cost overflow.');
  return { ...config, effectiveHourlyRate: rate,
    rows: config.rows.map(r => ({ ...r, cost: rate === null ? null : r.raw.inference_seconds / 3600 * rate })),
    knownCost: total ?? 0, unknownCosts: rate === null ? config.n : 0,
    totalCost: config.complete ? total : null, costEligible: config.complete && rate !== null,
    costPerImage: total === null ? null : total / config.n,
    costPer1000Images: total === null ? null : total / config.n * 1000 };
}

export function confidenceSummary(config) {
  const rows = confidenceRows(config);
  // Both means must describe the SAME full image set, never mismatched subsets.
  if (!config.complete || rows.length !== config.n) return null;
  return { ...config, confidence: mean(rows.map(r => r.confidence)),
    deviation: mean(rows.map(r => r.deviation)), imageCount: rows.length };
}

export function coverageCurve(config) {
  const rows = confidenceRows(config).sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
  const points = [], accepted = [];
  // Equal confidence is one cutoff: never claim a selective advantage from breaking a tie.
  for (let i = 0; i < rows.length; i++) {
    accepted.push(rows[i]);
    if (i + 1 < rows.length && rows[i + 1].confidence === rows[i].confidence) continue;
    points.push({ model: config.model, effort: config.effort, confidence: rows[i].confidence,
      accepted: accepted.length, denominator: config.n, coverage: accepted.length / config.n * 100,
      deviation: mean(accepted.map(r => r.deviation)), images: accepted.map(r => r.image) });
  }
  return points;
}

export function acceptance(configs, cutoff) {
  configs = configs.filter(c => !c.isDL); // DL detection scores are not P(exact count).
  const all = configs.flatMap(confidenceRows), kept = all.filter(r => r.confidence >= cutoff);
  return { accepted: kept.length, denominator: configs.reduce((n, c) => n + c.n, 0),
    valid: all.length, coverage: configs.length ? kept.length / configs.reduce((n, c) => n + c.n, 0) * 100 : 0,
    deviation: mean(kept.map(r => r.deviation)), baseline: mean(all.map(r => r.deviation)) };
}

export function reasoningPairs(configs) {
  return [...new Set(configs.map(c => c.model))].flatMap(model => {
    if (new Set(configs.filter(c => c.model === model).map(c => c.signature)).size > 1) return [];
    const low = configs.find(c => c.model === model && c.effort === 'low');
    const high = configs.find(c => c.model === model && c.effort === 'high');
    if (!low?.costEligible || !high?.costEligible || low.signature !== high.signature) return [];
    return [{ model, name: low.name, low, high, costChange: high.totalCost - low.totalCost,
      errorReduction: low.deviation - high.deviation }];
  });
}
