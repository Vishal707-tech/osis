/**
 * ==============================================================================
 * DARTIS-2019 REPRESENTATIVE SUBSET PREPARATION
 * ==============================================================================
 * Downloads PANGAEA annotations and JPEG quicklooks, and retrieves calibrated
 * Sentinel-1 GRD VV + VH GeoTIFFs from Copernicus Data Space Ecosystem (CDSE).
 *
 * Targeted subset:
 *   - ow-0004 (Oil / Water - small localized slick)
 *   - ow-0006 (Oil / Water - large complex slick)
 *   - oc-0001 (Oil / Coast - coastal slick)
 *   - nw-0001 (No-oil / Water - look-alike)
 *   - nw-0002 (No-oil / Water - look-alike)
 *
 * Note: ow-0002 is already present and kept unchanged.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { getSentinel1GrdImage } = require('../src/services/sentinel.service');

const OUT_DIR = path.resolve(__dirname, '../data/sentinel-test/validation/dartis_subset');

const SUBSET_SPECS = [
  {
    id: 'ow-0004',
    type: 'oil',
    category: 'ow (oil/water)',
    date: '2019-01-10',
    aoiBbox: [31.104, 31.645, 31.261, 31.780],
    corners: {
      ul: { lon: 31.1283623, lat: 31.6449359 },
      ur: { lon: 31.2613575, lat: 31.6652193 },
      br: { lon: 31.2370198, lat: 31.7801461 },
      bl: { lon: 31.1040246, lat: 31.7598627 },
    },
    jpgUrl: 'https://download.pangaea.de/dataset/980773/files/ow-0004.jpg',
    xmlUrl: 'https://download.pangaea.de/dataset/980773/files/ow-0004.xml',
    sceneId: 'S1B_IW_GRDH_1SDV_20190110T155611_20190110T155635_014434_01ADED_1E1A.SAFE',
  },
  {
    id: 'ow-0006',
    type: 'oil',
    category: 'ow (oil/water)',
    date: '2019-01-11',
    aoiBbox: [32.392, 32.307, 32.551, 32.443],
    corners: {
      ul: { lon: 32.4171253, lat: 32.3066615 },
      ur: { lon: 32.5508189, lat: 32.3277158 },
      br: { lon: 32.5252986, lat: 32.4429257 },
      bl: { lon: 32.3916050, lat: 32.4218714 },
    },
    jpgUrl: 'https://download.pangaea.de/dataset/980773/files/ow-0006.jpg',
    xmlUrl: 'https://download.pangaea.de/dataset/980773/files/ow-0006.xml',
    sceneId: 'S1A_IW_GRDH_1SDV_20190111T154901_20190111T154926_025432_02D14A_4A63.SAFE',
  },
  {
    id: 'oc-0001',
    type: 'oil',
    category: 'oc (oil/coast)',
    date: '2019-01-01',
    aoiBbox: [35.704, 34.377, 35.869, 34.514],
    corners: {
      ul: { lon: 35.8685045, lat: 34.4925487 },
      ur: { lon: 35.7317538, lat: 34.5141162 },
      br: { lon: 35.7041327, lat: 34.3990599 },
      bl: { lon: 35.8408834, lat: 34.3774924 },
    },
    jpgUrl: 'https://download.pangaea.de/dataset/980773/files/oc-0001.jpg',
    xmlUrl: 'https://download.pangaea.de/dataset/980773/files/oc-0001.xml',
    sceneId: 'S1B_IW_GRDH_1SDV_20190101T034235_20190101T034300_014295_01A97E_458A.SAFE',
  },
  {
    id: 'nw-0001',
    type: 'look-alike',
    category: 'nw (no_oil/water)',
    date: '2019-01-01',
    aoiBbox: [33.298, 32.713, 33.457, 32.848],
    corners: {
      ul: { lon: 33.4572911, lat: 32.8277707 },
      ur: { lon: 33.3223862, lat: 32.8480599 },
      br: { lon: 33.2974959, lat: 32.7329049 },
      bl: { lon: 33.4324008, lat: 32.7126158 },
    },
    jpgUrl: 'https://download.pangaea.de/dataset/980773/files/nw-0001-00-000001.jpg',
    xmlUrl: null, // Confirmed no-oil lookalike
    sceneId: 'S1B_IW_GRDH_1SDV_20190101T034300_20190101T034325_014295_01A97E_39B8.SAFE',
  },
  {
    id: 'nw-0002',
    type: 'look-alike',
    category: 'nw (no_oil/water)',
    date: '2019-01-04',
    aoiBbox: [31.290, 34.050, 31.449, 34.186],
    corners: {
      ul: { lon: 31.3143719, lat: 34.0503416 },
      ur: { lon: 31.4487787, lat: 34.0706251 },
      br: { lon: 31.4240545, lat: 34.1860492 },
      bl: { lon: 31.2896478, lat: 34.1657657 },
    },
    jpgUrl: 'https://download.pangaea.de/dataset/980773/files/nw-0002-00-000002.jpg',
    xmlUrl: null, // Confirmed no-oil lookalike
    sceneId: 'S1A_IW_GRDH_1SDV_20190104T155728_20190104T155753_025330_02CD9D_B67E.SAFE',
  },
];

async function downloadPangaeaFile(url, destPath) {
  if (fs.existsSync(destPath)) {
    console.log(`   [Cache] ${path.basename(destPath)} already exists`);
    return;
  }
  console.log(`   [Download] ${url} -> ${path.basename(destPath)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

async function retrieveCdseChannel(spec, pol, destPath) {
  if (fs.existsSync(destPath)) {
    console.log(`   [Cache] ${path.basename(destPath)} already exists`);
    return;
  }
  console.log(`   [CDSE] Requesting ${spec.id} ${pol} (${spec.date})...`);
  const res = await getSentinel1GrdImage({
    bbox: spec.aoiBbox,
    from: `${spec.date}T00:00:00Z`,
    to: `${spec.date}T23:59:59Z`,
    width: 512,
    height: 512,
    polarization: pol,
  });
  if (res.status !== 200 || !res.buffer) {
    throw new Error(`Failed to retrieve ${pol} for ${spec.id}: status ${res.status}`);
  }
  fs.writeFileSync(destPath, res.buffer);
  console.log(`   [CDSE Saved] ${path.basename(destPath)} (${res.buffer.length} bytes)`);
}

async function main() {
  console.log('================================================================');
  console.log('📦 PREPARING DARTIS_2019 5-SCENE VALIDATION SUBSET');
  console.log('================================================================\n');

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const manifest = [];

  for (const spec of SUBSET_SPECS) {
    console.log(`\n▶ Processing Scene: ${spec.id} (${spec.category})`);

    const jpgPath = path.join(OUT_DIR, `${spec.id}.jpg`);
    const xmlPath = spec.xmlUrl ? path.join(OUT_DIR, `${spec.id}.xml`) : null;
    const vvPath = path.join(OUT_DIR, `${spec.id}_vv_db.tif`);
    const vhPath = path.join(OUT_DIR, `${spec.id}_vh_db.tif`);

    // 1. PANGAEA files
    await downloadPangaeaFile(spec.jpgUrl, jpgPath);
    if (spec.xmlUrl && xmlPath) {
      await downloadPangaeaFile(spec.xmlUrl, xmlPath);
    }

    // 2. CDSE rasters (512x512)
    await retrieveCdseChannel(spec, 'VV', vvPath);
    await retrieveCdseChannel(spec, 'VH', vhPath);

    manifest.push({
      id: spec.id,
      type: spec.type,
      category: spec.category,
      sceneId: spec.sceneId,
      date: spec.date,
      aoiBbox: spec.aoiBbox,
      corners: spec.corners,
      files: {
        jpg: jpgPath,
        xml: xmlPath,
        vv: vvPath,
        vh: vhPath,
      },
    });
  }

  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n✅ All 5 scenes prepared successfully!`);
  console.log(`   Manifest written to: ${manifestPath}\n`);
}

main().catch((err) => {
  console.error('Fatal error during preparation:', err);
  process.exit(1);
});
