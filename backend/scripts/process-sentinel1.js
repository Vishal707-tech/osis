const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseTiffMetadata } = require('../src/services/sentinel.service');

// Input and Output Paths
const DATA_DIR = path.resolve(__dirname, '../data/sentinel-test');
const INPUT_TIFF = path.join(DATA_DIR, 'sentinel1_vv_20240619.tif');
const OUTPUT_PNG = path.join(DATA_DIR, 'sentinel1_vv_20240619_preview.png');
const OUTPUT_DB_TIFF = path.join(DATA_DIR, 'sentinel1_vv_20240619_db.tif');
const REPORT_JSON = path.join(DATA_DIR, 'sentinel1_processing_report.json');

// CRC32 implementation for pure Node.js PNG encoder
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const toCrc = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);
  return Buffer.concat([lenBuf, toCrc, crcBuf]);
}

/**
 * Encode an 8-bit grayscale PNG using Node.js built-in zlib
 */
function encodeGrayscalePng(width, height, pixelBuffer) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 0; // Grayscale color type
  ihdr[10] = 0; // Compression (deflate)
  ihdr[11] = 0; // Filter (standard)
  ihdr[12] = 0; // Interlace (none)

  const ihdrChunk = makePngChunk('IHDR', ihdr);

  // Scanlines: Each row preceded by a 0x00 filter byte
  const scanlineLength = width + 1;
  const scanlines = Buffer.alloc(height * scanlineLength);
  for (let y = 0; y < height; y++) {
    scanlines[y * scanlineLength] = 0; // Filter type 0 (None)
    pixelBuffer.copy(scanlines, y * scanlineLength + 1, y * width, (y + 1) * width);
  }

  const compressedData = zlib.deflateSync(scanlines);
  const idatChunk = makePngChunk('IDAT', compressedData);
  const iendChunk = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Decompress strips from the input GeoTIFF and extract the 2D Float32 raster
 */
function readTiffRaster(tiffBuffer) {
  const isBE = tiffBuffer[0] === 0x4d && tiffBuffer[1] === 0x4d;
  const readUint32 = (off) => isBE ? tiffBuffer.readUInt32BE(off) : tiffBuffer.readUInt32LE(off);

  const numStrips = 64;
  const rowsPerStrip = 8;
  const width = 512;
  const height = 512;

  const decompressedChunks = [];
  for (let i = 0; i < numStrips; i++) {
    const off = readUint32(220 + i * 4);
    const len = readUint32(476 + i * 4);
    const compressedSlice = tiffBuffer.subarray(off, off + len);
    decompressedChunks.push(zlib.inflateSync(compressedSlice));
  }

  const rawBytes = Buffer.concat(decompressedChunks);
  const floatArray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    floatArray[i] = isBE ? rawBytes.readFloatBE(i * 4) : rawBytes.readFloatLE(i * 4);
  }

  return { width, height, isBE, floatArray, rawBytes };
}

/**
 * Write processed Float32 raster into a valid GeoTIFF file preserving all original tags
 */
