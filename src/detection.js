'use strict';

const { spawn } = require('child_process');

const SAMPLE_WIDTH = 320;
const SAMPLE_HEIGHT = 180;
const DEFAULT_FPS = 5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function localMedian(values, index, radius = 10, exclusion = 1) {
  const window = [];
  const start = Math.max(0, index - radius);
  const end = Math.min(values.length - 1, index + radius);
  for (let cursor = start; cursor <= end; cursor++) {
    if (Math.abs(cursor - index) <= exclusion) continue;
    window.push(values[cursor]);
  }
  return median(window);
}

function candidate(time, type, confidence, score, detail = {}) {
  return { time, type, confidence: clamp(confidence, 0, 1), score: Number(score) || 0, detail };
}

function findHardCuts(samples, options) {
  const floor = clamp(options.hardCutFloor, 0.5, 60) / 100;
  const multiplier = clamp(options.relativeMultiplier, 1.2, 30);
  const scores = samples.map(sample => sample.score || 0);
  const candidates = [];
  for (let index = 1; index < samples.length - 1; index++) {
    const current = samples[index];
    const baseline = Math.max(0.0025, localMedian(scores, index));
    const ratio = current.score / baseline;
    const peak = current.score >= samples[index - 1].score && current.score > samples[index + 1].score;
    const histogramEvidence = current.histDiff >= floor * 0.72;
    const pixelEvidence = current.pixelDiff >= floor * 1.55 && current.histDiff >= floor * 0.36;
    if (!peak || current.score < floor || ratio < multiplier || (!histogramEvidence && !pixelEvidence)) continue;
    candidates.push(candidate(current.time, 'hard-cut', Math.min(1, 0.48 + current.score * 2.2 + Math.min(0.28, ratio / 35)), current.score, { ratio, baseline }));
  }
  return candidates;
}

function findWhiteFlashes(samples) {
  const candidates = [];
  for (let index = 1; index < samples.length - 1; index++) {
    const before = samples[index - 1];
    const current = samples[index];
    const after = samples[index + 1];
    const rise = current.luma - before.luma;
    const fall = current.luma - after.luma;
    const isolated = current.luma > 0.78 && rise > 0.18 && fall > 0.16;
    if (!isolated) continue;
    const strength = Math.min(1, (rise + fall) / 0.75);
    candidates.push(candidate(current.time, 'white-flash', 0.65 + strength * 0.3, Math.max(current.score, after.score), { rise, fall }));
  }
  return candidates;
}

function findFades(samples, fps) {
  const candidates = [];
  const windowSize = Math.max(4, Math.round(fps * 1.2));
  for (let start = 0; start + windowSize < samples.length; start++) {
    const window = samples.slice(start, start + windowSize + 1);
    const delta = window.at(-1).luma - window[0].luma;
    if (Math.abs(delta) < 0.22) continue;
    const direction = Math.sign(delta);
    let aligned = 0;
    for (let index = 1; index < window.length; index++) {
      const step = window[index].luma - window[index - 1].luma;
      if (Math.sign(step) === direction || Math.abs(step) < 0.012) aligned++;
    }
    const alignment = aligned / windowSize;
    const endpoint = window.at(-1).luma;
    const reachesEdge = direction < 0 ? endpoint < 0.24 : endpoint > 0.76;
    if (alignment < 0.72 || !reachesEdge) continue;
    const middle = window[Math.floor(window.length / 2)];
    candidates.push(candidate(middle.time, direction < 0 ? 'fade-out' : 'fade-in', Math.min(0.92, 0.48 + Math.abs(delta) + alignment * 0.18), Math.abs(delta), { alignment, delta }));
    start += Math.floor(windowSize / 2);
  }
  return candidates;
}

