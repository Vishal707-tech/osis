'use strict';

/**
 * ==============================================================================
 * Comprehensive Phase 4B Verification & Regression Test Suite
 * ==============================================================================
 */

const http = require('http');
const app = require('../src/app');
const pool = require('../src/config/db');
const { getSpillCharacterization } = require('../src/services/characterization.service');

function assert(condition, msg) {
  if (!condition) {
    throw new Error(`FAIL: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

async function runTests() {
  console.log('================================================================');
  console.log('🧪 O.S.I.S. PHASE 4B: SPILL CHARACTERIZATION TEST SUITE');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Spill ID 1 Characterization Integrity Checks
  // --------------------------------------------------------------------------
  console.log('Test 1: Spill ID 1 Full Characterization Verification');
  const sp1 = await getSpillCharacterization(1);

  assert(sp1.spillId === 1, 'spillId is 1');
  assert(sp1.formattedSpillId === 'SP-001', 'formattedSpillId is SP-001');

  // Basic Geometry Checks
  const g = sp1.geometry;
  assert(g.areaSqm > 0, `areaSqm (${g.areaSqm}) > 0`);
  assert(g.areaKm2 > 0, `areaKm2 (${g.areaKm2}) > 0`);
  assert(g.perimeterM > 0, `perimeterM (${g.perimeterM}) > 0`);
  assert(!isNaN(g.areaSqm) && isFinite(g.areaSqm), 'areaSqm is finite non-NaN');
  assert(!isNaN(g.perimeterM) && isFinite(g.perimeterM), 'perimeterM is finite non-NaN');

  // Centroid within Bounding Box
  const bbox = g.boundingBox;
  assert(bbox.minLat < bbox.maxLat, 'bbox minLat < maxLat');
  assert(bbox.minLon < bbox.maxLon, 'bbox minLon < maxLon');
  assert(g.centroid.lat >= bbox.minLat && g.centroid.lat <= bbox.maxLat, 'centroid.lat inside bbox');
  assert(g.centroid.lon >= bbox.minLon && g.centroid.lon <= bbox.maxLon, 'centroid.lon inside bbox');
  assert(bbox.minLat >= -90 && bbox.maxLat <= 90, 'bbox latitudes within WGS-84 [-90, 90]');
  assert(bbox.minLon >= -180 && bbox.maxLon <= 180, 'bbox longitudes within WGS-84 [-180, 180]');

  // Shape Metrics Checks
  const s = sp1.shape;
  assert(s.majorAxisM >= s.minorAxisM, `majorAxisM (${s.majorAxisM}) >= minorAxisM (${s.minorAxisM})`);
  assert(g.lengthM >= g.widthM, `lengthM (${g.lengthM}) >= widthM (${g.widthM})`);
  assert(s.elongation >= 1.0, `elongation (${s.elongation}) >= 1.0`);
  assert(s.orientationDeg >= 0 && s.orientationDeg < 180, `orientationDeg (${s.orientationDeg}) in [0, 180)`);
  assert(s.orientationConvention === 'degrees_clockwise_from_north', 'orientation convention documented');
  assert(s.compactness > 0 && s.compactness <= 1.0, `compactness (${s.compactness}) in (0, 1]`);
  assert(Array.isArray(s.convexHull) && s.convexHull.length >= 3, 'convexHull is valid ring array');

  // Age Checks
  const a = sp1.age;
  assert(a.estimatedHours === 7.5, 'estimatedHours matches DB (7.5)');
  assert(a.lowerHours === 6.0, 'lowerHours is 6.0 (0.8 * 7.5)');
  assert(a.upperHours === 9.0, 'upperHours is 9.0 (1.2 * 7.5)');
  assert(a.status === 'estimated', 'age status is estimated');

  // Detection Checks
  const d = sp1.detection;
  assert(d.confidence === 94, 'confidence is 94');
  assert(d.satelliteSource === 'Sentinel-1', 'satelliteSource is Sentinel-1');
  assert(d.status === 'active', 'status is active');

  console.log('\n----------------------------------------------------------------');

  // --------------------------------------------------------------------------
  // TEST 2: Multi-spill checks across DB (Spill 2, 3, 4)
  // --------------------------------------------------------------------------
  console.log('Test 2: Characterization across all database spills (ID 2, 3, 4)');
  for (const id of [2, 3, 4]) {
    const res = await getSpillCharacterization(id);
    assert(res.spillId === id, `Spill ${id} characterized`);
    assert(res.geometry.areaSqm > 0, `Spill ${id} area > 0 (${res.geometry.areaKm2} km²)`);
    assert(res.shape.majorAxisM >= res.shape.minorAxisM, `Spill ${id} major >= minor`);
    assert(res.shape.compactness > 0 && res.shape.compactness <= 1.0, `Spill ${id} compactness valid`);
    assert(res.age.status === 'estimated', `Spill ${id} age status estimated`);
  }

  console.log('\n----------------------------------------------------------------');

  // --------------------------------------------------------------------------
  // TEST 3: Edge Cases (via Python Standalone Engine)
  // --------------------------------------------------------------------------
  console.log('Test 3: Synthetic Edge Case Handling');
  const { execSync } = require('child_process');
  const pyScript = require('path').resolve(__dirname, 'characterize_spill.py');

  // 3a. Highly Elongated polygon (streak)
  console.log(' - Subtest 3a: Highly Elongated Streak Polygon');
  const streakPoly = JSON.stringify([
    [72.0, 15.0], [72.05, 15.001], [72.05, 15.002], [72.0, 15.001], [72.0, 15.0]
  ]);
  const streakOut = JSON.parse(execSync(`python "${pyScript}" --geojson "${streakPoly.replace(/"/g, '\\"')}" --spill-id 99`));
  assert(streakOut.shape.elongation > 5.0, `Elongated polygon has high elongation (${streakOut.shape.elongation})`);
  assert(streakOut.geometry.lengthM > streakOut.geometry.widthM * 5, 'Length > 5 * Width');
  assert(streakOut.shape.compactness < 0.3, `Elongated streak has low compactness (${streakOut.shape.compactness})`);

  // 3b. Very small polygon
  console.log(' - Subtest 3b: Very Small Polygon (~20m x ~20m)');
  const tinyPoly = JSON.stringify([
    [72.0, 15.0], [72.0002, 15.0], [72.0002, 15.0002], [72.0, 15.0002], [72.0, 15.0]
  ]);
  const tinyOut = JSON.parse(execSync(`python "${pyScript}" --geojson "${tinyPoly.replace(/"/g, '\\"')}"`));
  assert(tinyOut.geometry.areaSqm > 0, `Small polygon area computed (${tinyOut.geometry.areaSqm} m²)`);
  assert(tinyOut.shape.majorAxisM > 0, 'Small polygon major axis > 0');

  // 3c. Missing Age Handling (Graceful unknown)
  console.log(' - Subtest 3c: Spill with Missing Age');
  const noAgeOut = JSON.parse(execSync(`python "${pyScript}" --geojson "${tinyPoly.replace(/"/g, '\\"')}" --spill-id 88`));
  assert(noAgeOut.age.status === 'unknown', 'Missing age returns status: unknown');
  assert(noAgeOut.age.estimatedHours === null, 'estimatedHours is null');
  assert(noAgeOut.age.lowerHours === null, 'lowerHours is null');
  assert(noAgeOut.age.upperHours === null, 'upperHours is null');

  // 3d. Degenerate / self-closing repair
  console.log(' - Subtest 3d: Unclosed ring coordinate repair');
  const unclosed = JSON.stringify([
    [72.1, 15.1], [72.2, 15.1], [72.2, 15.2], [72.1, 15.2] // missing closing point
  ]);
  const unclosedOut = JSON.parse(execSync(`python "${pyScript}" --geojson "${unclosed.replace(/"/g, '\\"')}"`));
  assert(unclosedOut.metadata.geometryRepaired === true, 'Unclosed polygon safely repaired');
  assert(unclosedOut.geometry.areaSqm > 0, 'Area computed after closure repair');

  console.log('\n----------------------------------------------------------------');

  // --------------------------------------------------------------------------
  // TEST 4: HTTP API Endpoint Tests via Ephemeral Server
  // --------------------------------------------------------------------------
  console.log('Test 4: HTTP REST API Endpoints');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  // 4a. GET /api/spills/1/characterization
  const res1 = await fetch(`http://localhost:${port}/api/spills/1/characterization`);
  assert(res1.status === 200, 'GET /api/spills/1/characterization returned 200');
  const json1 = await res1.json();
  assert(json1.spillId === 1, 'HTTP response spillId is 1');

  // 4b. GET /api/spills/SP-001/characterization
  const res2 = await fetch(`http://localhost:${port}/api/spills/SP-001/characterization`);
  assert(res2.status === 200, 'GET /api/spills/SP-001/characterization returned 200');
  const json2 = await res2.json();
  assert(json2.formattedSpillId === 'SP-001', 'HTTP response formattedSpillId is SP-001');

  // 4c. Nonexistent spill (404)
  const res3 = await fetch(`http://localhost:${port}/api/spills/9999/characterization`);
  assert(res3.status === 404, 'GET /api/spills/9999/characterization returned 404');

  // 4d. Invalid ID (404/400)
  const res4 = await fetch(`http://localhost:${port}/api/spills/not-an-id/characterization`);
  assert(res4.status === 404 || res4.status === 400, 'GET /api/spills/not-an-id/characterization handled gracefully');

  server.close();
  console.log('\n----------------------------------------------------------------');

  // --------------------------------------------------------------------------
  // TEST 5: Phase 4A Regression Verification
  // --------------------------------------------------------------------------
  console.log('Test 5: Phase 4A Regression Verification');
  // 5a. Check GET /api/drift/1 returns latest completed hindcast
  const driftServer = http.createServer(app);
  await new Promise(resolve => driftServer.listen(0, resolve));
  const driftPort = driftServer.address().port;

  const driftRes = await fetch(`http://localhost:${driftPort}/api/drift/1`);
  assert(driftRes.status === 200, 'GET /api/drift/1 returned 200');
  const driftData = await driftRes.json();
  assert(driftData.spillId === 'SP-001', 'Drift data matches SP-001');
  assert(driftData.backward && driftData.backward.probableOrigin, 'Probable origin is present');
  assert(driftData.backward.trajectory.length > 0, `Backward trajectory has ${driftData.backward.trajectory.length} points`);
  console.log(`  ✓ Origin coordinate: (${driftData.backward.probableOrigin.latitude}, ${driftData.backward.probableOrigin.longitude})`);

  driftServer.close();

  console.log('\n================================================================');
  console.log('🎉 ALL PHASE 4B TESTS & PHASE 4A REGRESSION TESTS PASSED!');
  console.log('================================================================');
  await pool.end();
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
