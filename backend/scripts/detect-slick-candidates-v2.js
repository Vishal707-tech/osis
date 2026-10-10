/**
 * ==============================================================================
 * EXPERIMENTAL V2 CLASSICAL-CV SAR DARK-SLICK DETECTOR
 * ==============================================================================
 * Tests 3 targeted classical computer vision hypotheses designed to preserve
 * thin and elongated marine oil-slick structures against the DARTIS_2019
 * ground-truth benchmark (patch ow-0002):
 *
 * EXPERIMENT 1 — Minimal Morphology:
 *   Removes the aggressive 3x3 erosion/opening that destroys sub-3px thin slicks,
 *   using morphological closing to bridge gaps without pre-eroding filaments.
 *
 * EXPERIMENT 2 — Multi-Scale Adaptive Anomaly Detection:
 *   Evaluates local sea clutter across multiple spatial window radii:
 *   - Scale 1 (Narrow / Fine):   R = 7 px  (~240 m diameter)
 *   - Scale 2 (Medium):          R = 15 px (~520 m diameter)
 *   - Scale 3 (Broad / Ambient): R = 25 px (~880 m diameter)
 *
 * EXPERIMENT 3 — Directional Morphological Structuring:
 *   Applies oriented 1D linear structuring elements across 4 angles
 *   (0° horizontal, 90° vertical, 45° diagonal, 135° anti-diagonal) to connect
 *   and recover curvilinear trailing slicks without assuming orientation.
 *
 * NOTE: Operates on calibrated Sentinel-1 GRD data. Baseline detector
 * (detect-slick-candidates.js) is preserved completely unaltered.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// File paths
const VAL_DIR = path.resolve(__dirname, '../data/sentinel-test/validation');
const GT_XML_PATH = path.join(VAL_DIR, 'ow-0002.xml');
const GT_JPG_PATH = path.join(VAL_DIR, 'ow-0002.jpg');
const CDSE_VV_PATH = path.join(VAL_DIR, 's1a_20190104_vv_db.tif');
const CDSE_VH_PATH = path.join(VAL_DIR, 's1a_20190104_vh_db.tif');

// Visual outputs
const OUT_BASELINE_PNG = path.join(VAL_DIR, 'baseline_overlay.png');
const OUT_MORPHOLOGY_PNG = path.join(VAL_DIR, 'v2_morphology_overlay.png');
const OUT_MULTISCALE_PNG = path.join(VAL_DIR, 'v2_multiscale_overlay.png');
const OUT_DIRECTIONAL_PNG = path.join(VAL_DIR, 'v2_directional_overlay.png');
const OUT_COMPARISON_JSON = path.join(VAL_DIR, 'v2_comparison.json');

// Validation Scene Specifications (DARTIS_2019 ow-0002)
const SCENE_SPEC = {
  patchName: 'S1_20190104_155638_155818_VV_2',
  tag: 'ow-0002-01-000002',
  sceneId: 'S1A_IW_GRDH_1SDV_20190104T155703_20190104T155728_025330_02CD9D_42AF_COG.SAFE',
  acquisitionTime: '2019-01-04T15:56:38Z',
  patchWidth: 640,
  patchHeight: 640,
  corners: {
    ul: { lon: 31.9728158, lat: 31.6193082 },
    ur: { lon: 32.1061271, lat: 31.6387928 },
    br: { lon: 32.0826405, lat: 31.7541920 },
    bl: { lon: 31.9493293, lat: 31.7347075 },
  },
  aoiBbox: [31.949, 31.619, 32.106, 31.754],
  rasterWidth: 512,
  rasterHeight: 512,
};

// Core physical threshold parameters (UNCHANGED from baseline)
const PARAMS = {
  kSigma: 2.0,                 // Standard statistical confidence multiplier
  minDampingDb: 3.5,           // Minimum contrast/damping threshold (dB)
  minCandidatePixels: 10,      // Minimum cluster size threshold
  nodataDbThreshold: -9000.0,
  oceanMaxVhDb: -20.0,
  oceanMaxVvDb: -10.0,
};

// ==============================================================================
// 1. COORDINATE TRANSFORMATIONS
// ==============================================================================

function patchToGeo(px, py) {
  const { ul, ur, br, bl } = SCENE_SPEC.corners;
  const u = px / SCENE_SPEC.patchWidth;
  const v = py / SCENE_SPEC.patchHeight;

  const topLon = ul.lon + u * (ur.lon - ul.lon);
  const topLat = ul.lat + u * (ur.lat - ul.lat);
  const botLon = bl.lon + u * (br.lon - bl.lon);
  const botLat = bl.lat + u * (br.lat - bl.lat);

  return {
    lon: topLon + v * (botLon - topLon),
    lat: topLat + v * (botLat - topLat),
  };
}

function geoToPatch(lon, lat) {
  const { ul, ur, br, bl } = SCENE_SPEC.corners;
  let u = 0.5, v = 0.5;

  for (let iter = 0; iter < 15; iter++) {
    const topLon = ul.lon + u * (ur.lon - ul.lon);
    const topLat = ul.lat + u * (ur.lat - ul.lat);
    const botLon = bl.lon + u * (br.lon - bl.lon);
    const botLat = bl.lat + u * (br.lat - bl.lat);

    const curLon = topLon + v * (botLon - topLon);
    const curLat = topLat + v * (botLat - topLat);

    const fLon = curLon - lon;
    const fLat = curLat - lat;
    if (Math.abs(fLon) < 1e-8 && Math.abs(fLat) < 1e-8) break;

    const dLon_du = (ur.lon - ul.lon) + v * ((br.lon - bl.lon) - (ur.lon - ul.lon));
    const dLon_dv = botLon - topLon;
    const dLat_du = (ur.lat - ul.lat) + v * ((br.lat - bl.lat) - (ur.lat - ul.lat));
    const dLat_dv = botLat - topLat;

    const det = dLon_du * dLat_dv - dLon_dv * dLat_du;
    if (Math.abs(det) < 1e-12) break;

    u -= (fLon * dLat_dv - fLat * dLon_dv) / det;
    v -= (fLat * dLon_du - fLon * dLat_du) / det;
  }

  return {
    x: u * SCENE_SPEC.patchWidth,
    y: v * SCENE_SPEC.patchHeight,
  };
}

function geoToCdseRaster(lon, lat, bbox, w, h) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const x = ((lon - minLon) / (maxLon - minLon)) * w - 0.5;
  const y = ((maxLat - lat) / (maxLat - minLat)) * h - 0.5;
  return { x, y };
}

function cdseRasterToGeo(x, y, bbox, w, h) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lon = minLon + (x + 0.5) * (maxLon - minLon) / w;
  const lat = maxLat - (y + 0.5) * (maxLat - minLat) / h;
  return { lon, lat };
}

// ==============================================================================
// 2. PARSE PASCAL VOC XML GROUND TRUTH
// ==============================================================================

function loadGroundTruth(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf-8');
  const xmin = parseInt(xml.match(/<xmin>([^<]+)<\/xmin>/)[1], 10);
  const ymin = parseInt(xml.match(/<ymin>([^<]+)<\/ymin>/)[1], 10);
  const xmax = parseInt(xml.match(/<xmax>([^<]+)<\/xmax>/)[1], 10);
  const ymax = parseInt(xml.match(/<ymax>([^<]+)<\/ymax>/)[1], 10);

  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const area = (xmax - xmin) * (ymax - ymin);
  const geoC = patchToGeo(cx, cy);

  const geoTL = patchToGeo(xmin, ymin);
  const geoBR = patchToGeo(xmax, ymax);

  const W = SCENE_SPEC.rasterWidth;
  const H = SCENE_SPEC.rasterHeight;
  const cdseTL = geoToCdseRaster(Math.min(geoTL.lon, geoBR.lon), Math.max(geoTL.lat, geoBR.lat), SCENE_SPEC.aoiBbox, W, H);
  const cdseBR = geoToCdseRaster(Math.max(geoTL.lon, geoBR.lon), Math.min(geoTL.lat, geoBR.lat), SCENE_SPEC.aoiBbox, W, H);
  const cdseC = geoToCdseRaster(geoC.lon, geoC.lat, SCENE_SPEC.aoiBbox, W, H);

  return {
    patchBbox: [xmin, ymin, xmax, ymax],
    patchCentroid: { x: cx, y: cy },
    patchBoxArea: area,
    geoCentroid: geoC,
    cdseBbox: [
      Math.round(Math.min(cdseTL.x, cdseBR.x)),
      Math.round(Math.min(cdseTL.y, cdseBR.y)),
      Math.round(Math.max(cdseTL.x, cdseBR.x)),
      Math.round(Math.max(cdseTL.y, cdseBR.y)),
    ],
    cdseCentroid: { x: Number(cdseC.x.toFixed(2)), y: Number(cdseC.y.toFixed(2)) },
  };
}

// ==============================================================================
// 3. RASTER LOADER & PREPROCESSING
// ==============================================================================

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
// 4. INTEGRAL IMAGE ACCELERATOR
// ==============================================================================

class IntegralImage {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.stride = width + 1;
    this.countSat = new Int32Array((width + 1) * (height + 1));
    this.sumSat = new Float64Array((width + 1) * (height + 1));
    this.sqSat = new Float64Array((width + 1) * (height + 1));
  }

  build(data, maskValid) {
    const W = this.w;
    const H = this.h;
    const stride = this.stride;

    for (let y = 0; y < H; y++) {
      let rowCount = 0;
      let rowSum = 0;
      let rowSq = 0;

      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const isValid = maskValid[idx] === 1;
        const v = isValid ? data[idx] : 0;

        if (isValid) {
          rowCount += 1;
          rowSum += v;
          rowSq += v * v;
        }

        const currIdx = (y + 1) * stride + (x + 1);
        const topIdx = y * stride + (x + 1);

        this.countSat[currIdx] = this.countSat[topIdx] + rowCount;
        this.sumSat[currIdx] = this.sumSat[topIdx] + rowSum;
        this.sqSat[currIdx] = this.sqSat[topIdx] + rowSq;
      }
    }
  }

  getStats(x1, y1, x2, y2) {
    const stride = this.stride;
    const br = (y2 + 1) * stride + (x2 + 1);
    const tr = y1 * stride + (x2 + 1);
    const bl = (y2 + 1) * stride + x1;
    const tl = y1 * stride + x1;

    const count = this.countSat[br] - this.countSat[tr] - this.countSat[bl] + this.countSat[tl];
    const sum = this.sumSat[br] - this.sumSat[tr] - this.sumSat[bl] + this.sumSat[tl];
    const sq = this.sqSat[br] - this.sqSat[tr] - this.sqSat[bl] + this.sqSat[tl];

    if (count < 10) return { count, mean: 0, stdDev: 0 };

    const mean = sum / count;
    const variance = Math.max(0, (sq / count) - (mean * mean));
    return { count, mean, stdDev: Math.sqrt(variance) };
  }
}

// ==============================================================================
// 5. MORPHOLOGICAL OPERATIONS LIBRARY
// ==============================================================================

function erode3x3(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) { keep = 0; break; }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || mask[ny * w + nx] === 0) {
            keep = 0;
            break;
          }
        }
        if (!keep) break;
      }
      out[y * w + x] = keep;
    }
  }
  return out;
}

function dilate3x3(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 1) {
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            out[ny * w + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Directional linear morphological dilation and erosion
 * Offsets define the 1D structuring element kernel (e.g. length 5)
 */
