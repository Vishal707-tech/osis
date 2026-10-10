'use strict';
/**
 * replay.test.js
 * ==============
 * Integration tests for POST /api/ingestion/replay (Day 6 Task 2).
 *
 * Uses Node's built-in test runner (same as existing suite).
 *   node --test tests/replay.test.js
 *
 * The Karnataka row test gracefully skips when the DB row doesn't exist
 * (clean-CI environment without seeded data).
 */

const { test, after } = require('node:test');
const assert          = require('node:assert/strict');
const http            = require('node:http');
const app             = require('../src/app');
const pool            = require('../src/config/db');

let server;
let baseUrl;

// Spin up app on an ephemeral port
const ready = new Promise((resolve) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    resolve();
  });
});

/** POST JSON helper — returns { statusCode, body } */
async function postJson(path, payload) {
  await ready;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const opts = new URL(baseUrl + path);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('replay 400 for path-injection sceneId', async () => {
  const r = await postJson('/api/ingestion/replay', { sceneId: '../../etc/passwd' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /Invalid sceneId/i);
});

test('replay 400 for sceneId with spaces', async () => {
  const r = await postJson('/api/ingestion/replay', { sceneId: 'bad scene id' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.ok, false);
});

test('replay 404 for unknown scene not in processed_scenes', async () => {
  const r = await postJson('/api/ingestion/replay', { sceneId: 'unknown_scene_xyzzy_99' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /not found/i);
});

test('replay 200 resets Karnataka scene to queued (explicit sceneId)', async () => {
  const r = await postJson('/api/ingestion/replay', { sceneId: 'test_s1a_karnataka_day3_ml_001' });
  // Acceptable skip when row not seeded in CI
  if (r.statusCode === 404) {
    console.log('SKIP: test_s1a_karnataka_day3_ml_001 not in DB');
    return;
  }
  assert.equal(r.statusCode, 200, 'Expected 200, got: ' + JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.scene.scene_id, 'test_s1a_karnataka_day3_ml_001');
  assert.equal(r.body.scene.status, 'queued');
  assert.equal(r.body.scene.incident_id, null);
  assert.equal(r.body.scene.error_message, null);
  assert.equal(r.body.scene.retry_count, 0);
  assert.ok(r.body.message);
});

test('replay 200 uses default sceneId when body is empty', async () => {
  const r = await postJson('/api/ingestion/replay', {});
  // Either 200 (row exists) or 404 (clean DB) — never 400 or 500
  assert.ok(
    [200, 404].includes(r.statusCode),
    'Expected 200 or 404, got: ' + r.statusCode + ' ' + JSON.stringify(r.body)
  );
  if (r.statusCode === 200) {
    assert.equal(r.body.scene.scene_id, 'test_s1a_karnataka_day3_ml_001');
  }
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});