function findDissolves(samples, fps, hardCutFloor) {
  const candidates = [];
  const windowSize = Math.max(4, Math.round(fps));
  const floor = clamp(hardCutFloor, 0.5, 60) / 100;
  for (let start = 1; start + windowSize < samples.length; start++) {
    const window = samples.slice(start, start + windowSize);
    const active = window.filter(sample => sample.score > 0.012 && sample.score < Math.max(0.18, floor * 1.75));
    if (active.length < Math.ceil(windowSize * 0.7)) continue;
    const cumulative = active.reduce((sum, sample) => sum + sample.score, 0);
    const mean = cumulative / active.length;
    const deviation = Math.sqrt(active.reduce((sum, sample) => sum + (sample.score - mean) ** 2, 0) / active.length);
    const coefficientOfVariation = deviation / Math.max(0.001, mean);
    const histogramRun = active.filter(sample => sample.histDiff > 0.01).length / active.length;
    const singlePeak = Math.max(...window.map(sample => sample.score));
    const baselineBefore = median(samples.slice(Math.max(0, start - windowSize), start).map(sample => sample.score));
    const baselineAfter = median(samples.slice(start + windowSize, start + windowSize * 2).map(sample => sample.score));
    const surrounding = Math.max(0.004, (baselineBefore + baselineAfter) / 2);
    if (cumulative < Math.max(0.13, floor * 2.1) || histogramRun < 0.78 || singlePeak / surrounding < 2.2 || coefficientOfVariation > 0.48 || surrounding > mean * 0.58) continue;
    const middle = window[Math.floor(window.length / 2)];
    candidates.push(candidate(middle.time, 'dissolve', Math.min(0.82, 0.36 + cumulative * 1.35 + histogramRun * 0.16), cumulative / windowSize, { cumulative, histogramRun, coefficientOfVariation }));
    start += windowSize * 2;
  }
  return candidates;
}

function mergeCandidates(candidates, minGap, maxShots) {
  const mergeWindow = Math.max(0.24, Math.min(0.75, minGap * 0.75));
  const clusters = [];
  for (const entry of [...candidates].sort((a, b) => a.time - b.time)) {
    const cluster = clusters.at(-1);
    if (!cluster || entry.time - cluster.at(-1).time > mergeWindow) clusters.push([entry]);
    else cluster.push(entry);
  }
  const merged = clusters.map(entries => {
    const strongest = [...entries].sort((a, b) => b.confidence - a.confidence)[0];
    const weight = entries.reduce((sum, entry) => sum + entry.confidence, 0) || 1;
    return {
      ...strongest,
      time: entries.reduce((sum, entry) => sum + entry.time * entry.confidence, 0) / weight,
      detectors: [...new Set(entries.map(entry => entry.type))],
      confidence: Math.min(1, strongest.confidence + (entries.length - 1) * 0.08)
    };
  });
  const spaced = [];
  for (const entry of merged) {
    const previous = spaced.at(-1);
    if (!previous || entry.time - previous.time >= minGap) spaced.push(entry);
    else if (entry.confidence > previous.confidence) spaced[spaced.length - 1] = entry;
  }
  const limit = Math.max(1, Math.floor(Number(maxShots) || 6000) - 1);
  if (spaced.length <= limit) return spaced;
  return spaced.sort((a, b) => b.confidence - a.confidence).slice(0, limit).sort((a, b) => a.time - b.time);
}

function classicCandidates(samples, options) {
  const values = samples.map(sample => sample.histDiff);
  const middle = median(values);
  const mad = median(values.map(value => Math.abs(value - middle)));
  const configured = clamp(options.classicThreshold, 0.01, 1);
  const threshold = Math.max(configured, middle + 3 * mad);
  const found = [];
  for (let index = 1; index < samples.length - 1; index++) {
    const current = samples[index];
    if (current.histDiff < threshold || current.histDiff < samples[index - 1].histDiff || current.histDiff <= samples[index + 1].histDiff) continue;
    found.push(candidate(current.time, 'classic-frame-difference', Math.min(1, 0.5 + current.histDiff), current.histDiff, { threshold }));
  }
  return { candidates: found, threshold, median: middle, mad };
}