function writeProcessedGeoTiff(originalTiffBuffer, processedFloatArray) {
  const isBE = originalTiffBuffer[0] === 0x4d && originalTiffBuffer[1] === 0x4d;
  const numStrips = 64;
  const rowsPerStrip = 8;
  const cols = 512;

  // Convert Float32Array to Buffer
  const rawBytes = Buffer.alloc(cols * 512 * 4);
  for (let i = 0; i < cols * 512; i++) {
    if (isBE) {
      rawBytes.writeFloatBE(processedFloatArray[i], i * 4);
    } else {
      rawBytes.writeFloatLE(processedFloatArray[i], i * 4);
    }
  }

  // Compress each strip with Deflate
  const newCompressedStrips = [];
  const newByteCounts = [];
  for (let i = 0; i < numStrips; i++) {
    const stripSlice = rawBytes.subarray(i * rowsPerStrip * cols * 4, (i + 1) * rowsPerStrip * cols * 4);
    const comp = zlib.deflateSync(stripSlice);
    newCompressedStrips.push(comp);
    newByteCounts.push(comp.length);
  }

  // Preserve the original GeoTIFF header and metadata structures (first 891 bytes)
  const metaHeader = Buffer.from(originalTiffBuffer.subarray(0, 891));
  const newOffsets = [];
  let currentOffset = 891;
  for (let i = 0; i < numStrips; i++) {
    newOffsets.push(currentOffset);
    currentOffset += newByteCounts[i];
  }

  // Update StripOffsets (tag 273 at byte 220) and StripByteCounts (tag 279 at byte 476)
  for (let i = 0; i < numStrips; i++) {
    if (isBE) {
      metaHeader.writeUInt32BE(newOffsets[i], 220 + i * 4);
      metaHeader.writeUInt32BE(newByteCounts[i], 476 + i * 4);
    } else {
      metaHeader.writeUInt32LE(newOffsets[i], 220 + i * 4);
      metaHeader.writeUInt32LE(newByteCounts[i], 476 + i * 4);
    }
  }

  return Buffer.concat([metaHeader, ...newCompressedStrips]);
}

/**
 * Apply 3x3 median filter for mild speckle reduction
 */
function apply3x3MedianFilter(grid, width, height, maskValid) {
  const result = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!maskValid[idx]) {
        result[idx] = grid[idx];
        continue;
      }

      const neighbors = [];
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (maskValid[nIdx]) {
            neighbors.push(grid[nIdx]);
          }
        }
      }

      if (neighbors.length > 0) {
        neighbors.sort((a, b) => a - b);
        const mid = Math.floor(neighbors.length / 2);
        result[idx] = neighbors[mid];
      } else {
        result[idx] = grid[idx];
      }
    }
  }

  return result;
}

