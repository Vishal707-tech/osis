const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config();

const {
  CDSE_PROCESS_URL,
  getAccessToken,
  getSentinel1GrdImage,
  parseTiffMetadata,
} = require('../src/services/sentinel.service');

// Target Scene Discovered in Catalog Step:
const SCENE_ID = 'S1A_IW_GRDH_1SDV_20240619T004837_20240619T004902_054385_069DE8_E3DA_COG.SAFE';
const ACQUISITION_TIME = '2024-06-19T00:48:37Z';

// Small test AOI (~0.08° x 0.08°) within the scene and target corridor
const REQUESTED_BBOX = [74.40, 13.98, 74.48, 14.06]; // [minLon, minLat, maxLon, maxLat]
const POLARIZATION = 'VV';
const OUTPUT_WIDTH = 512;
const OUTPUT_HEIGHT = 512;

// Output Directory and File Paths
const DATA_DIR = path.resolve(__dirname, '../data/sentinel-test');
const TIFF_FILE_NAME = 'sentinel1_vv_20240619.tif';
const METADATA_FILE_NAME = 'sentinel1_metadata.json';
const TIFF_FILE_PATH = path.join(DATA_DIR, TIFF_FILE_NAME);
const METADATA_FILE_PATH = path.join(DATA_DIR, METADATA_FILE_NAME);

async function runRetrieval() {
  console.log('================================================================');
  console.log('📡   COPERNICUS SENTINEL-1 PROCESS API RASTER RETRIEVAL');
  console.log('================================================================');
  console.log(`Process API Endpoint: ${CDSE_PROCESS_URL}`);
  console.log(`Target Scene ID:      ${SCENE_ID}`);
  console.log(`Acquisition Datetime: ${ACQUISITION_TIME}`);
  console.log(`Requested AOI Bbox:   [${REQUESTED_BBOX.join(', ')}] (WGS84)`);
  console.log(`Polarization:         ${POLARIZATION}`);
  console.log(`Requested Dimensions: ${OUTPUT_WIDTH} x ${OUTPUT_HEIGHT} px`);
  console.log(`Output Directory:     ${DATA_DIR}`);
  console.log('================================================================\n');

  // Ensure output directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created output directory: ${DATA_DIR}`);
  }

  // 1. Authenticate with Copernicus Data Space Ecosystem
  console.log('🔑 Step 1: Authenticating with CDSE OAuth2 Service...');
  try {
    const token = await getAccessToken();
    console.log(`✅ Authentication Successful! [Bearer token validated, length: ${token.length}]\n`);
  } catch (err) {
    console.error(`❌ Authentication Failed:`, err.message);
    process.exit(1);
  }

  // 2. Request raster from Sentinel Hub Process API
  console.log('🛰️ Step 2: Requesting Sentinel-1 GRD VV GeoTIFF from Process API...');
  let result;
  try {
    result = await getSentinel1GrdImage({
      bbox: REQUESTED_BBOX,
      from: '2024-06-19T00:00:00Z',
      to: '2024-06-19T23:59:59Z',
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      polarization: POLARIZATION,
    });
    console.log(`✅ Process API Response: HTTP ${result.status} OK`);
    console.log(`   Content-Type: ${result.contentType}`);
    console.log(`   Received Data Size: ${(result.buffer.length / 1024).toFixed(1)} KB (${result.buffer.length} bytes)\n`);
  } catch (err) {
    console.error(`❌ Process API Request Failed:`, err.message);
    process.exit(1);
  }

  // 3. Save GeoTIFF binary to disk
  console.log('💾 Step 3: Saving GeoTIFF raster to disk...');
  fs.writeFileSync(TIFF_FILE_PATH, result.buffer);
  const fileStats = fs.statSync(TIFF_FILE_PATH);
  console.log(`✅ GeoTIFF saved successfully:`);
  console.log(`   Path: ${TIFF_FILE_PATH}`);
  console.log(`   Size on Disk: ${fileStats.size} bytes\n`);

  // 4. Verify and Parse GeoTIFF metadata
  console.log('🔬 Step 4: Validating GeoTIFF Header and Raster Tags...');
  let tiffMeta;
  try {
    tiffMeta = parseTiffMetadata(result.buffer);
    console.log(`✅ GeoTIFF Raster Validated:`);
    console.log(`   Valid TIFF Format:    ${tiffMeta.isTiff}`);
    console.log(`   Endianness:           ${tiffMeta.endianness}`);
    console.log(`   Raster Width:         ${tiffMeta.width} px`);
    console.log(`   Raster Height:        ${tiffMeta.height} px`);
    console.log(`   Bits Per Sample:      ${tiffMeta.bitsPerSample} bits`);
    console.log(`   Samples Per Pixel:    ${tiffMeta.samplesPerPixel} (Single band VV)`);
    console.log(`   Sample Data Type:     ${tiffMeta.sampleFormat}`);
    console.log(`   Is GeoTIFF:           ${tiffMeta.isGeoTiff}`);
    console.log(`   Coordinate Reference: ${tiffMeta.crs}\n`);
  } catch (err) {
    console.error(`❌ TIFF Parsing Failed:`, err.message);
    process.exit(1);
  }

  // 5. Write Metadata JSON
  console.log('📝 Step 5: Generating Metadata JSON...');
  const metadata = {
    sceneId: SCENE_ID,
    acquisitionTime: ACQUISITION_TIME,
    polarization: POLARIZATION,
    requestedBbox: {
      minLongitude: REQUESTED_BBOX[0],
      minLatitude: REQUESTED_BBOX[1],
      maxLongitude: REQUESTED_BBOX[2],
      maxLatitude: REQUESTED_BBOX[3],
      crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    },
    outputDimensions: {
      width: tiffMeta.width,
      height: tiffMeta.height,
      units: 'pixels',
    },
    rasterDetails: {
      bitsPerSample: tiffMeta.bitsPerSample,
      samplesPerPixel: tiffMeta.samplesPerPixel,
      sampleFormat: tiffMeta.sampleFormat,
      endianness: tiffMeta.endianness,
      coordinateReferenceSystem: tiffMeta.crs,
      fileSizeBytes: fileStats.size,
    },
    outputFile: {
      fileName: TIFF_FILE_NAME,
      relativePath: `backend/data/sentinel-test/${TIFF_FILE_NAME}`,
      absolutePath: TIFF_FILE_PATH,
    },
    apiDetails: {
      endpoint: CDSE_PROCESS_URL,
      responseStatus: result.status,
      contentType: result.contentType,
      retrievedAt: new Date().toISOString(),
    },
  };

  fs.writeFileSync(METADATA_FILE_PATH, JSON.stringify(metadata, null, 2));
  console.log(`✅ Metadata JSON saved successfully:`);
  console.log(`   Path: ${METADATA_FILE_PATH}\n`);

  console.log('================================================================');
  console.log('🎉 SENTINEL-1 PROCESS API RETRIEVAL COMPLETED SUCCESSFULLY');
  console.log('================================================================');
}

runRetrieval().catch((err) => {
  console.error('Unhandled script error:', err);
  process.exit(1);
});
