'use strict';
/**
 * worker-failure-recovery.test.js
 * ================================
 * Day 6 Task 3 — Focused tests for:
 *   a. Stale processing scene → queued (retry_count incremented)
 *   b. Stale scene at retry limit → failed (retry_count reaches 3)
 *   c. Detection error is persisted in error_message as [detection_failed] <msg>
 *   d. Worker remains usable after a failed scene
 *   e. POST /api/worker/recover-stale HTTP endpoint
 *
 * Uses Node's built-in test runner: node --test tests/worker-failure-recovery.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');
const worker = require('../src/services/scene-worker.service');
const sentinel = require('../src/services/sentinel.service');
const incidentService = require('../src/services/incident.service');
const app = require('../src/app');

let server;
let baseUrl;

// Ephemeral HTTP server for route testing
const ready = new Promise((resolve) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    resolve();
  });
});

async function postJson(endpointPath, payload = {}) {
  await ready;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const opts = new URL(baseUrl + endpointPath);
    const req = http.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ statusCode: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function cleanupTestScenes() {
  await pool.query("DELETE FROM processed_scenes WHERE scene_id LIKE 'test_rec_%'");
}

beforeEach(async () => {
  await cleanupTestScenes();
});

// ---------------------------------------------------------------------------
// Test A: Stale processing scene -> queued (retry_count incremented)
// ---------------------------------------------------------------------------
test('stale processing scene resets to queued and increments retry_count', async () => {
  const sceneId = 'test_rec_stale_to_queued';
  await pool.query(
    `INSERT INTO processed_scenes (
       scene_id, collection, status, processing_at, retry_count, worker_id, error_message
     ) VALUES ($1, 'sentinel-1-grd', 'processing', NOW() - INTERVAL '15 minutes', 0, 'worker-prev-dead', 'initial error')
     ON CONFLICT (scene_id, collection) DO UPDATE
       SET status = 'processing', processing_at = NOW() - INTERVAL '15 minutes', retry_count = 0, worker_id = 'worker-prev-dead'`,
    [sceneId]
  );

  const { recovered, failed } = await worker.recoverStaleScenes();
  assert.ok(recovered >= 1, `Expected at least 1 recovered scene, got ${recovered}`);

  const { rows } = await pool.query(
    'SELECT status, retry_count, processing_at, worker_id, error_message FROM processed_scenes WHERE scene_id = $1',
    [sceneId]
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'queued', 'Scene should have returned to queued status');
  assert.equal(row.retry_count, 1, 'retry_count should have incremented from 0 to 1');
  assert.equal(row.processing_at, null, 'processing_at should be reset to null');
  assert.equal(row.worker_id, null, 'worker_id should be reset to null');
  assert.match(row.error_message, /\[reset: stale processing recovered\]/, 'error_message should record recovery attempt');
});

// ---------------------------------------------------------------------------
// Test B: Stale scene at retry limit -> failed
// ---------------------------------------------------------------------------
test('stale scene at retry limit (retry_count=2) marks scene as failed', async () => {
  const sceneId = 'test_rec_stale_to_failed';
  await pool.query(
    `INSERT INTO processed_scenes (
       scene_id, collection, status, processing_at, retry_count, worker_id
     ) VALUES ($1, 'sentinel-1-grd', 'processing', NOW() - INTERVAL '15 minutes', 2, 'worker-crashed')
     ON CONFLICT (scene_id, collection) DO UPDATE
       SET status = 'processing', processing_at = NOW() - INTERVAL '15 minutes', retry_count = 2, worker_id = 'worker-crashed'`,
    [sceneId]
  );

  const { recovered, failed } = await worker.recoverStaleScenes();
  assert.ok(failed >= 1, `Expected at least 1 failed scene, got ${failed}`);

  const { rows } = await pool.query(
    'SELECT status, retry_count, processing_at, worker_id, error_message FROM processed_scenes WHERE scene_id = $1',
    [sceneId]
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'failed', 'Scene should be marked failed once retry limit reached');
  assert.equal(row.retry_count, 3, 'retry_count should have reached 3');
  assert.equal(row.processing_at, null, 'processing_at should be null');
  assert.equal(row.worker_id, null, 'worker_id should be null');
  assert.match(row.error_message, /\[stale recovery: retry limit reached\]/, 'error_message should record retry limit');
});

// ---------------------------------------------------------------------------
// Test HTTP Endpoint: POST /api/worker/recover-stale
// ---------------------------------------------------------------------------
test('POST /api/worker/recover-stale triggers recovery and returns concise counts', async () => {
  const sceneId = 'test_rec_http_stale';
  await pool.query(
    `INSERT INTO processed_scenes (
       scene_id, collection, status, processing_at, retry_count
     ) VALUES ($1, 'sentinel-1-grd', 'processing', NOW() - INTERVAL '15 minutes', 0)
     ON CONFLICT (scene_id, collection) DO UPDATE
       SET status = 'processing', processing_at = NOW() - INTERVAL '15 minutes', retry_count = 0`,
    [sceneId]
  );

  const res = await postJson('/api/worker/recover-stale');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.message, 'Stale recovery executed');
  assert.ok(typeof res.body.recovered === 'number');
  assert.ok(typeof res.body.failed === 'number');
  assert.ok(res.body.recovered >= 1);
});

// ---------------------------------------------------------------------------
// Test C: Detection error is persisted in error_message as [detection_failed] <msg>
// ---------------------------------------------------------------------------
test('detection error is persisted in processed_scenes.error_message with [detection_failed] prefix', async () => {
  const sceneId = 'test_rec_detect_err';

  // Create mock raster files in data/scenes/test_rec_detect_err
  const scenesBase = process.env.WORKER_SCENES_DIR || path.resolve(__dirname, '../data/scenes');
  const testDir = path.join(scenesBase, sceneId);
  await fs.mkdir(testDir, { recursive: true });

  // Copy valid test tiff from sentinel-test
  const vvSource = path.resolve(__dirname, '../data/sentinel-test/s1a_20240619_vv.tif');
  const vhSource = path.resolve(__dirname, '../data/sentinel-test/s1a_20240619_vh.tif');
  await fs.copyFile(vvSource, path.join(testDir, 'VV.tif'));
  await fs.copyFile(vhSource, path.join(testDir, 'VH.tif'));

  // Insert queued scene with earliest acquired_at so it claims first
  await pool.query(
    `INSERT INTO processed_scenes (
       scene_id, collection, status, acquired_at, bbox, retry_count
     ) VALUES (
       $1, 'sentinel-1-grd', 'queued', '1970-01-01T00:00:01Z',
       '[69.0, 19.0, 71.0, 21.0]'::jsonb, 0
     )
     ON CONFLICT (scene_id, collection) DO UPDATE
       SET status = 'queued', acquired_at = '1970-01-01T00:00:01Z', incident_id = NULL, error_message = NULL`,
    [sceneId]
  );

  // Stub incidentService.analyze to throw a detection error
  const origAnalyze = incidentService.analyze;
  const mockErrorMessage = 'Inference engine memory limit exceeded';
  incidentService.analyze = async () => {
    throw new Error(mockErrorMessage);
  };

  try {
    const result = await worker.processNextScene();
    assert.equal(result.claimed, true);
    assert.equal(result.sceneId, sceneId);
    assert.equal(result.status, 'completed', 'Acquisition succeeded so scene status should remain completed');

    const { rows } = await pool.query(
      'SELECT status, completed_at, incident_id, error_message FROM processed_scenes WHERE scene_id = $1',
      [sceneId]
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.status, 'completed');
    assert.ok(row.completed_at !== null, 'completed_at should be populated on acquisition success');
    assert.equal(row.incident_id, null, 'incident_id should remain null when detection fails');
    assert.equal(
      row.error_message,
      `[detection_failed] ${mockErrorMessage}`,
      'error_message should be formatted as [detection_failed] <sanitized message>'
    );
  } finally {
    incidentService.analyze = origAnalyze;
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Test D: Worker remains usable after a failed scene
// ---------------------------------------------------------------------------
test('worker remains usable and operational after a scene fails acquisition', async () => {
  const failSceneId = 'test_rec_fail_acq';
  const successSceneId = 'test_rec_after_fail';

  // 1. Queue failing scene with earliest timestamp ('1970-01-01T00:00:01Z')
  await pool.query(
    `INSERT INTO processed_scenes (
       scene_id, collection, status, acquired_at, bbox, retry_count
     ) VALUES (
       $1, 'sentinel-1-grd', 'queued', '1970-01-01T00:00:01Z',
       '[69.0, 19.0, 71.0, 21.0]'::jsonb, 0
     )
     ON CONFLICT (scene_id, collection) DO UPDATE
       SET status = 'queued', acquired_at = '1970-01-01T00:00:01Z', retry_count = 0, error_message = NULL`,
    [failSceneId]
  );

  // Stub sentinel.getSentinel1GrdImage to fail for the first scene
  const origGetImage = sentinel.getSentinel1GrdImage;
  sentinel.getSentinel1GrdImage = async () => {
    throw new Error('CDSE 503 Service Unavailable');
  };

  try {
    // Process the failing scene
    const failResult = await worker.processNextScene();
    assert.equal(failResult.claimed, true);
    assert.equal(failResult.sceneId, failSceneId);
    assert.equal(failResult.status, 'failed');

    // Verify the failing scene was marked failed in DB
    const { rows: failRows } = await pool.query(
      'SELECT status, retry_count, error_message FROM processed_scenes WHERE scene_id = $1',
      [failSceneId]
    );
    assert.equal(failRows[0].status, 'failed');
    assert.equal(failRows[0].retry_count, 1);
    assert.match(failRows[0].error_message, /CDSE 503/i);

    // 2. Verify worker state reflects failure but worker remains usable
    const statusAfterFail = worker.workerStatus();
    assert.ok(statusAfterFail.failedCount >= 1);
    assert.ok(statusAfterFail.lastError !== null);

    // 3. Queue a valid second scene and verify worker processes it normally
    const scenesBase = process.env.WORKER_SCENES_DIR || path.resolve(__dirname, '../data/scenes');
    const validDir = path.join(scenesBase, successSceneId);
    await fs.mkdir(validDir, { recursive: true });

    const vvSource = path.resolve(__dirname, '../data/sentinel-test/s1a_20240619_vv.tif');
    const vhSource = path.resolve(__dirname, '../data/sentinel-test/s1a_20240619_vh.tif');
    await fs.copyFile(vvSource, path.join(validDir, 'VV.tif'));
    await fs.copyFile(vhSource, path.join(validDir, 'VH.tif'));

    await pool.query(
      `INSERT INTO processed_scenes (
         scene_id, collection, status, acquired_at, bbox, retry_count
       ) VALUES (
         $1, 'sentinel-1-grd', 'queued', '1970-01-01T00:00:02Z',
         '[69.0, 19.0, 71.0, 21.0]'::jsonb, 0
       )
       ON CONFLICT (scene_id, collection) DO UPDATE
         SET status = 'queued', acquired_at = '1970-01-01T00:00:02Z', retry_count = 0`,
      [successSceneId]
    );

    // Stub incidentService.analyze for quick return (id: null avoids foreign key constraint error)
    const origAnalyze = incidentService.analyze;
    incidentService.analyze = async () => ({ id: null, status: 'completed' });

    try {
      const successResult = await worker.processNextScene();
      assert.equal(successResult.claimed, true);
      assert.equal(successResult.sceneId, successSceneId);
      assert.equal(successResult.status, 'completed');

      const statusAfterSuccess = worker.workerStatus();
      assert.ok(statusAfterSuccess.processedCount >= 1);
      assert.equal(statusAfterSuccess.lastError, null);
    } finally {
      incidentService.analyze = origAnalyze;
      await fs.rm(validDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    sentinel.getSentinel1GrdImage = origGetImage;
  }
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
after(async () => {
  await cleanupTestScenes();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});