function dilateDirectional(mask, w, h, offsets) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 1) {
        for (const [dx, dy] of offsets) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            out[ny * w + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

function erodeDirectional(mask, w, h, offsets) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = 1;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h || mask[ny * w + nx] === 0) {
          keep = 0;
          break;
        }
      }
      out[y * w + x] = keep;
    }
  }
  return out;
}

function closeDirectional(mask, w, h, offsets) {
  return erodeDirectional(dilateDirectional(mask, w, h, offsets), w, h, offsets);
}

// ==============================================================================
// 6. CONNECTED COMPONENT EXTRACTION & GEOMETRIC METRICS
// ==============================================================================

function extractComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  let cur = 0;
  const comps = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 1 && labels[idx] === 0) {
        cur++;
        const q = [idx];
        labels[idx] = cur;
        const pxs = [];

        while (q.length > 0) {
          const c = q.pop();
          pxs.push(c);
          const cy = Math.floor(c / w);
          const cx = c % w;

          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= w) continue;
              const nidx = ny * w + nx;
              if (mask[nidx] === 1 && labels[nidx] === 0) {
                labels[nidx] = cur;
                q.push(nidx);
              }
            }
          }
        }
        comps.push({ id: cur, pixels: pxs, size: pxs.length });
      }
    }
  }
  return comps;
}