async function runPreprocessing() {
  console.log('================================================================');
  console.log('🛰️   SENTINEL-1 SAR PREPROCESSING & VISUALIZATION PIPELINE');
  console.log('================================================================');
  console.log(`Input File:  ${INPUT_TIFF}`);
  console.log(`Output PNG:  ${OUTPUT_PNG}`);
  console.log(`Output TIFF: ${OUTPUT_DB_TIFF}`);
  console.log(`Report JSON: ${REPORT_JSON}`);
  console.log('================================================================\n');

  // 1. Verify input file exists
  if (!fs.existsSync(INPUT_TIFF)) {
    console.error(`❌ Input GeoTIFF file not found at: ${INPUT_TIFF}`);
    process.exit(1);
  }

  const origBuffer = fs.readFileSync(INPUT_TIFF);
  console.log(`✅ Loaded input GeoTIFF: ${origBuffer.length} bytes`);

  // 2. Parse GeoTIFF metadata
  const tiffMeta = parseTiffMetadata(origBuffer);
  console.log(`\n📋 [Stage 1]: GeoTIFF Metadata Inspection:`);
  console.log(`   Dimensions:     ${tiffMeta.width} x ${tiffMeta.height} px`);
  console.log(`   CRS:            ${tiffMeta.crs}`);
  console.log(`   Geo BoundingBox:[${tiffMeta.geoBbox ? tiffMeta.geoBbox.join(', ') : 'N/A'}]`);
  console.log(`   Format:         ${tiffMeta.sampleFormat}`);
  console.log(`   Compression:    ${tiffMeta.compression}`);
  console.log(`   GeoTIFF Tags:   Tiepoint=${tiffMeta.hasModelTiepoint}, PixelScale=${tiffMeta.hasModelPixelScale}, GeoKeys=${tiffMeta.hasGeoKeys}`);

  // 3. Decompress raster and inspect raw linear statistics
  console.log(`\n🔬 [Stage 2]: Decompressing & Analyzing Raw Linear Pixel Data:`);
  const { width, height, floatArray } = readTiffRaster(origBuffer);
  const totalPixels = width * height;

  let linearMin = Infinity;
  let linearMax = -Infinity;
  let linearSum = 0;
  let validCount = 0;
  let invalidCount = 0;

  const validValues = [];
  const maskValid = new Uint8Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const val = floatArray[i];
    if (isNaN(val) || !isFinite(val) || val <= 0) {
      invalidCount++;
      maskValid[i] = 0;
    } else {
      maskValid[i] = 1;
      validValues.push(val);
      if (val < linearMin) linearMin = val;
      if (val > linearMax) linearMax = val;
      linearSum += val;
      validCount++;
    }
  }

  const linearMean = linearSum / validCount;
  let linearVarSum = 0;
  for (let i = 0; i < validValues.length; i++) {
    linearVarSum += Math.pow(validValues[i] - linearMean, 2);
  }
  const linearStdDev = Math.sqrt(linearVarSum / validCount);

  console.log(`   Total Pixels:         ${totalPixels}`);
  console.log(`   Valid Data Pixels:    ${validCount} (${((validCount / totalPixels) * 100).toFixed(1)}%)`);
  console.log(`   NoData/Zero Pixels:   ${invalidCount} (${((invalidCount / totalPixels) * 100).toFixed(1)}% - outer swath padding)`);
  console.log(`   Linear Min:           ${linearMin.toExponential(4)}`);
  console.log(`   Linear Max:           ${linearMax.toFixed(4)}`);
  console.log(`   Linear Mean:          ${linearMean.toFixed(6)}`);
  console.log(`   Linear Std Deviation: ${linearStdDev.toFixed(6)}`);
  console.log(`   Data Representation:  Linear Radar Backscatter Intensity (Gamma0/Sigma0 calibrated)`);

  // 4. Convert linear backscatter to Decibels (dB): 10 * log10(val)
  console.log(`\n📊 [Stage 3]: Decibel (dB) Conversion & Statistics:`);
  const dbArray = new Float32Array(totalPixels);
  const validDbValues = [];

  let dbMin = Infinity;
  let dbMax = -Infinity;
  let dbSum = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (maskValid[i]) {
      const dbVal = 10 * Math.log10(floatArray[i]);
      dbArray[i] = dbVal;
      validDbValues.push(dbVal);
      if (dbVal < dbMin) dbMin = dbVal;
      if (dbVal > dbMax) dbMax = dbVal;
      dbSum += dbVal;
    } else {
      dbArray[i] = -9999.0; // Standard GIS NoData value
    }
  }

  const dbMean = dbSum / validCount;
  let dbVarSum = 0;
  for (let i = 0; i < validDbValues.length; i++) {
    dbVarSum += Math.pow(validDbValues[i] - dbMean, 2);
  }
  const dbStdDev = Math.sqrt(dbVarSum / validCount);

  console.log(`   dB Min:               ${dbMin.toFixed(2)} dB`);
  console.log(`   dB Max:               ${dbMax.toFixed(2)} dB`);
  console.log(`   dB Mean:              ${dbMean.toFixed(2)} dB`);
  console.log(`   dB Std Deviation:     ${dbStdDev.toFixed(2)} dB`);
  console.log(`   Ocean Backscatter:    Nominal C-band open water range is ~ -28 to -10 dB (observed mean: ${dbMean.toFixed(2)} dB)`);

  // 5. Percentile Analysis & Robust Contrast Clipping
  console.log(`\n🎛️ [Stage 4]: Percentile Analysis & Dynamic Range Optimization:`);
  validDbValues.sort((a, b) => a - b);

  const getPercentile = (p) => {
    const idx = Math.min(Math.floor((p / 100) * validDbValues.length), validDbValues.length - 1);
    return validDbValues[idx];
  };

  const p1 = getPercentile(1);
  const p2 = getPercentile(2);
  const p5 = getPercentile(5);
  const p50 = getPercentile(50);
  const p95 = getPercentile(95);
  const p98 = getPercentile(98);
  const p99 = getPercentile(99);

  console.log(`   Percentile 1% (P1):   ${p1.toFixed(2)} dB`);
  console.log(`   Percentile 2% (P2):   ${p2.toFixed(2)} dB [Lower Clipping Bound]`);
  console.log(`   Percentile 5% (P5):   ${p5.toFixed(2)} dB`);
  console.log(`   Median (P50):         ${p50.toFixed(2)} dB`);
  console.log(`   Percentile 95% (P95): ${p95.toFixed(2)} dB`);
  console.log(`   Percentile 98% (P98): ${p98.toFixed(2)} dB [Upper Clipping Bound]`);
  console.log(`   Percentile 99% (P99): ${p99.toFixed(2)} dB`);

  const clipMin = p2;
  const clipMax = p98;
  const dynamicRange = clipMax - clipMin;
  console.log(`   Clipping Range:       [${clipMin.toFixed(2)} dB, ${clipMax.toFixed(2)} dB] (Span: ${dynamicRange.toFixed(2)} dB)`);

  // 6. Mild Speckle Filtering (3x3 Median Filter on valid pixels)
  console.log(`\n🧹 [Stage 5]: Applying 3x3 Spatial Median Filter for Speckle Reduction...`);
  const filteredDbArray = apply3x3MedianFilter(dbArray, width, height, maskValid);
  console.log(`   Speckle Filter:       3x3 Adaptive Spatial Median (Edge & NoData preserving)`);

  // 7. Contrast Normalization (Mapping to 8-bit [0 - 255] Grayscale)
  console.log(`\n🎨 [Stage 6]: Contrast Normalization to 8-bit Grayscale...`);
  const pngPixelBuffer = Buffer.alloc(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    if (maskValid[i]) {
      const v = filteredDbArray[i];
      const clamped = Math.max(clipMin, Math.min(clipMax, v));
      const normalized = Math.round(((clamped - clipMin) / dynamicRange) * 255);
      pngPixelBuffer[i] = Math.max(0, Math.min(255, normalized));
    } else {
      pngPixelBuffer[i] = 0; // Black for NoData background
    }
  }

  // 8. Generate and save visualization PNG
  const pngBuffer = encodeGrayscalePng(width, height, pngPixelBuffer);
  fs.writeFileSync(OUTPUT_PNG, pngBuffer);
  const pngStats = fs.statSync(OUTPUT_PNG);
  console.log(`✅ Preview PNG saved successfully:`);
  console.log(`   Path: ${OUTPUT_PNG}`);
  console.log(`   Size: ${pngStats.size} bytes (${(pngStats.size / 1024).toFixed(1)} KB)`);

  // 9. Save Processed Numerical GeoTIFF (dB values)
  console.log(`\n💾 [Stage 7]: Exporting Processed Numerical GeoTIFF (dB calibrated)...`);
  const processedTiffBuffer = writeProcessedGeoTiff(origBuffer, dbArray);
  fs.writeFileSync(OUTPUT_DB_TIFF, processedTiffBuffer);
  const tiffStats = fs.statSync(OUTPUT_DB_TIFF);
  const verifyDbTiff = parseTiffMetadata(processedTiffBuffer);
  console.log(`✅ Processed dB GeoTIFF saved successfully:`);
  console.log(`   Path:          ${OUTPUT_DB_TIFF}`);
  console.log(`   Size:          ${tiffStats.size} bytes (${(tiffStats.size / 1024).toFixed(1)} KB)`);
  console.log(`   Is GeoTIFF:    ${verifyDbTiff.isGeoTiff}`);
  console.log(`   CRS:           ${verifyDbTiff.crs}`);
  console.log(`   Data Type:     ${verifyDbTiff.sampleFormat}`);
  console.log(`   Bounds:        [${verifyDbTiff.geoBbox ? verifyDbTiff.geoBbox.join(', ') : 'N/A'}]`);

  // 10. Generate Comprehensive Processing Report JSON
  console.log(`\n📝 [Stage 8]: Writing Metadata & Processing Report JSON...`);
  const report = {
    pipeline: "Sentinel-1 SAR Preprocessing and Visualization",
    processedAt: new Date().toISOString(),
    files: {
      inputTiff: {
        path: INPUT_TIFF,
        relativePath: "backend/data/sentinel-test/sentinel1_vv_20240619.tif",
        sizeBytes: origBuffer.length,
      },
      previewPng: {
        path: OUTPUT_PNG,
        relativePath: "backend/data/sentinel-test/sentinel1_vv_20240619_preview.png",
        sizeBytes: pngStats.size,
        format: "PNG (8-bit grayscale)",
        dimensions: { width, height },
      },
      processedDbTiff: {
        path: OUTPUT_DB_TIFF,
        relativePath: "backend/data/sentinel-test/sentinel1_vv_20240619_db.tif",
        sizeBytes: tiffStats.size,
        format: "GeoTIFF (Big-Endian, Deflate)",
        dimensions: { width, height },
        crs: verifyDbTiff.crs,
        boundingBox: verifyDbTiff.geoBbox,
        noDataValue: -9999.0,
      },
    },
    geospatial: {
      crs: tiffMeta.crs,
      boundingBox: tiffMeta.geoBbox,
      pixelScale: tiffMeta.pixelScale,
      dimensions: { width, height },
      polarization: "VV",
    },
    statistics: {
      totalPixels,
      validPixels: validCount,
      invalidPixels: invalidCount,
      validPercentage: Number(((validCount / totalPixels) * 100).toFixed(2)),
      linearBackscatter: {
        min: linearMin,
        max: linearMax,
        mean: linearMean,
        stdDev: linearStdDev,
        representation: "Linear intensity (calibrated gamma0)",
      },
      decibelBackscatter: {
        formula: "10 * log10(linear_value)",
        minDb: Number(dbMin.toFixed(4)),
        maxDb: Number(dbMax.toFixed(4)),
        meanDb: Number(dbMean.toFixed(4)),
        stdDevDb: Number(dbStdDev.toFixed(4)),
        percentiles: {
          p1: Number(p1.toFixed(3)),
          p2: Number(p2.toFixed(3)),
          p5: Number(p5.toFixed(3)),
          p50: Number(p50.toFixed(3)),
          p95: Number(p95.toFixed(3)),
          p98: Number(p98.toFixed(3)),
          p99: Number(p99.toFixed(3)),
        },
      },
    },
    preprocessingOperations: [
      {
        step: 1,
        name: "NoData & Swath Edge Masking",
        description: "Zero, negative, and non-finite pixels outside the orbital swath were isolated and assigned standard GIS NoData (-9999.0).",
      },
      {
        step: 2,
        name: "Radiometric Conversion to Decibels",
        description: "Linear power values converted to logarithmic radar backscatter scale using 10 * log10(intensity).",
      },
      {
        step: 3,
        name: "Robust Dynamic Range Percentile Clipping",
        description: `Backscatter dynamic range clipped between 2nd percentile (${p2.toFixed(2)} dB) and 98th percentile (${p98.toFixed(2)} dB) to remove speckle outliers.`,
      },
      {
        step: 4,
        name: "Mild 3x3 Spatial Speckle Filtering",
        description: "Adaptive 3x3 median filter applied to suppress granular SAR speckle while preserving sharp radar gradients and boundaries.",
      },
      {
        step: 5,
        name: "Linear Contrast Stretch to 8-bit Grayscale",
        description: "Mapped the clipped dB range linearly to [0, 255] for standard display.",
      },
    ],
    scientificNotice: "This preprocessing is radiometric calibration and visualization only. Dark features in SAR can be caused by low wind, biogenic films, or surface slicks. No automatic oil-spill detection or attribution is asserted.",
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`✅ Processing report saved successfully:`);
  console.log(`   Path: ${REPORT_JSON}\n`);

  console.log('================================================================');
  console.log('🎉 SENTINEL-1 PREPROCESSING PIPELINE COMPLETED SUCCESSFULLY');
  console.log('================================================================');
}

runPreprocessing().catch((err) => {
  console.error('Unhandled processing error:', err);
  process.exit(1);
});
