'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');
const worker = require('../src/services/scene-worker.service');
const sentinel = require('../src/services/sentinel.service');
const incidentService = require('../src/services/incident.service');
const poller = require('../src/services/scene-poller.service');
const app = require('../src/app');

const scenes = new Map();
let selectionLog = [];
let analyzeCount = 0;
let server;
let baseUrl;
const originals = {
  connect: pool.connect,
  query: pool.query,
  getImage: sentinel.getSentinel1GrdImage,
  analyze: incidentService.analyze,
};

function makeScene(id, scene_id, acquired_at) {
  const [minLon, minLat, maxLon, maxLat] = poller.AOI_BBOX;
  return { id, scene_id, collection: 'sentinel-1-grd', status: 'queued', bbox: [minLon - 1, minLat - 1, maxLon + 1, maxLat + 1], acquired_at, polarization: ['VV', 'VH'], platform: 'S1A', orbit_direction: 'ASCENDING', stac_feature: null };
}

pool.connect = async () => {
  let selected;
  return {
    async query(sql, params = []) {
      if (/^BEGIN$/i.test(sql.trim())) return { rows: [] };
      if (/^ROLLBACK$/i.test(sql.trim())) { selected = null; return { rows: [] }; }
      if (/^COMMIT$/i.test(sql.trim())) return { rows: [] };
      if (/SELECT id, scene_id/.test(sql)) {
        const targetId = /WHERE id = \$1/.test(sql) ? Number(params[0]) : null;
        selectionLog.push({ sql, targetId });
        const candidates = [...scenes.values()].filter((s) => s.status === 'queued');
        selected = targetId === null
          ? candidates.sort((a, b) => new Date(a.acquired_at) - new Date(b.acquired_at))[0]
          : scenes.get(targetId);
        if (selected && selected.status === 'queued') return { rows: [{ ...selected }] };
        selected = null;
        return { rows: [] };
      }
      if (/SET status\s*=\s*'processing'/.test(sql)) {
        const row = scenes.get(Number(params[1]));
        if (row) row.status = 'processing';
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
    release() {},
  };
};

pool.query = async (sql, params = []) => {
  if (/SET status\s*=\s*'completed'/.test(sql)) {
    const row = scenes.get(Number(params[1]));
    if (row) row.status = 'completed';
  } else if (/SET status\s*=\s*'failed'/.test(sql)) {
    const row = scenes.get(Number(params[1]));
    if (row) row.status = 'failed';
  }
  return { rows: [], rowCount: 1 };
};
sentinel.getSentinel1GrdImage = async () => ({ buffer: Buffer.from('test raster') });
incidentService.analyze = async () => { analyzeCount++; return { id: null }; };

const serverReady = new Promise((resolve) => {
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
});

function post(path) {
  return serverReady.then(() => new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  }));
}

test('targeted route claims and processes ID 81 only, leaving another queued scene untouched', async () => {
  scenes.clear();
  selectionLog = [];
  analyzeCount = 0;
  scenes.set(81, makeScene(81, 'test_target_81', '2026-10-05T01:10:17Z'));
  scenes.set(82, makeScene(82, 'test_target_other', '2026-10-04T01:10:17Z'));

  const result = await post('/api/worker/process/81');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result, { claimed: true, sceneId: 'test_target_81', status: 'completed' });
  assert.equal(scenes.get(81).status, 'completed');
  assert.equal(scenes.get(82).status, 'queued');
  assert.equal(selectionLog[0].targetId, 81);
  assert.match(selectionLog[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(analyzeCount, 1);
});

test('targeted route refuses non-queued scenes and validates positive integer IDs', async () => {
  scenes.clear();
  selectionLog = [];
  scenes.set(81, { ...makeScene(81, 'test_target_nonqueued', '2026-10-05T01:10:17Z'), status: 'completed' });
  const nonQueued = await post('/api/worker/process/81');
  assert.equal(nonQueued.status, 409);
  assert.equal(nonQueued.body.result.status, 'not_queued');
  assert.equal(scenes.get(81).status, 'completed');
  assert.equal(await post('/api/worker/process/0').then((r) => r.status), 400);
  assert.equal(await post('/api/worker/process/-1').then((r) => r.status), 400);
  assert.equal(selectionLog.length, 1);
});

test('process-next retains oldest-acquired queue selection behavior', async () => {
  scenes.clear();
  selectionLog = [];
  scenes.set(81, makeScene(81, 'test_target_81_next', '2026-10-05T01:10:17Z'));
  scenes.set(82, makeScene(82, 'test_target_82_next', '2026-10-04T01:10:17Z'));
  const result = await post('/api/worker/process-next');
  assert.equal(result.status, 200);
  assert.equal(result.body.result.sceneId, 'test_target_82_next');
  assert.equal(selectionLog[0].targetId, null);
  assert.match(selectionLog[0].sql, /ORDER BY acquired_at ASC NULLS LAST/);
  assert.equal(scenes.get(81).status, 'queued');
  assert.equal(scenes.get(82).status, 'completed');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const scenesDir = path.resolve(__dirname, '../data/scenes');
  await Promise.all(['test_target_81', 'test_target_82_next'].map((name) =>
    fs.rm(path.join(scenesDir, name), { recursive: true, force: true })
  ));
  pool.connect = originals.connect;
  pool.query = originals.query;
  sentinel.getSentinel1GrdImage = originals.getImage;
  incidentService.analyze = originals.analyze;
  await pool.end();
});