function filterAndFormatCandidates(components, minPixels, w, h, gtInfo) {
  const candidates = [];
  let candidateIndex = 0;

  for (const comp of components) {
    if (comp.size < minPixels) continue;

    // Filter edge boundary touching pixels
    let touchesEdge = false;
    for (const idx of comp.pixels) {
      const px = idx % w;
      const py = Math.floor(idx / w);
      if (px === 0 || px === w - 1 || py === 0 || py === h - 1) {
        touchesEdge = true;
        break;
      }
    }
    if (touchesEdge) continue;

    candidateIndex++;
    const xs = comp.pixels.map(p => p % w);
    const ys = comp.pixels.map(p => Math.floor(p / w));
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    const meanX = xs.reduce((a, b) => a + b, 0) / comp.size;
    const meanY = ys.reduce((a, b) => a + b, 0) / comp.size;

    const geoC = cdseRasterToGeo(meanX, meanY, SCENE_SPEC.aoiBbox, w, h);
    const geoTL = cdseRasterToGeo(minX, minY, SCENE_SPEC.aoiBbox, w, h);
    const geoBR = cdseRasterToGeo(maxX, maxY, SCENE_SPEC.aoiBbox, w, h);

    // Map candidate to 640x640 patch coordinates for direct Pascal VOC comparison
    const patchC = geoToPatch(geoC.lon, geoC.lat);
    const patchP1 = geoToPatch(geoTL.lon, geoTL.lat);
    const patchP2 = geoToPatch(geoBR.lon, geoBR.lat);

    const patchMinX = Math.round(Math.min(patchP1.x, patchP2.x));
    const patchMaxX = Math.round(Math.max(patchP1.x, patchP2.x));
    const patchMinY = Math.round(Math.min(patchP1.y, patchP2.y));
    const patchMaxY = Math.round(Math.max(patchP1.y, patchP2.y));

    // Evaluate overlap with Ground Truth box in patch space
    const gt = gtInfo.patchBbox; // [309, 282, 340, 342]
    const interX1 = Math.max(patchMinX, gt[0]);
    const interY1 = Math.max(patchMinY, gt[1]);
    const interX2 = Math.min(patchMaxX, gt[2]);
    const interY2 = Math.min(patchMaxY, gt[3]);

    const interW = Math.max(0, interX2 - interX1);
    const interH = Math.max(0, interY2 - interY1);
    const intersectionArea = interW * interH;

    const candBoxArea = Math.max(1, (patchMaxX - patchMinX) * (patchMaxY - patchMinY));
    const gtBoxArea = gtInfo.patchBoxArea; // 1860
    const unionArea = candBoxArea + gtBoxArea - intersectionArea;
    const iou = Number((intersectionArea / unionArea).toFixed(4));

    // Centroid distance in patch pixels
    const dx = patchC.x - gtInfo.patchCentroid.x;
    const dy = patchC.y - gtInfo.patchCentroid.y;
    const centroidDistPx = Number(Math.sqrt(dx * dx + dy * dy).toFixed(2));

    candidates.push({
      candidateId: `DSC-${String(candidateIndex).padStart(3, '0')}`,
      pixelArea: comp.size,
      bboxCdse: [minX, minY, maxX, maxY],
      centroidCdse: { x: Number(meanX.toFixed(2)), y: Number(meanY.toFixed(2)) },
      patchBbox: [patchMinX, patchMinY, patchMaxX, patchMaxY],
      patchCentroid: { x: Number(patchC.x.toFixed(2)), y: Number(patchC.y.toFixed(2)) },
      patchBoxArea: candBoxArea,
      geoCentroid: { lon: Number(geoC.lon.toFixed(6)), lat: Number(geoC.lat.toFixed(6)) },
      overlapsGt: intersectionArea > 0,
      intersectionArea,
      iou,
      centroidDistPx,
      pixels: comp.pixels,
    });
  }

  return candidates;
}

// ==============================================================================
// 7. BITMAP RENDERING FOR OVERLAY PNG
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
  ':': [0, 12, 12, 0, 12, 12, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 12, 12, 8],
  '=': [0, 31, 0, 31, 0, 0, 0],
  '/': [1, 2, 4, 8, 16, 0, 0],
  '(': [6, 12, 8, 8, 8, 12, 6],
  ')': [12, 6, 2, 2, 2, 6, 12],
  '[': [14, 8, 8, 8, 8, 8, 14],
  ']': [14, 2, 2, 2, 2, 2, 14],
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

