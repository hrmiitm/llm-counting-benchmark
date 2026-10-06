// Pure scoring helpers shared by page 3 and its checks. Never round predictions.
export const PILOT_RUN = '2026-10-03T11:03:45.271545+00:00';
export const DL_SOURCES = ['YOLO-World-S', 'FamNet', 'CounTX', 'CountGD', 'CountGD++']
  .map(name => `DL-MODELS/results/${name}.json`);
export const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function prepareData(sources, metadata, dataset) {
  if (!Array.isArray(metadata) || metadata.length !== 6) throw new Error('Expected six ground-truth images.');
  const images = metadata.map(row => {
    if (String(row.group) !== '1' || !finite(row['actual-count']) || row['actual-count'] <= 0
      || typeof row.image !== 'string' || typeof row.label !== 'string') throw new Error('Invalid ground truth.');
    const split = dataset.images?.[row.image];
    if (!['train', 'val', 'test'].includes(split)) throw new Error(`Missing dataset split: ${row.image}`);
    return { image: row.image, label: row.label, actual: row['actual-count'], split };
  });
  if (new Set(images.map(row => row.image)).size !== 6) throw new Error('Duplicate ground-truth image.');
  const llms = sources.filter(({ data }) => data.run_id === PILOT_RUN);
  const dl = sources.filter(({ path }) => DL_SOURCES.includes(path));
  if (llms.length !== 9 || new Set(llms.map(s => s.data.model)).size !== 9 || dl.length !== 5) {
    throw new Error('All nine original LLMs and five current DL files are required.');
  }
  const models = [...llms.map(s => ({ ...s, kind: 'llm' })), ...dl.map(s => ({ ...s, kind: 'dl' }))]
    .map(({ path, data, kind }) => {
      if (!Array.isArray(data.results) || data.results.length !== 6) throw new Error(`Incomplete run: ${path}`);
      if (kind === 'llm' && (data.max_tokens !== 4096 || data.reasoning?.effort !== 'low'
        || data.reasoning?.enabled !== true || data.allow_fallbacks !== false
        || data.tools?.length !== 0 || data.tool_choice !== 'none')) throw new Error(`Unexpected LLM configuration: ${path}`);
      if (kind === 'dl' && (data.status !== 'success' || !data.configuration || !data.config_sha256
        || data.setup?.status !== 'ready')) throw new Error(`DL run is not verified complete: ${path}`);
      const rows = images.map(image => {
        const matches = data.results.filter(r => String(r.group) === '1' && r.image === image.image);
        if (matches.length !== 1) throw new Error(`Missing/duplicate image in ${path}: ${image.image}`);
        const row = matches[0];
        if (row.status !== 'success' || !finite(row.model_count) || row.model_count < 0) throw new Error(`Unsuccessful prediction: ${path}`);
        if (kind === 'llm' && (!finite(row.confidence) || row.confidence < 0 || row.confidence > 1)) throw new Error(`Invalid confidence: ${path}`);
        if (kind === 'dl' && row.confidence !== null) throw new Error(`Detection score used as count confidence: ${path}`);
        return { ...image, count: row.model_count, confidence: row.confidence,
          correct: Number(row.model_count === image.actual),
          deviation: Math.abs(row.model_count - image.actual) / image.actual * 100,
          latency: row.latency_seconds };
      });
      return { name: data.model, label: data.model === 'ultralytics/yolov8s-worldv2' ? 'YOLO-World-S (v2)' : data.model.split('/').at(-1), path, kind,
        exemplar: data.model === 'FamNet', config: data.configuration ?? null, rows };
    });
  return { models, images };
}

export function selectedRows(model, scope = 'all') {
  return model.rows.filter(row => scope === 'all' || row.split !== 'train');
}

export function statistics(model, scope = 'all') {
  const rows = selectedRows(model, scope);
  if (!rows.length) throw new Error('No images in selected scope.');
  const confidences = rows.filter(row => row.confidence !== null);
  const accuracy = mean(rows.map(row => row.correct));
  return { ...model, rows, n: rows.length, deviation: mean(rows.map(row => row.deviation)), accuracy,
    confidence: confidences.length ? mean(confidences.map(row => row.confidence)) : null,
    brier: confidences.length ? mean(confidences.map(row => (row.confidence - row.correct) ** 2)) : null };
}

export function calibrationBins(rows) {
  // Same five equal-width confidence bands as the reference; omit empty bands.
  return Array.from({ length: 5 }, (_, index) => {
    const members = rows.filter(row => row.confidence !== null && Math.min(4, Math.floor(row.confidence * 5)) === index);
    return members.length ? { band: index, low: index / 5, high: (index + 1) / 5,
      x: mean(members.map(row => row.confidence)), y: mean(members.map(row => row.correct)),
      n: members.length, correct: members.reduce((sum, row) => sum + row.correct, 0) } : null;
  }).filter(Boolean);
}

export function confidenceCutoff(models, cutoff = .9) {
  const accepted = models.filter(model => model.kind === 'llm').flatMap(model => model.rows)
    .filter(row => row.confidence >= cutoff);
  return { n: accepted.length, wrong: accepted.filter(row => !row.correct).length };
}
