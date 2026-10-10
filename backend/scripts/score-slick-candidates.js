/**
 * ==============================================================================
 * SAR DARK-SLICK CANDIDATE SCORING & FILTERING MODULE
 * ==============================================================================
 * Operates on extracted features from V2 Minimal Morphology candidates
 * (candidate_features.json).
 *
 * Implements an explainable, multi-criteria heuristic scoring system:
 * - Area adequacy (penalizes marginal near-10px speckle, rewards coherent slicks)
 * - Elongation / geometry (rewards trailing/linear filaments)
 * - VV backscatter damping (rewards strong radar contrast >= 3.5 dB)
 * - Polarimetric differential damping (VV damping minus VH damping)
 * - VH radiometric level (penalizes elevated cross-pol)
 * - Boundary gradient sharpness (rewards sharp slick-ocean transition)
 *
 * NOTE: This is an explainable heuristic ranking system for candidate triage,
 * NOT a machine learning classifier or scientifically validated probability.
 *
 * Ground truth: DARTIS_2019 ow-0002 Pascal VOC XML
 * Outputs:
 * - backend/data/sentinel-test/validation/candidate_scores.json
 * - backend/data/sentinel-test/validation/feature_filter_overlay.png
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// File paths
const VAL_DIR = path.resolve(__dirname, '../data/sentinel-test/validation');
const FEATURES_JSON_PATH = path.join(VAL_DIR, 'candidate_features.json');
const CDSE_VV_PATH = path.join(VAL_DIR, 's1a_20190104_vv_db.tif');
const GT_XML_PATH = path.join(VAL_DIR, 'ow-0002.xml');
const OUT_SCORES_JSON = path.join(VAL_DIR, 'candidate_scores.json');
const OUT_OVERLAY_PNG = path.join(VAL_DIR, 'feature_filter_overlay.png');

// Initial Heuristic Weights (Sum = 1.00)
const HEURISTIC_WEIGHTS = {
  w_area: 0.15,      // Coherent candidate surface area
  w_elong: 0.20,     // Moment-derived elongation ratio
  w_vv_damp: 0.25,   // Local co-polarization damping contrast
  w_pol_diff: 0.15,  // Differential damping (VV damping - VH damping)
  w_vh_level: 0.10,  // Cross-pol noise floor consistency
  w_grad: 0.15,      // Perimeter gradient sharpness
};

// Filter Threshold (Initial Heuristic Baseline)
const FILTER_THRESHOLD = 0.50; // Candidates with score >= 0.50 are retained

// ==============================================================================
// 1. PNG ENCODING & DRAWING HELPERS
// ==============================================================================

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makePngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const l = Buffer.alloc(4);
  l.writeUInt32BE(data.length, 0);
  const toCrc = Buffer.concat([t, data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(toCrc), 0);
  return Buffer.concat([l, toCrc, c]);
}
function encodeRgbPng(width, height, rgbBuffer) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlineLength = width * 3 + 1;
  const scanlines = Buffer.alloc(height * scanlineLength);
  for (let y = 0; y < height; y++) {
    scanlines[y * scanlineLength] = 0;
    rgbBuffer.copy(scanlines, y * scanlineLength + 1, y * width * 3, (y + 1) * width * 3);
  }

  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', zlib.deflateSync(scanlines)),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const FONT_5X7 = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ':': [0, 12, 12, 0, 12, 12, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 12, 12, 8],
  '=': [0, 31, 0, 31, 0, 0, 0],
  '/': [1, 2, 4, 8, 16, 0, 0],
  '(': [6, 12, 8, 8, 8, 12, 6],
  ')': [12, 6, 2, 2, 2, 6, 12],
  '[': [14, 8, 8, 8, 8, 8, 14],
  ']': [14, 2, 2, 2, 2, 2, 14],
  '#': [10, 31, 10, 10, 31, 10, 0],
  '%': [19, 19, 4, 8, 8, 25, 25],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  'A': [14, 17, 17, 31, 17, 17, 17],
  'B': [30, 17, 17, 30, 17, 17, 30],
  'C': [14, 17, 16, 16, 16, 17, 14],
  'D': [28, 18, 17, 17, 17, 18, 28],
  'E': [31, 16, 16, 30, 16, 16, 31],
  'F': [31, 16, 16, 30, 16, 16, 16],
  'G': [14, 17, 16, 23, 17, 17, 14],
  'H': [17, 17, 17, 31, 17, 17, 17],
  'I': [14, 4, 4, 4, 4, 4, 14],
  'J': [7, 2, 2, 2, 2, 18, 12],
  'K': [17, 18, 20, 24, 20, 18, 17],
  'L': [16, 16, 16, 16, 16, 16, 31],
  'M': [17, 27, 21, 21, 17, 17, 17],
  'N': [17, 25, 21, 19, 17, 17, 17],
  'O': [14, 17, 17, 17, 17, 17, 14],
  'P': [30, 17, 17, 30, 16, 16, 16],
  'Q': [14, 17, 17, 17, 21, 18, 13],
  'R': [30, 17, 17, 30, 20, 18, 17],
  'S': [15, 16, 16, 14, 1, 1, 30],
  'T': [31, 4, 4, 4, 4, 4, 4],
  'U': [17, 17, 17, 17, 17, 17, 14],
  'V': [17, 17, 17, 17, 17, 10, 4],
  'W': [17, 17, 17, 21, 21, 27, 17],
  'X': [17, 17, 10, 4, 10, 17, 17],
  'Y': [17, 17, 10, 4, 4, 4, 4],
  'Z': [31, 1, 2, 4, 8, 16, 31],
};

function drawPixel(buf, w, h, x, y, r, g, b) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const idx = (y * w + x) * 3;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
}

function drawRect(buf, w, h, x1, y1, x2, y2, r, g, b, filled = false, thickness = 1) {
  const minX = Math.max(0, Math.min(x1, x2));
  const maxX = Math.min(w - 1, Math.max(x1, x2));
  const minY = Math.max(0, Math.min(y1, y2));
  const maxY = Math.min(h - 1, Math.max(y1, y2));

  if (filled) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        drawPixel(buf, w, h, x, y, r, g, b);
      }
    }
  } else {
    for (let t = 0; t < thickness; t++) {
      for (let x = minX; x <= maxX; x++) {
        drawPixel(buf, w, h, x, minY + t, r, g, b);
        drawPixel(buf, w, h, x, maxY - t, r, g, b);
      }
      for (let y = minY; y <= maxY; y++) {
        drawPixel(buf, w, h, minX + t, y, r, g, b);
        drawPixel(buf, w, h, maxX - t, y, r, g, b);
      }
    }
  }
}

function drawText(buf, w, h, startX, startY, text, r, g, b, bgR = null, bgG = null, bgB = null) {
  const str = String(text).toUpperCase();
  const charWidth = 6;
  const charHeight = 8;

  if (bgR !== null) {
    drawRect(buf, w, h, startX - 2, startY - 2, startX + str.length * charWidth + 1, startY + charHeight, bgR, bgG, bgB, true);
  }

  let curX = startX;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const bitmap = FONT_5X7[ch] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
      const rowBits = bitmap[row];
      for (let col = 0; col < 5; col++) {
        if ((rowBits & (1 << (4 - col))) !== 0) {
          drawPixel(buf, w, h, curX + col, startY + row, r, g, b);
        }
      }
    }
    curX += charWidth;
  }
}

function readGeoTiffFloat32(filePath, width, height) {
  const buf = fs.readFileSync(filePath);
  const isBE = buf[0] === 0x4d && buf[1] === 0x4d;
  const readUint32 = (off) => isBE ? buf.readUInt32BE(off) : buf.readUInt32LE(off);

  const numStrips = 64;
  const decomp = [];
  for (let i = 0; i < numStrips; i++) {
    const off = readUint32(220 + i * 4);
    const len = readUint32(476 + i * 4);
    decomp.push(zlib.inflateSync(buf.subarray(off, off + len)));
  }

  const raw = Buffer.concat(decomp);
  const floats = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    floats[i] = isBE ? raw.readFloatBE(i * 4) : raw.readFloatLE(i * 4);
  }
  return floats;
}

// ==============================================================================
// 2. EXPLAINABLE CANDIDATE SCORER
// ==============================================================================

function computeCandidateScore(candidate) {
  const area = candidate.area.pixelArea;
  const elong = candidate.elongation.ratio;
  const vvDamp = candidate.localContrast.vvDampingDb;
  const vhDamp = candidate.localContrast.vhDampingDb;
  const meanVh = candidate.radiometryMean.vhDb;
  const gradMean = candidate.boundaryGradient.mean;
  const polDiffDamp = vvDamp - vhDamp;

  const reasons = [];

  // 1. Area Sub-Score (0.0 to 1.0)
  // Penalizes minimal 10-pixel clusters; rewards coherent slicks >= 50 px
  let s_area = 0;
  if (area >= 100) {
    s_area = 1.0;
    reasons.push(`+ Large coherent area (${area} px)`);
  } else if (area >= 30) {
    s_area = 0.5 + 0.5 * ((area - 30) / 70);
    reasons.push(`+ Moderate cohesive area (${area} px)`);
  } else if (area >= 15) {
    s_area = 0.2 + 0.3 * ((area - 15) / 15);
    reasons.push(`~ Small cluster area (${area} px)`);
  } else {
    s_area = 0.1 * (area / 15);
    reasons.push(`- Marginal area near detection threshold (${area} px)`);
  }

  // 2. Elongation / Geometry Sub-Score (0.0 to 1.0)
  // Rewards linear/curvilinear trailing filaments (elongation >= 1.5)
  let s_elong = 0;
  if (elong >= 2.5) {
    s_elong = 1.0;
    reasons.push(`+ Strongly elongated filament (ratio = ${elong})`);
  } else if (elong >= 1.5) {
    s_elong = 0.5 + 0.5 * ((elong - 1.5) / 1.0);
    reasons.push(`+ Moderately elongated structure (ratio = ${elong})`);
  } else if (elong >= 1.2) {
    s_elong = 0.2 + 0.3 * ((elong - 1.2) / 0.3);
    reasons.push(`~ Mildly asymmetric geometry (ratio = ${elong})`);
  } else {
    s_elong = 0.1;
    reasons.push(`- Near-isotropic / compact shape (ratio = ${elong})`);
  }

  // 3. VV Damping Sub-Score (0.0 to 1.0)
  // Minimum detection threshold is 3.5 dB; reward strong backscatter suppression
  let s_vv_damp = 0;
  if (vvDamp >= 7.0) {
    s_vv_damp = 1.0;
    reasons.push(`+ Very strong VV backscatter damping (${vvDamp} dB)`);
  } else if (vvDamp >= 5.0) {
    s_vv_damp = 0.6 + 0.4 * ((vvDamp - 5.0) / 2.0);
    reasons.push(`+ Strong VV capillary damping (${vvDamp} dB)`);
  } else if (vvDamp >= 3.5) {
    s_vv_damp = 0.2 + 0.4 * ((vvDamp - 3.5) / 1.5);
    reasons.push(`~ Moderate VV damping above baseline (${vvDamp} dB)`);
  } else {
    s_vv_damp = 0.1;
    reasons.push(`- Weak VV damping near noise floor (${vvDamp} dB)`);
  }

  // 4. Polarimetric Differential Damping (0.0 to 1.0)
  // Oil dampens co-pol (VV) more than cross-pol (VH)
  let s_pol_diff = 0;
  if (polDiffDamp >= 4.0) {
    s_pol_diff = 1.0;
    reasons.push(`+ High polarimetric differential damping (ΔD = ${polDiffDamp.toFixed(2)} dB)`);
  } else if (polDiffDamp >= 1.5) {
    s_pol_diff = 0.5 + 0.5 * ((polDiffDamp - 1.5) / 2.5);
    reasons.push(`+ Positive polarimetric contrast (ΔD = ${polDiffDamp.toFixed(2)} dB)`);
  } else if (polDiffDamp >= 0) {
    s_pol_diff = 0.2 + 0.3 * (polDiffDamp / 1.5);
    reasons.push(`~ Neutral polarimetric contrast (ΔD = ${polDiffDamp.toFixed(2)} dB)`);
  } else {
    s_pol_diff = 0.05;
    reasons.push(`- Inverted polarimetric contrast (VH damped more than VV: ${polDiffDamp.toFixed(2)} dB)`);
  }

  // 5. VH Radiometric Level (0.0 to 1.0)
  // Oil slicks have very low VH backscatter (NESZ noise floor around -30 to -36 dB)
  let s_vh_level = 0;
  if (meanVh <= -32.0) {
    s_vh_level = 1.0;
    reasons.push(`+ Clean cross-pol suppression (${meanVh} dB)`);
  } else if (meanVh <= -28.0) {
    s_vh_level = 0.5 + 0.5 * ((-28.0 - meanVh) / 4.0);
    reasons.push(`~ Typical marine cross-pol level (${meanVh} dB)`);
  } else {
    s_vh_level = Math.max(0.1, 1.0 - (meanVh + 28.0) / 10.0);
    reasons.push(`- Elevated cross-pol backscatter (${meanVh} dB)`);
  }

  // 6. Boundary Gradient Sharpness (0.0 to 1.0)
  // Rewards sharp slick-water boundaries typical of mineral oil
  let s_grad = 0;
  if (gradMean >= 4.0) {
    s_grad = 1.0;
    reasons.push(`+ Sharp boundary contrast transition (${gradMean} dB/px)`);
  } else if (gradMean >= 2.5) {
    s_grad = 0.5 + 0.5 * ((gradMean - 2.5) / 1.5);
    reasons.push(`+ Distinct edge contrast (${gradMean} dB/px)`);
  } else if (gradMean >= 1.5) {
    s_grad = 0.2 + 0.3 * ((gradMean - 1.5) / 1.0);
    reasons.push(`~ Moderate edge transition (${gradMean} dB/px)`);
  } else {
    s_grad = 0.1;
    reasons.push(`- Diffuse/gradual boundary transition (${gradMean} dB/px)`);
  }

  // Weighted Composite Heuristic Score
  const compositeScore = Number((
    HEURISTIC_WEIGHTS.w_area * s_area +
    HEURISTIC_WEIGHTS.w_elong * s_elong +
    HEURISTIC_WEIGHTS.w_vv_damp * s_vv_damp +
    HEURISTIC_WEIGHTS.w_pol_diff * s_pol_diff +
    HEURISTIC_WEIGHTS.w_vh_level * s_vh_level +
    HEURISTIC_WEIGHTS.w_grad * s_grad
  ).toFixed(4));

  return {
    score: compositeScore,
    subScores: {
      area: Number(s_area.toFixed(3)),
      elongation: Number(s_elong.toFixed(3)),
      vvDamping: Number(s_vv_damp.toFixed(3)),
      polarimetricDiff: Number(s_pol_diff.toFixed(3)),
      vhLevel: Number(s_vh_level.toFixed(3)),
      boundaryGradient: Number(s_grad.toFixed(3)),
    },
    reasons,
  };
}

// ==============================================================================
// 3. MAIN SCORING & FILTERING PIPELINE
// ==============================================================================

async function runScoringPipeline() {
  console.log('================================================================');
  console.log('🎯   SAR DARK-SLICK CANDIDATE SCORING & FILTERING MODULE');
  console.log('================================================================\n');

  if (!fs.existsSync(FEATURES_JSON_PATH)) {
    throw new Error(`Candidate features not found at ${FEATURES_JSON_PATH}. Run extract-slick-features.js first.`);
  }

  const featDoc = JSON.parse(fs.readFileSync(FEATURES_JSON_PATH, 'utf-8'));
  const rawCandidates = featDoc.candidates;
  console.log(`📄 Loaded ${rawCandidates.length} Candidates from candidate_features.json\n`);

  console.log('🧮 Calculating Explainable Slick Candidate Scores...');
  const scoredCandidates = rawCandidates.map(c => {
    const scoring = computeCandidateScore(c);
    return {
      candidateId: c.candidateId,
      score: scoring.score,
      subScores: scoring.subScores,
      reasons: scoring.reasons,
      area: c.area,
      dimensions: c.dimensions,
      aspectRatio: c.aspectRatio,
      elongation: c.elongation,
      perimeter: c.perimeter,
      centroid: c.centroid,
      radiometryMean: c.radiometryMean,
      localContrast: c.localContrast,
      polarimetricDifference: c.polarimetricDifference,
      boundaryGradient: c.boundaryGradient,
      shapeDescriptors: c.shapeDescriptors,
      boundingBox: c.boundingBox,
      groundTruthEvaluation: c.groundTruthEvaluation,
      pixels: c.pixels,
    };
  });

  // Rank candidates descending by score
  scoredCandidates.sort((a, b) => b.score - a.score);

  // Assign ranks
  scoredCandidates.forEach((c, idx) => {
    c.rank = idx + 1;
  });

  // Score threshold distribution
  const thresholds = [0.70, 0.60, 0.50, 0.40, 0.30];
  const thresholdCounts = {};
  for (const t of thresholds) {
    thresholdCounts[`score_gte_${t.toFixed(2)}`] = scoredCandidates.filter(c => c.score >= t).length;
  }

  // Filter candidates using FILTER_THRESHOLD (0.50)
  const filteredCandidates = scoredCandidates.filter(c => c.score >= FILTER_THRESHOLD);

  // Ground Truth Candidate Analysis
  const gtCandidate = scoredCandidates.find(c => c.groundTruthEvaluation.overlapsGt);
  const highestScoring = scoredCandidates[0];

  console.log('================================================================');
  console.log('📊 CANDIDATE SCORING & FILTERING RESULTS');
  console.log('================================================================');
  console.log(`BEFORE FEATURE FILTERING: ${scoredCandidates.length} candidates`);
  console.log(`AFTER FEATURE FILTERING:  ${filteredCandidates.length} candidates (threshold >= ${FILTER_THRESHOLD})`);
  console.log(`REMOVED FALSE ALARMS:     ${scoredCandidates.length - filteredCandidates.length} (${(((scoredCandidates.length - filteredCandidates.length) / scoredCandidates.length) * 100).toFixed(1)}% reduction)\n`);

  console.log('THRESHOLD DISTRIBUTION:');
  for (const [k, count] of Object.entries(thresholdCounts)) {
    console.log(`  ${k}: ${count} candidates`);
  }
  console.log('');

  console.log('TOP 5 HIGHEST-SCORING CANDIDATES:');
  scoredCandidates.slice(0, 5).forEach(c => {
    const isGt = c.groundTruthEvaluation.overlapsGt ? ' [⭐ GROUND TRUTH]' : '';
    console.log(`  Rank #${c.rank}: ${c.candidateId} | Score: ${c.score.toFixed(4)}${isGt}`);
    console.log(`    Area: ${c.area.pixelArea} px | Elong: ${c.elongation.ratio} | VV Damp: ${c.localContrast.vvDampingDb} dB | ΔD: ${c.polarimetricDifference.meanVvMinusVhDb} dB`);
  });
  console.log('');

  if (gtCandidate) {
    console.log('GROUND-TRUTH CANDIDATE EVALUATION:');
    console.log(`  Candidate ID:     ${gtCandidate.candidateId}`);
    console.log(`  Score:            ${gtCandidate.score.toFixed(4)}`);
    console.log(`  Rank in Scene:    #${gtCandidate.rank} of ${scoredCandidates.length}`);
    console.log(`  Survives Filter:  ${gtCandidate.score >= FILTER_THRESHOLD ? 'YES (RETAINED)' : 'NO (DROPPED)'}`);
    console.log(`  Bounding-Box IoU: ${gtCandidate.groundTruthEvaluation.iou}`);
    console.log(`  Centroid Offset:  ${gtCandidate.groundTruthEvaluation.centroidDistPx} px`);
    console.log(`  Area:             ${gtCandidate.area.pixelArea} px (${gtCandidate.area.geoAreaM2} m²)`);
    console.log(`  Sub-Scores:`);
    console.log(`    - Area:         ${gtCandidate.subScores.area} (weight: ${HEURISTIC_WEIGHTS.w_area})`);
    console.log(`    - Elongation:   ${gtCandidate.subScores.elongation} (weight: ${HEURISTIC_WEIGHTS.w_elong})`);
    console.log(`    - VV Damping:   ${gtCandidate.subScores.vvDamping} (weight: ${HEURISTIC_WEIGHTS.w_vv_damp})`);
    console.log(`    - Pol Diff:     ${gtCandidate.subScores.polarimetricDiff} (weight: ${HEURISTIC_WEIGHTS.w_pol_diff})`);
    console.log(`    - VH Level:     ${gtCandidate.subScores.vhLevel} (weight: ${HEURISTIC_WEIGHTS.w_vh_level})`);
    console.log(`    - Boundary Grad:${gtCandidate.subScores.boundaryGradient} (weight: ${HEURISTIC_WEIGHTS.w_grad})`);
    console.log(`  Score Breakdown:`);
    gtCandidate.reasons.forEach(r => console.log(`    ${r}`));
  } else {
    console.log('⚠️ WARNING: Ground truth candidate was not identified in the set!');
  }
  console.log('================================================================\n');

  // ============================================================================
  // 4. GENERATE VISUAL OVERLAY (feature_filter_overlay.png)
  // ============================================================================
  console.log('🎨 Generating Visual Overlay with Filtered & Ranked Candidates...');
  const w = 512, h = 512;
  const vvLinear = readGeoTiffFloat32(CDSE_VV_PATH, w, h);
  const total = w * h;
  const rgb = Buffer.alloc(total * 3);

  const vvVals = [];
  for (let i = 0; i < total; i++) {
    if (vvLinear[i] > 0) vvVals.push(10 * Math.log10(vvLinear[i]));
  }
  vvVals.sort((a, b) => a - b);
  const p2 = vvVals[Math.floor(vvVals.length * 0.02)];
  const p98 = vvVals[Math.floor(vvVals.length * 0.98)];
  const pRange = Math.max(1.0, p98 - p2);

  for (let i = 0; i < total; i++) {
    if (vvLinear[i] > 0) {
      const db = 10 * Math.log10(vvLinear[i]);
      const clamped = Math.max(p2, Math.min(p98, db));
      const gray = Math.round(((clamped - p2) / pRange) * 255);
      rgb[i * 3] = gray;
      rgb[i * 3 + 1] = gray;
      rgb[i * 3 + 2] = gray;
    } else {
      rgb[i * 3] = 12;
      rgb[i * 3 + 1] = 18;
      rgb[i * 3 + 2] = 28;
    }
  }

  // Draw Ground Truth Box in Amber [255, 179, 0]
  const gb = [253, 237, 267, 282]; // CDSE bbox for ground truth
  drawRect(rgb, w, h, gb[0], gb[1], gb[2], gb[3], 255, 179, 0, false, 2);
  const gcx = Math.round((gb[0] + gb[2]) / 2);
  const gcy = Math.round((gb[1] + gb[3]) / 2);
  for (let d = -4; d <= 4; d++) {
    drawPixel(rgb, w, h, gcx + d, gcy, 255, 179, 0);
    drawPixel(rgb, w, h, gcx, gcy + d, 255, 179, 0);
  }
  drawText(rgb, w, h, Math.max(5, gb[0] - 2), Math.max(45, gb[1] - 11), 'GT (OIL)', 0, 0, 0, 255, 179, 0);

  // Draw Filtered Candidates
  // Ground truth / top candidates in Green [34, 197, 94], others in Cyan [0, 229, 255]
  for (const cand of filteredCandidates) {
    const isGt = cand.groundTruthEvaluation.overlapsGt;
    const isTop = cand.rank === 1;
    const color = isGt ? [34, 197, 94] : isTop ? [250, 204, 21] : [0, 229, 255];

    // Tint pixels
    for (const idx of cand.pixels) {
      const b = rgb[idx * 3];
      rgb[idx * 3] = Math.round(b * 0.35 + color[0] * 0.65);
      rgb[idx * 3 + 1] = Math.round(b * 0.35 + color[1] * 0.65);
      rgb[idx * 3 + 2] = Math.round(b * 0.35 + color[2] * 0.65);
    }

    const cb = [
      cand.boundingBox.cdse.xmin,
      cand.boundingBox.cdse.ymin,
      cand.boundingBox.cdse.xmax,
      cand.boundingBox.cdse.ymax,
    ];
    drawRect(rgb, w, h, cb[0] - 1, cb[1] - 1, cb[2] + 1, cb[3] + 1, color[0], color[1], color[2], false, 2);

    const ccx = Math.round(cand.centroid.cdse.x);
    const ccy = Math.round(cand.centroid.cdse.y);
    for (let d = -3; d <= 3; d++) {
      drawPixel(rgb, w, h, ccx + d, ccy, color[0], color[1], color[2]);
      drawPixel(rgb, w, h, ccx, ccy + d, color[0], color[1], color[2]);
    }

    // Label: Rank #X | Score 0.XX
    const labelX = Math.min(w - 95, Math.max(5, cb[2] + 3));
    const labelY = Math.min(h - 22, Math.max(44, cb[1]));
    const labelStr = `#${cand.rank} ${cand.candidateId} S:${cand.score.toFixed(2)}`;
    drawText(rgb, w, h, labelX, labelY, labelStr, 0, 0, 0, color[0], color[1], color[2]);
  }

  // Header Banner
  drawRect(rgb, w, h, 0, 0, w - 1, 40, 15, 23, 42, true);
  drawRect(rgb, w, h, 0, 40, w - 1, 41, 56, 189, 248, true);

  drawText(rgb, w, h, 8, 6, 'CANDIDATE FEATURE FILTER & RANKING OVERLAY', 255, 255, 255);
  drawText(
    rgb,
    w,
    h,
    8,
    17,
    `RAW: ${scoredCandidates.length} | FILTERED (>=${FILTER_THRESHOLD}): ${filteredCandidates.length} | GT RANK: #${gtCandidate ? gtCandidate.rank : 'N/A'} (S:${gtCandidate ? gtCandidate.score.toFixed(2) : 'N/A'})`,
    148,
    163,
    184
  );
  drawText(
    rgb,
    w,
    h,
    8,
    28,
    gtCandidate && gtCandidate.score >= FILTER_THRESHOLD
      ? 'OUTCOME: OIL SLICK SURVIVED FILTERING & RANKED HIGHLY'
      : 'OUTCOME: OIL SLICK DROPPED BY FILTER',
    gtCandidate && gtCandidate.score >= FILTER_THRESHOLD ? 34 : 248,
    gtCandidate && gtCandidate.score >= FILTER_THRESHOLD ? 197 : 113,
    gtCandidate && gtCandidate.score >= FILTER_THRESHOLD ? 94 : 113
  );

  // Footer Legend
  drawRect(rgb, w, h, 0, h - 20, w - 1, h - 1, 15, 23, 42, true);
  drawText(rgb, w, h, 8, h - 14, '[AMBER] GT BOX   [GREEN] GT OIL CANDIDATE   [CYAN] SURVIVING FILTERED CANDIDATES', 226, 232, 240);

  const overlayPngBuffer = encodeRgbPng(w, h, rgb);
  fs.writeFileSync(OUT_OVERLAY_PNG, overlayPngBuffer);
  console.log(`💾 Saved Visual Overlay: ${OUT_OVERLAY_PNG}`);

  // Save JSON Output
  const scoresOutputDoc = {
    metadata: {
      module: 'SAR Dark-Slick Candidate Scoring and Filtering',
      timestamp: new Date().toISOString(),
      benchmarkCase: 'DARTIS_2019 ow-0002',
      filterThreshold: FILTER_THRESHOLD,
      heuristicWeights: HEURISTIC_WEIGHTS,
      totalCandidatesBeforeFilter: scoredCandidates.length,
      totalCandidatesAfterFilter: filteredCandidates.length,
      falsePositiveReductionPercent: Number((((scoredCandidates.length - filteredCandidates.length) / scoredCandidates.length) * 100).toFixed(2)),
      thresholdDistribution: thresholdCounts,
      groundTruthEvaluation: {
        gtCandidateId: gtCandidate ? gtCandidate.candidateId : null,
        rank: gtCandidate ? gtCandidate.rank : null,
        score: gtCandidate ? gtCandidate.score : null,
        survivesFilter: Boolean(gtCandidate && gtCandidate.score >= FILTER_THRESHOLD),
        iou: gtCandidate ? gtCandidate.groundTruthEvaluation.iou : 0,
        centroidDistPx: gtCandidate ? gtCandidate.groundTruthEvaluation.centroidDistPx : null,
      },
    },
    rankedCandidates: scoredCandidates.map(c => ({
      rank: c.rank,
      candidateId: c.candidateId,
      score: c.score,
      survivesFilter: c.score >= FILTER_THRESHOLD,
      subScores: c.subScores,
      reasons: c.reasons,
      area: c.area,
      dimensions: c.dimensions,
      aspectRatio: c.aspectRatio,
      elongation: c.elongation,
      perimeter: c.perimeter,
      centroid: c.centroid,
      radiometryMean: c.radiometryMean,
      localContrast: c.localContrast,
      polarimetricDifference: c.polarimetricDifference,
      boundaryGradient: c.boundaryGradient,
      shapeDescriptors: c.shapeDescriptors,
      boundingBox: c.boundingBox,
      groundTruthEvaluation: c.groundTruthEvaluation,
    })),
  };

  fs.writeFileSync(OUT_SCORES_JSON, JSON.stringify(scoresOutputDoc, null, 2));
  console.log(`💾 Saved Candidate Scores JSON: ${OUT_SCORES_JSON}\n`);

  return scoresOutputDoc;
}

if (require.main === module) {
  runScoringPipeline().catch(err => {
    console.error('Fatal scoring error:', err);
    process.exit(1);
  });
}

module.exports = {
  runScoringPipeline,
  computeCandidateScore,
  HEURISTIC_WEIGHTS,
  FILTER_THRESHOLD,
};