function renderOverlay(vvDb, oceanMask, candidates, gtInfo, versionTitle, outcomeStr, w, h) {
  const total = w * h;
  const rgb = Buffer.alloc(total * 3);

  const validVals = [];
  for (let i = 0; i < total; i++) {
    if (oceanMask[i] === 1) validVals.push(vvDb[i]);
  }
  validVals.sort((a, b) => a - b);
  const p2 = validVals[Math.floor(validVals.length * 0.02)];
  const p98 = validVals[Math.floor(validVals.length * 0.98)];
  const pRange = Math.max(1.0, p98 - p2);

  for (let i = 0; i < total; i++) {
    if (oceanMask[i] === 1) {
      const clamped = Math.max(p2, Math.min(p98, vvDb[i]));
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
  const gb = gtInfo.cdseBbox;
  drawRect(rgb, w, h, gb[0], gb[1], gb[2], gb[3], 255, 179, 0, false, 2);
  const gcx = Math.round(gtInfo.cdseCentroid.x);
  const gcy = Math.round(gtInfo.cdseCentroid.y);
  for (let d = -4; d <= 4; d++) {
    drawPixel(rgb, w, h, gcx + d, gcy, 255, 179, 0);
    drawPixel(rgb, w, h, gcx, gcy + d, 255, 179, 0);
  }
  drawText(rgb, w, h, Math.max(5, gb[0] - 2), Math.max(45, gb[1] - 11), 'GT (OIL)', 0, 0, 0, 255, 179, 0);

  // Draw Detected Candidates in Cyan [0, 229, 255]
  for (const cand of candidates) {
    for (const idx of cand.pixels) {
      const b = rgb[idx * 3];
      rgb[idx * 3] = Math.round(b * 0.35 + 0 * 0.65);
      rgb[idx * 3 + 1] = Math.round(b * 0.35 + 225 * 0.65);
      rgb[idx * 3 + 2] = Math.round(b * 0.35 + 255 * 0.65);
    }

    const cb = cand.bboxCdse;
    const color = cand.overlapsGt ? [34, 197, 94] : [0, 229, 255]; // Green if overlapping GT, cyan otherwise
    drawRect(rgb, w, h, cb[0] - 1, cb[1] - 1, cb[2] + 1, cb[3] + 1, color[0], color[1], color[2], false, 2);

    const ccx = Math.round(cand.centroidCdse.x);
    const ccy = Math.round(cand.centroidCdse.y);
    for (let d = -3; d <= 3; d++) {
      drawPixel(rgb, w, h, ccx + d, ccy, color[0], color[1], color[2]);
      drawPixel(rgb, w, h, ccx, ccy + d, color[0], color[1], color[2]);
    }

    const labelX = Math.min(w - 75, cb[2] + 3);
    const labelY = Math.min(h - 22, Math.max(44, cb[1]));
    drawText(rgb, w, h, labelX, labelY, cand.candidateId, 0, 0, 0, color[0], color[1], color[2]);
  }

  // Top Header Banner
  drawRect(rgb, w, h, 0, 0, w - 1, 40, 15, 23, 42, true);
  drawRect(rgb, w, h, 0, 40, w - 1, 41, 56, 189, 248, true);

  drawText(rgb, w, h, 8, 6, versionTitle, 255, 255, 255);
  drawText(rgb, w, h, 8, 17, `PATCH: OW-0002 | CANDIDATES: ${candidates.length} | GT: [309, 282, 340, 342]`, 148, 163, 184);

  const statusColor = outcomeStr.includes('POSITIVE')
    ? [34, 197, 94]
    : outcomeStr.includes('PARTIAL')
    ? [251, 146, 60]
    : [248, 113, 113];
  drawText(rgb, w, h, 8, 28, outcomeStr, statusColor[0], statusColor[1], statusColor[2]);

  // Bottom Legend
  drawRect(rgb, w, h, 0, h - 20, w - 1, h - 1, 15, 23, 42, true);
  drawText(rgb, w, h, 8, h - 14, '[AMBER] GROUND TRUTH BOX     [CYAN/GREEN] CANDIDATE DETECTION', 226, 232, 240);

  return encodeRgbPng(w, h, rgb);
}

// ==============================================================================
// 8. THE FOUR EXPERIMENTS
// ==============================================================================

/**
 * BASELINE DETECTOR:
 * R=25 (~880m), k=2.0, minDamping=3.5dB, 3x3 opening then 3x3 closing, minSize=10px.
 */
function runBaseline(vvDb, oceanMask, sat, w, h, gtInfo) {
  const R = 25;
  const rawDark = new Uint8Array(w * h);
  let rawCount = 0;

  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - R), y2 = Math.min(h - 1, y + R);
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (oceanMask[idx] === 0) continue;
      const x1 = Math.max(0, x - R), x2 = Math.min(w - 1, x + R);
      const stats = sat.getStats(x1, y1, x2, y2);
      if (stats.count < 20) continue;

      const damping = stats.mean - vvDb[idx];
      if (damping >= PARAMS.kSigma * stats.stdDev && damping >= PARAMS.minDampingDb) {
        rawDark[idx] = 1;
        rawCount++;
      }
    }
  }

  const rawComps = extractComponents(rawDark, w, h);
  const opened = dilate3x3(erode3x3(rawDark, w, h), w, h);
  const cleaned = erode3x3(dilate3x3(opened, w, h), w, h);
  const finalComps = extractComponents(cleaned, w, h);
  const candidates = filterAndFormatCandidates(finalComps, PARAMS.minCandidatePixels, w, h, gtInfo);

  return {
    rawDarkPixels: rawCount,
    rawRegionsCount: rawComps.length,
    cleanedRegionsCount: finalComps.length,
    candidates,
    cleanedMask: cleaned,
  };
}

