'use strict';

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');
const worker = require('../src/services/scene-worker.service');
const sentinel = require('../src/services/sentinel.service');
const incidentService = require('../src/services/incident.service');
const poller = require('../src/services/scene-poller.service');

const originals = {
  connect: pool.connect,
  query: pool.query,
  getImage: sentinel.getSentinel1GrdImage,
  analyze: incidentService.analyze,
};

let capturedTrusted = null;
let scenes = new Map();
let acquisitionBboxes = [];

pool.connect = async () => ({
  async query(sql, params = []) {
    if (/^BEGIN$/i.test(sql.trim())) return { rows: [] };
    if (/^ROLLBACK$/i.test(sql.trim())) return { rows: [] };
    if (/^COMMIT$/i.test(sql.trim())) return { rows: [] };
    if (/SELECT id, scene_id/.test(sql)) {
      const targetId = Number(params[0]);
      const selected = scenes.get(targetId);
      if (selected && selected.status === 'queued') return { rows: [{ ...selected }] };
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
});

pool.query = async (sql, params = []) => {
  if (/SET status\s*=\s*'completed'/.test(sql)) {
    const row = scenes.get(Number(params[1]));
    if (row) row.status = 'completed';
  }
  if (/UPDATE processed_scenes SET incident_id/.test(sql)) {
    return { rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
};

sentinel.getSentinel1GrdImage = async ({ bbox }) => {
  acquisitionBboxes.push(bbox);
  return { buffer: Buffer.from('test raster') };
};
incidentService.analyze = async (payload, trusted) => {
  capturedTrusted = trusted;
  return { id: 'test-incident-id' };
};

test('worker handoff passes acquisitionBbox as scene bbox and preserves full STAC bbox', async () => {
  capturedTrusted = null;
  scenes.clear();
  
  const aoi = poller.PRIORITY_AREAS && poller.PRIORITY_AREAS.length > 0 ? poller.PRIORITY_AREAS[0].bbox : [70.0, 15.0, 70.2, 15.2]; // [minLon, minLat, maxLon, maxLat]
  // Create a full CDSE scene footprint that is larger than the AOI
  const fullStacBbox = [
    aoi[0] - 1.0,
    aoi[1] - 1.0,
    aoi[2] + 1.0,
    aoi[3] + 1.0
  ];
  
  assert.notDeepEqual(fullStacBbox, aoi, "Full STAC bbox must not equal acquisitionBbox for this test");

  scenes.set(100, {
    id: 100,
    scene_id: 'test_handoff_scene',
    collection: 'sentinel-1-grd',
    status: 'queued',
    bbox: fullStacBbox,
    acquired_at: '2026-10-05T01:10:17Z',
    polarization: ['VV', 'VH'],
    platform: 'S1A',
    orbit_direction: 'ASCENDING',
    stac_feature: JSON.stringify({ bbox: fullStacBbox })
  });

  const result = await worker.processSceneById(100);
  assert.equal(result.claimed, true);
  assert.equal(result.status, 'completed');
  assert.equal(scenes.get(100).status, 'completed');
  
  assert.ok(capturedTrusted, 'Pipeline handoff was not called');
  
  const sceneData = capturedTrusted._scene;
  assert.deepEqual(sceneData.bbox, aoi, 'incident handoff must use acquisitionBbox');
  assert.deepEqual(sceneData.stacBbox, fullStacBbox, 'original scene footprint/bbox must remain available as provenance');
});

test('worker reuses a stored replay acquisition bbox within the STAC footprint', async () => {
  capturedTrusted = null;
  acquisitionBboxes = [];
  scenes.clear();
  const fullStacBbox = [55.264766, 16.779904, 57.917134, 18.854415];
  const replayBbox = [56.24, 17.40, 56.43, 17.59];
  scenes.set(106, {
    id: 106,
    scene_id: 'test_replay_with_stored_acquisition_bbox',
    collection: 'sentinel-1-grd',
    status: 'queued',
    bbox: fullStacBbox,
    acquired_at: '2026-07-02T14:22:03Z',
    polarization: ['VV', 'VH'],
    platform: 'S1D',
    orbit_direction: 'ASCENDING',
    stac_feature: JSON.stringify({ bbox: fullStacBbox }),
    artifact_metadata: { bbox: fullStacBbox, acquisitionBbox: replayBbox }
  });

  const result = await worker.processSceneById(106);
  assert.equal(result.status, 'completed');
  assert.deepEqual(acquisitionBboxes, [replayBbox, replayBbox]);
  assert.deepEqual(capturedTrusted._scene.bbox, replayBbox);
  assert.deepEqual(capturedTrusted._scene.stacBbox, fullStacBbox);
});

test('TEST A: October 5 scene gets environment override in worker handoff', async () => {
  capturedTrusted = null;
  scenes.clear();
  
  const aoi = poller.PRIORITY_AREAS && poller.PRIORITY_AREAS.length > 0 ? poller.PRIORITY_AREAS[0].bbox : [70.0, 15.0, 70.2, 15.2];
  const fullStacBbox = [aoi[0] - 1.0, aoi[1] - 1.0, aoi[2] + 1.0, aoi[3] + 1.0];
  
  scenes.set(101, {
    id: 101,
    scene_id: 'S1D_IW_GRDH_1SDV_20261005T011017_20261005T011042_004873_0092A1_0488_COG.SAFE',
    collection: 'sentinel-1-grd',
    status: 'queued',
    bbox: fullStacBbox,
    acquired_at: '2026-10-05T01:10:17Z',
    polarization: ['VV', 'VH'],
    platform: 'S1D',
    orbit_direction: 'DESCENDING',
    stac_feature: null
  });

  const result = await worker.processSceneById(101);
  assert.equal(result.claimed, true);
  assert.equal(result.status, 'completed');
  
  assert.ok(capturedTrusted, 'Pipeline handoff was not called');
  const env = capturedTrusted._scene.environment;
  assert.ok(env, 'environment override must be present for October 5 scene');
  assert.equal(env.current, 'environment/arabian_sea/cmems_arabian_sea_20261005.nc');
  assert.equal(env.wind, undefined, 'wind override must not be present');
});

test('TEST A2: Scene-specific environment override is applied for Oman scene', async () => {
  capturedTrusted = null;
  scenes.clear();
  
  const aoi = poller.PRIORITY_AREAS && poller.PRIORITY_AREAS.length > 0 ? poller.PRIORITY_AREAS[0].bbox : [70.0, 15.0, 70.2, 15.2];
  
  scenes.set(105, {
    id: 105,
    scene_id: 'S1D_IW_GRDH_1SDV_20260702T142203_20260702T142232_003496_0062F7_DBD7_COG.SAFE',
    collection: 'sentinel-1-grd',
    acquired_at: '2026-07-02T14:22:03Z',
    bbox: [aoi[0] - 1.0, aoi[1] - 1.0, aoi[2] + 1.0, aoi[3] + 1.0],
    status: 'queued',
    polarization: ['VV', 'VH']
  });
  
  const result = await worker.processSceneById(105);
  assert.equal(result.claimed, true);
  assert.equal(result.status, 'completed');
  
  assert.ok(capturedTrusted, 'Pipeline handoff was not called');
  const env = capturedTrusted._scene.environment;
  assert.ok(env, 'environment override must be present for Oman scene');
  assert.equal(env.current, 'environment/oman/cmems_oman_20260702.nc');
  assert.equal(env.wind, 'environment/oman/era5_oman_20260702.nc');
});

test('TEST B: No override is added for an ordinary scene (Karnataka)', async () => {
  capturedTrusted = null;
  scenes.clear();
  
  const aoi = poller.PRIORITY_AREAS && poller.PRIORITY_AREAS.length > 0 ? poller.PRIORITY_AREAS[0].bbox : [70.0, 15.0, 70.2, 15.2];
  const fullStacBbox = [aoi[0] - 1.0, aoi[1] - 1.0, aoi[2] + 1.0, aoi[3] + 1.0];
  
  scenes.set(102, {
    id: 102,
    scene_id: 'S1A_IW_GRDH_1SDV_20240619T004837_20240619T004902_054385_069DE8_E3DA_COG.SAFE',
    collection: 'sentinel-1-grd',
    status: 'queued',
    bbox: fullStacBbox,
    acquired_at: '2024-06-19T00:48:37Z',
    polarization: ['VV', 'VH'],
    platform: 'S1A',
    orbit_direction: 'ASCENDING',
    stac_feature: null
  });

  const result = await worker.processSceneById(102);
  assert.equal(result.claimed, true);
  assert.equal(result.status, 'completed');
  
  assert.ok(capturedTrusted, 'Pipeline handoff was not called');
  const env = capturedTrusted._scene.environment;
  assert.equal(env, undefined, 'environment override must not be present for Karnataka/ordinary scene');
});

after(async () => {
  const scenesDir = path.resolve(__dirname, '../data/scenes');
  await fs.rm(path.join(scenesDir, 'test_handoff_scene'), { recursive: true, force: true }).catch(() => {});
  
  pool.connect = originals.connect;
  pool.query = originals.query;
  sentinel.getSentinel1GrdImage = originals.getImage;
  incidentService.analyze = originals.analyze;
  await pool.end();
});