function detectTransitions(samples, rawOptions = {}) {
  const options = {
    mode: rawOptions.mode === 'classic' ? 'classic' : 'hybrid',
    hardCutFloor: Number(rawOptions.hardCutFloor ?? 5.5),
    relativeMultiplier: Number(rawOptions.relativeMultiplier ?? 8),
    classicThreshold: Number(rawOptions.classicThreshold ?? 0.08),
    minGap: Math.max(0.1, Number(rawOptions.minGap ?? 0.5)),
    maxShots: Math.max(2, Number(rawOptions.maxShots ?? 6000)),
    fps: Math.max(1, Number(rawOptions.fps ?? DEFAULT_FPS))
  };
  const classic = classicCandidates(samples, options);
  const adaptiveHardCuts = classic.candidates.map(entry => ({ ...entry, type:'hard-cut', confidence:Math.min(0.94,entry.confidence*.92), detail:{...entry.detail,method:'adaptive-frame-difference'} }));
  const detectorCandidates = options.mode === 'classic'
    ? classic.candidates
    : [
        ...adaptiveHardCuts,
        ...findHardCuts(samples, options),
        ...findWhiteFlashes(samples),
        ...findFades(samples, options.fps),
        ...findDissolves(samples, options.fps, options.hardCutFloor)
      ];
  const cuts = mergeCandidates(detectorCandidates, options.minGap, options.maxShots);
  const detectorCounts = detectorCandidates.reduce((counts, entry) => {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
    return counts;
  }, {});
  return {
    cuts,
    detectorCounts,
    options,
    classicStats: { threshold: classic.threshold, median: classic.median, mad: classic.mad }
  };
}

function scanVideo({ ffmpegPath, video, duration, options = {}, onProgress }) {
  const fps = Math.max(1, Number(options.fps ?? DEFAULT_FPS));
  const frameSize = SAMPLE_WIDTH * SAMPLE_HEIGHT;
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', video, '-an', '-vf', `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`, '-r', String(fps), '-pix_fmt', 'gray', '-c:v', 'rawvideo', '-f', 'image2pipe', '-'];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let pending = Buffer.alloc(0);
    let previous = null;
    let frameIndex = 0;
    let stderr = '';
    const samples = [];
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        const frame = Buffer.from(pending.subarray(0, frameSize));
        pending = pending.subarray(frameSize);
        const histogram = new Float64Array(32);
        let lumaTotal = 0;
        let pixelDifference = 0;
        let count = 0;
        for (let index = 0; index < frameSize; index += 4) {
          const value = frame[index];
          histogram[value >> 3]++;
          lumaTotal += value;
          if (previous) pixelDifference += Math.abs(value - previous[index]);
          count++;
        }
        for (let index = 0; index < histogram.length; index++) histogram[index] /= count;
        if (previous) {
          let histogramDifference = 0;
          const previousHistogram = samples.at(-1)?.histogram;
          for (let index = 0; index < histogram.length; index++) histogramDifference += Math.abs(histogram[index] - previousHistogram[index]);
          const histDiff = histogramDifference / 2;
          const pixelDiff = pixelDifference / count / 255;
          samples.push({
            time: frameIndex / fps,
            histDiff,
            pixelDiff,
            score: histDiff * 0.72 + pixelDiff * 0.28,
            luma: lumaTotal / count / 255,
            histogram
          });
        } else {
          samples.push({ time: 0, histDiff: 0, pixelDiff: 0, score: 0, luma: lumaTotal / count / 255, histogram });
        }
        previous = frame;
        frameIndex++;
        onProgress?.(Math.min(0.99, (frameIndex / fps) / Math.max(0.1, duration)));
      }
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `视频解码失败：${code}`));
      const result = detectTransitions(samples, { ...options, fps });
      resolve({
        ...result,
        samples: samples.map(({ histogram, ...sample }) => sample)
      });
    });
  });
}

module.exports = {
  detectTransitions,
  scanVideo,
  _test: { median, localMedian, findHardCuts, findWhiteFlashes, findFades, findDissolves, mergeCandidates }
};