/**
 * EXPERIMENT 1 — MINIMAL MORPHOLOGY:
 * Same R=25, k=2.0, minDamping=3.5dB.
 * Removes the aggressive 3x3 opening (erosion) that deletes thin filaments.
 * Uses 3x3 closing only (dilation then erosion) to bridge micro-gaps.
 */
function runExperiment1(vvDb, oceanMask, sat, w, h, gtInfo) {
  const R = 25;
  const rawDark = new Uint8Array(w * h);
  let rawCount = 0;

  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - R), y2 = Math.min(h - 1, y + R);
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (oceanMask[idx] === 0) continue;
      const x1 = Math.max(0, x - R), x2 = Math.min(w - 1, x + R);
      const stats = sat.getStats(x1, y1, x2, y2);
      if (stats.count < 20) continue;

      const damping = stats.mean - vvDb[idx];
      if (damping >= PARAMS.kSigma * stats.stdDev && damping >= PARAMS.minDampingDb) {
        rawDark[idx] = 1;
        rawCount++;
      }
    }
  }

  const rawComps = extractComponents(rawDark, w, h);
  // Minimal morphology: closing only (no destructive pre-erosion)
  const cleaned = erode3x3(dilate3x3(rawDark, w, h), w, h);
  const finalComps = extractComponents(cleaned, w, h);
  const candidates = filterAndFormatCandidates(finalComps, PARAMS.minCandidatePixels, w, h, gtInfo);

  return {
    rawDarkPixels: rawCount,
    rawRegionsCount: rawComps.length,
    cleanedRegionsCount: finalComps.length,
    candidates,
    cleanedMask: cleaned,
  };
}

/**
 * EXPERIMENT 2 — MULTI-SCALE DETECTION:
 * Evaluates local sea clutter across 3 physical scales:
 * - Scale 1: R = 7 px  (~240m diameter, narrow slick scale)
 * - Scale 2: R = 15 px (~520m diameter, medium slick scale)
 * - Scale 3: R = 25 px (~880m diameter, broad ambient scale)
 * Combines anomalies across scales via union, followed by minimal morphology.
 */
function runExperiment2(vvDb, oceanMask, sat, w, h, gtInfo) {
  const scales = [
    { name: 'narrow', R: 7, desc: '~240m' },
    { name: 'medium', R: 15, desc: '~520m' },
    { name: 'broad',  R: 25, desc: '~880m' },
  ];

  const rawDarkMulti = new Uint8Array(w * h);
  let rawCount = 0;

  for (const sc of scales) {
    const R = sc.R;
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - R), y2 = Math.min(h - 1, y + R);
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (oceanMask[idx] === 0) continue;
        const x1 = Math.max(0, x - R), x2 = Math.min(w - 1, x + R);
        const stats = sat.getStats(x1, y1, x2, y2);
        if (stats.count < 15) continue;

        const damping = stats.mean - vvDb[idx];
        if (damping >= PARAMS.kSigma * stats.stdDev && damping >= PARAMS.minDampingDb) {
          if (rawDarkMulti[idx] === 0) {
            rawDarkMulti[idx] = 1;
            rawCount++;
          }
        }
      }
    }
  }

  const rawComps = extractComponents(rawDarkMulti, w, h);
  // Closing to connect multi-scale fragments
  const cleaned = erode3x3(dilate3x3(rawDarkMulti, w, h), w, h);
  const finalComps = extractComponents(cleaned, w, h);
  const candidates = filterAndFormatCandidates(finalComps, PARAMS.minCandidatePixels, w, h, gtInfo);

  return {
    rawDarkPixels: rawCount,
    rawRegionsCount: rawComps.length,
    cleanedRegionsCount: finalComps.length,
    candidates,
    cleanedMask: cleaned,
    testedScales: scales,
  };
}

/**
 * EXPERIMENT 3 — DIRECTIONAL STRUCTURE:
 * Tests 1D linear structuring elements along 4 canonical orientations:
 * 0° (horizontal), 90° (vertical), 45° (diagonal), 135° (anti-diagonal)
 * Evaluates whether an elongated slick structure is preserved along any direction.
 */
function runExperiment3(vvDb, oceanMask, sat, w, h, gtInfo) {
  const R = 25;
  const rawDark = new Uint8Array(w * h);
  let rawCount = 0;

  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - R), y2 = Math.min(h - 1, y + R);
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (oceanMask[idx] === 0) continue;
      const x1 = Math.max(0, x - R), x2 = Math.min(w - 1, x + R);
      const stats = sat.getStats(x1, y1, x2, y2);
      if (stats.count < 20) continue;

      const damping = stats.mean - vvDb[idx];
      if (damping >= PARAMS.kSigma * stats.stdDev && damping >= PARAMS.minDampingDb) {
        rawDark[idx] = 1;
        rawCount++;
      }
    }
  }

  const rawComps = extractComponents(rawDark, w, h);

  // 4 Directional 5-pixel Linear Structuring Elements
  const dirKernels = [
    { angle: '0_deg_horizontal',  offsets: [[-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0]] },
    { angle: '90_deg_vertical',   offsets: [[0, -2], [0, -1], [0, 0], [0, 1], [0, 2]] },
    { angle: '45_deg_diagonal',   offsets: [[-2, -2], [-1, -1], [0, 0], [1, 1], [2, 2]] },
    { angle: '135_deg_antidiag',  offsets: [[-2, 2], [-1, 1], [0, 0], [1, -1], [2, -2]] },
  ];

  // Apply directional closing per orientation, then combine via union
  const unionDirectional = new Uint8Array(w * h);
  for (const k of dirKernels) {
    const closed = closeDirectional(rawDark, w, h, k.offsets);
    for (let i = 0; i < w * h; i++) {
      if (closed[i] === 1) unionDirectional[i] = 1;
    }
  }

  const finalComps = extractComponents(unionDirectional, w, h);
  const candidates = filterAndFormatCandidates(finalComps, PARAMS.minCandidatePixels, w, h, gtInfo);

  return {
    rawDarkPixels: rawCount,
    rawRegionsCount: rawComps.length,
    cleanedRegionsCount: finalComps.length,
    candidates,
    cleanedMask: unionDirectional,
    testedDirections: dirKernels.map(k => k.angle),
  };
}

// ==============================================================================
// 9. MAIN RUNNER & BENCHMARK COMPARISON
// ==============================================================================

async function main() {
  console.log('================================================================');
  console.log('🔬   SAR DARK-SLICK DETECTOR EXPERIMENTAL V2 BENCHMARK');
  console.log('================================================================\n');

  // 1. Load Ground Truth
  console.log('📄 Loading DARTIS_2019 Ground Truth XML (ow-0002)...');
  const gtInfo = loadGroundTruth(GT_XML_PATH);
  console.log(`   GT Patch Bounding Box: [${gtInfo.patchBbox.join(', ')}]`);
  console.log(`   GT Patch Area:         ${gtInfo.patchBoxArea} px²`);
  console.log(`   GT Patch Centroid:     (${gtInfo.patchCentroid.x}, ${gtInfo.patchCentroid.y})`);
  console.log(`   GT CDSE Bbox:          [${gtInfo.cdseBbox.join(', ')}]\n`);

  // 2. Load CDSE Calibrated Raster
  console.log('🛰️ Ingesting Calibrated Sentinel-1 GRD Rasters from CDSE...');
  const W = SCENE_SPEC.rasterWidth;
  const H = SCENE_SPEC.rasterHeight;
  const total = W * H;

  const vvLinear = readGeoTiffFloat32(CDSE_VV_PATH, W, H);
  const vvDb = new Float32Array(total);
  const oceanMask = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    if (vvLinear[i] > 0) {
      vvDb[i] = 10 * Math.log10(vvLinear[i]);
      oceanMask[i] = 1;
    } else {
      vvDb[i] = PARAMS.nodataDbThreshold;
    }
  }

  const sat = new IntegralImage(W, H);
  sat.build(vvDb, oceanMask);

  // --------------------------------------------------------------------------
  // RUN EXPERIMENT 0: CURRENT BASELINE DETECTOR
  // --------------------------------------------------------------------------
  console.log('🧪 Running Test 1: Current Baseline Detector (Unaltered)...');
  const resBaseline = runBaseline(vvDb, oceanMask, sat, W, H, gtInfo);
  const baselineBest = resBaseline.candidates.find(c => c.overlapsGt) || null;
  const baselineIoU = baselineBest ? baselineBest.iou : 0;
  const baselineStatus = baselineBest ? 'POSITIVE DETECTION' : 'MISSED DETECTION';

  fs.writeFileSync(
    OUT_BASELINE_PNG,
    renderOverlay(
      vvDb, oceanMask, resBaseline.candidates, gtInfo,
      'BASELINE DETECTOR (3x3 OPENING + CLOSING)',
      `OUTCOME: ${baselineStatus} | IoU: ${baselineIoU}`,
      W, H
    )
  );

  // --------------------------------------------------------------------------
  // RUN EXPERIMENT 1: MINIMAL MORPHOLOGY
  // --------------------------------------------------------------------------
  console.log('🧪 Running Test 2: Experiment 1 — Minimal Morphology (Closing Only)...');
  const resExp1 = runExperiment1(vvDb, oceanMask, sat, W, H, gtInfo);
  const exp1Overlaps = resExp1.candidates.filter(c => c.overlapsGt);
  const exp1Best = exp1Overlaps.length > 0
    ? exp1Overlaps.reduce((max, c) => c.iou > max.iou ? c : max, exp1Overlaps[0])
    : null;
  const exp1IoU = exp1Best ? exp1Best.iou : 0;
  const exp1Status = exp1Best ? 'POSITIVE DETECTION (SLICK RECOVERED)' : 'MISSED DETECTION';

  fs.writeFileSync(
    OUT_MORPHOLOGY_PNG,
    renderOverlay(
      vvDb, oceanMask, resExp1.candidates, gtInfo,
      'V2 EXP 1: MINIMAL MORPHOLOGY (CLOSING ONLY)',
      `OUTCOME: ${exp1Status} | BEST IoU: ${exp1IoU}`,
      W, H
    )
  );

  // --------------------------------------------------------------------------
  // RUN EXPERIMENT 2: MULTI-SCALE DETECTION
  // --------------------------------------------------------------------------
  console.log('🧪 Running Test 3: Experiment 2 — Multi-Scale Detection (R=7, 15, 25 px)...');
  const resExp2 = runExperiment2(vvDb, oceanMask, sat, W, H, gtInfo);
  const exp2Overlaps = resExp2.candidates.filter(c => c.overlapsGt);
  const exp2Best = exp2Overlaps.length > 0
    ? exp2Overlaps.reduce((max, c) => c.iou > max.iou ? c : max, exp2Overlaps[0])
    : null;
  const exp2IoU = exp2Best ? exp2Best.iou : 0;
  const exp2Status = exp2Best ? 'POSITIVE DETECTION (SLICK RECOVERED)' : 'MISSED DETECTION';

  fs.writeFileSync(
    OUT_MULTISCALE_PNG,
    renderOverlay(
      vvDb, oceanMask, resExp2.candidates, gtInfo,
      'V2 EXP 2: MULTI-SCALE DETECTION (R=7, 15, 25 PX)',
      `OUTCOME: ${exp2Status} | BEST IoU: ${exp2IoU}`,
      W, H
    )
  );

  // --------------------------------------------------------------------------
  // RUN EXPERIMENT 3: DIRECTIONAL STRUCTURE
  // --------------------------------------------------------------------------
  console.log('🧪 Running Test 4: Experiment 3 — Directional Morphology (0°, 45°, 90°, 135°)...');
  const resExp3 = runExperiment3(vvDb, oceanMask, sat, W, H, gtInfo);
  const exp3Overlaps = resExp3.candidates.filter(c => c.overlapsGt);
  const exp3Best = exp3Overlaps.length > 0
    ? exp3Overlaps.reduce((max, c) => c.iou > max.iou ? c : max, exp3Overlaps[0])
    : null;
  const exp3IoU = exp3Best ? exp3Best.iou : 0;
  const exp3Status = exp3Best ? 'POSITIVE DETECTION (SLICK RECOVERED)' : 'MISSED DETECTION';

  fs.writeFileSync(
    OUT_DIRECTIONAL_PNG,
    renderOverlay(
      vvDb, oceanMask, resExp3.candidates, gtInfo,
      'V2 EXP 3: DIRECTIONAL MORPHOLOGY (0°, 45°, 90°, 135°)',
      `OUTCOME: ${exp3Status} | BEST IoU: ${exp3IoU}`,
      W, H
    )
  );

  // --------------------------------------------------------------------------
  // COMPILE COMPARISON JSON
  // --------------------------------------------------------------------------
  const comparisonDocument = {
    testName: 'SAR Dark-Slick Classical-CV V2 Experiments Benchmark',
    timestamp: new Date().toISOString(),
    benchmarkCase: {
      dataset: 'DARTIS_2019 (ESSD 2025)',
      patch: SCENE_SPEC.patchName,
      groundTruthBoxPatch: gtInfo.patchBbox,
      groundTruthAreaPatch: gtInfo.patchBoxArea,
      groundTruthCentroidPatch: gtInfo.patchCentroid,
    },
    experiments: [
      {
        name: 'BASELINE',
        description: 'Original single-scale detector with aggressive 3x3 opening and 3x3 closing',
        localWindow: 'Radius = 25 px (~880m diameter)',
        morphology: '3x3 Opening (erosion then dilation) followed by 3x3 Closing',
        rawDarkPixels: resBaseline.rawDarkPixels,
        candidatesBeforeFilter: resBaseline.cleanedRegionsCount,
        candidatesAfterFilter: resBaseline.candidates.length,
        largestCandidateArea: resBaseline.candidates.reduce((max, c) => Math.max(max, c.pixelArea), 0),
        overlapsGroundTruth: Boolean(baselineBest),
        bestCandidateId: baselineBest ? baselineBest.candidateId : null,
        bestIoU: baselineIoU,
        candidateBboxPatch: baselineBest ? baselineBest.patchBbox : null,
        candidateCentroidPatch: baselineBest ? baselineBest.patchCentroid : null,
        centroidDistPx: baselineBest ? baselineBest.centroidDistPx : null,
        outcome: baselineStatus,
        overlayPng: OUT_BASELINE_PNG,
      },
      {
        name: 'V2_MINIMAL_MORPHOLOGY',
        description: 'Removed aggressive 3x3 erosion; retained 3x3 closing to bridge small gaps',
        localWindow: 'Radius = 25 px (~880m diameter)',
        morphology: '3x3 Closing only (dilation then erosion)',
        rawDarkPixels: resExp1.rawDarkPixels,
        candidatesBeforeFilter: resExp1.cleanedRegionsCount,
        candidatesAfterFilter: resExp1.candidates.length,
        largestCandidateArea: resExp1.candidates.reduce((max, c) => Math.max(max, c.pixelArea), 0),
        overlapsGroundTruth: Boolean(exp1Best),
        bestCandidateId: exp1Best ? exp1Best.candidateId : null,
        bestIoU: exp1IoU,
        candidateBboxPatch: exp1Best ? exp1Best.patchBbox : null,
        candidateCentroidPatch: exp1Best ? exp1Best.patchCentroid : null,
        centroidDistPx: exp1Best ? exp1Best.centroidDistPx : null,
        outcome: exp1Status,
        overlayPng: OUT_MORPHOLOGY_PNG,
      },
      {
        name: 'V2_MULTI_SCALE',
        description: 'Multi-scale adaptive anomaly detection across narrow (7px), medium (15px), and broad (25px) windows',
        localWindow: 'R in {7 px (~240m), 15 px (~520m), 25 px (~880m)}',
        morphology: 'Multi-scale union + 3x3 Closing',
        rawDarkPixels: resExp2.rawDarkPixels,
        candidatesBeforeFilter: resExp2.cleanedRegionsCount,
        candidatesAfterFilter: resExp2.candidates.length,
        largestCandidateArea: resExp2.candidates.reduce((max, c) => Math.max(max, c.pixelArea), 0),
        overlapsGroundTruth: Boolean(exp2Best),
        bestCandidateId: exp2Best ? exp2Best.candidateId : null,
        bestIoU: exp2IoU,
        candidateBboxPatch: exp2Best ? exp2Best.patchBbox : null,
        candidateCentroidPatch: exp2Best ? exp2Best.patchCentroid : null,
        centroidDistPx: exp2Best ? exp2Best.centroidDistPx : null,
        outcome: exp2Status,
        overlayPng: OUT_MULTISCALE_PNG,
      },
      {
        name: 'V2_DIRECTIONAL',
        description: 'Oriented linear structuring elements across 4 angles (0°, 45°, 90°, 135°) to preserve elongated slicks',
        localWindow: 'Radius = 25 px (~880m diameter)',
        morphology: 'Directional Closing with 5-pixel kernels at 0°, 45°, 90°, 135°',
        rawDarkPixels: resExp3.rawDarkPixels,
        candidatesBeforeFilter: resExp3.cleanedRegionsCount,
        candidatesAfterFilter: resExp3.candidates.length,
        largestCandidateArea: resExp3.candidates.reduce((max, c) => Math.max(max, c.pixelArea), 0),
        overlapsGroundTruth: Boolean(exp3Best),
        bestCandidateId: exp3Best ? exp3Best.candidateId : null,
        bestIoU: exp3IoU,
        candidateBboxPatch: exp3Best ? exp3Best.patchBbox : null,
        candidateCentroidPatch: exp3Best ? exp3Best.patchCentroid : null,
        centroidDistPx: exp3Best ? exp3Best.centroidDistPx : null,
        outcome: exp3Status,
        overlayPng: OUT_DIRECTIONAL_PNG,
      },
    ],
  };

  fs.writeFileSync(OUT_COMPARISON_JSON, JSON.stringify(comparisonDocument, null, 2));
  console.log(`\n💾 Saved Comparison JSON: ${OUT_COMPARISON_JSON}`);
  console.log(`🎨 Generated Overlays:`);
  console.log(`   - ${OUT_BASELINE_PNG}`);
  console.log(`   - ${OUT_MORPHOLOGY_PNG}`);
  console.log(`   - ${OUT_MULTISCALE_PNG}`);
  console.log(`   - ${OUT_DIRECTIONAL_PNG}\n`);

  // Terminal Summary
  console.log('================================================================');
  console.log('📊 EXPERIMENTAL V2 DETECTION COMPARISON SUMMARY');
  console.log('================================================================');

  console.log('BASELINE');
  console.log(`  Raw Dark Pixels:      ${resBaseline.rawDarkPixels}`);
  console.log(`  Candidates (Raw/Ret): ${resBaseline.cleanedRegionsCount} / ${resBaseline.candidates.length}`);
  console.log(`  Overlap with GT:      ${baselineBest ? 'YES' : 'NO'}`);
  console.log(`  IoU:                  ${baselineIoU}`);
  console.log(`  Outcome:              ${baselineStatus}\n`);

  console.log('V2 MINIMAL MORPHOLOGY');
  console.log(`  Raw Dark Pixels:      ${resExp1.rawDarkPixels}`);
  console.log(`  Candidates (Raw/Ret): ${resExp1.cleanedRegionsCount} / ${resExp1.candidates.length}`);
  console.log(`  Overlap with GT:      ${exp1Best ? 'YES (' + exp1Best.candidateId + ')' : 'NO'}`);
  console.log(`  IoU:                  ${exp1IoU}`);
  if (exp1Best) {
    console.log(`  Candidate Box:        [${exp1Best.patchBbox.join(', ')}]`);
    console.log(`  GT Box:               [${gtInfo.patchBbox.join(', ')}]`);
    console.log(`  Centroid Distance:    ${exp1Best.centroidDistPx} px`);
    console.log(`  Candidate Area:       ${exp1Best.pixelArea} px (in CDSE) / ${exp1Best.patchBoxArea} px² (box)`);
  }
  console.log(`  Outcome:              ${exp1Status}\n`);

  console.log('V2 MULTI-SCALE');
  console.log(`  Raw Dark Pixels:      ${resExp2.rawDarkPixels}`);
  console.log(`  Candidates (Raw/Ret): ${resExp2.cleanedRegionsCount} / ${resExp2.candidates.length}`);
  console.log(`  Overlap with GT:      ${exp2Best ? 'YES (' + exp2Best.candidateId + ')' : 'NO'}`);
  console.log(`  IoU:                  ${exp2IoU}`);
  if (exp2Best) {
    console.log(`  Candidate Box:        [${exp2Best.patchBbox.join(', ')}]`);
    console.log(`  GT Box:               [${gtInfo.patchBbox.join(', ')}]`);
    console.log(`  Centroid Distance:    ${exp2Best.centroidDistPx} px`);
    console.log(`  Candidate Area:       ${exp2Best.pixelArea} px (in CDSE) / ${exp2Best.patchBoxArea} px² (box)`);
  }
  console.log(`  Outcome:              ${exp2Status}\n`);

  console.log('V2 DIRECTIONAL');
  console.log(`  Raw Dark Pixels:      ${resExp3.rawDarkPixels}`);
  console.log(`  Candidates (Raw/Ret): ${resExp3.cleanedRegionsCount} / ${resExp3.candidates.length}`);
  console.log(`  Overlap with GT:      ${exp3Best ? 'YES (' + exp3Best.candidateId + ')' : 'NO'}`);
  console.log(`  IoU:                  ${exp3IoU}`);
  if (exp3Best) {
    console.log(`  Candidate Box:        [${exp3Best.patchBbox.join(', ')}]`);
    console.log(`  GT Box:               [${gtInfo.patchBbox.join(', ')}]`);
    console.log(`  Centroid Distance:    ${exp3Best.centroidDistPx} px`);
    console.log(`  Candidate Area:       ${exp3Best.pixelArea} px (in CDSE) / ${exp3Best.patchBoxArea} px² (box)`);
  }
  console.log(`  Outcome:              ${exp3Status}\n`);

  console.log('================================================================');

  return comparisonDocument;
}

main().catch(err => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
