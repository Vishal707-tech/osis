'use strict';

const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/db');
const worker = require('../src/services/scene-worker.service');
const incidentService = require('../src/services/incident.service');
const fs = require('node:fs/promises');

// Mock fs to prevent saving reports locally and polluting
const originalWriteFile = fs.writeFile;
const originalRename = fs.rename;
fs.writeFile = async (file, data, opts) => {
    if (String(file).includes('incidents')) return;
    return originalWriteFile(file, data, opts);
};
fs.rename = async (oldPath, newPath) => {
    if (String(newPath).includes('incidents')) return;
    return originalRename(oldPath, newPath);
};

// Mock child_process spawn
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
    const EventEmitter = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
        end: (input) => {
            const parsed = JSON.parse(input);
            const output = {
                status: 'completed',
                outcome: 'SPILL_DETECTED',
                scene: { id: parsed.sceneId, acquiredAt: '2026-10-08T00:00:00Z', source: 'cdse_sentinel1' },
                spill: { geometry: { type: 'Polygon', coordinates: [[[0,0], [0,1], [1,1], [1,0], [0,0]]] } },
                origin: { geometry: { type: 'Point', coordinates: [0.5, 0.5] } }
            };
            child.stdout.emit('data', Buffer.from(JSON.stringify(output)));
            setTimeout(() => child.emit('close', 0), 10);
        },
        on: () => {}
    };
    child.kill = () => {};
    return child;
};

// Also we need to mock worker.acquireScene to not download real files!
const originalAcquireScene = worker.__get__ ? worker.__get__('acquireScene') : null;
// Since we can't easily mock private functions, we can mock sentinel.getSentinel1GrdImage instead
const sentinel = require('../src/services/sentinel.service');
const originalGetSentinel1GrdImage = sentinel.getSentinel1GrdImage;
sentinel.getSentinel1GrdImage = async () => ({ buffer: Buffer.from('test raster') });

test('idempotent incident persistence across worker crash simulation', async () => {
    const sceneId = 'test_crash_recovery_scene_1';
    
    // Clean up before test
    await pool.query('DELETE FROM processed_scenes WHERE scene_id = $1', [sceneId]);
    await pool.query('DELETE FROM osis_incidents WHERE scene_id = $1', [sceneId]);

    const sceneResult = await pool.query(`
        INSERT INTO processed_scenes (scene_id, collection, status, acquired_at, bbox)
        VALUES ($1, 'sentinel-1-grd', 'queued', '2026-10-08T00:00:00Z', '[0,0,1,1]'::jsonb)
        RETURNING id
    `, [sceneId]);
    const dbSceneId = sceneResult.rows[0].id;

    const originalQuery = pool.query;
    let crashed = false;
    pool.query = async function (sql, params) {
        if (sql.includes('UPDATE processed_scenes SET incident_id') && !crashed) {
            crashed = true;
            throw new Error('Simulated Crash during linkage!');
        }
        return originalQuery.apply(pool, arguments);
    };

    try {
        await worker.processSceneById(dbSceneId);
    } catch (err) {}

    pool.query = originalQuery;
    
    const incRes1 = await pool.query('SELECT * FROM osis_incidents WHERE scene_id = $1', [sceneId]);
    assert.equal(incRes1.rows.length, 1, 'Exactly one incident should be created before retry');
    const firstIncidentId = incRes1.rows[0].id;

    await pool.query("UPDATE processed_scenes SET status = 'queued', incident_id = NULL, error_message = NULL, retry_count = 0 WHERE id = $1", [dbSceneId]);

    await worker.processSceneById(dbSceneId);

    const incRes2 = await pool.query('SELECT * FROM osis_incidents WHERE scene_id = $1', [sceneId]);
    assert.equal(incRes2.rows.length, 1, 'Exactly one osis_incidents row for the scene_id after retry');
    assert.equal(incRes2.rows[0].id, firstIncidentId, 'Same incident UUID on retry');
    
    const psRes = await pool.query('SELECT incident_id, status FROM processed_scenes WHERE id = $1', [dbSceneId]);
    assert.equal(psRes.rows[0].incident_id, firstIncidentId, 'processed_scenes.incident_id equals that UUID');
    assert.equal(psRes.rows[0].status, 'completed', 'Scene successfully completed on retry');
});

test('normal first-time processing', async () => {
    const sceneId = 'test_normal_processing_scene_1';
    await pool.query('DELETE FROM processed_scenes WHERE scene_id = $1', [sceneId]);
    await pool.query('DELETE FROM osis_incidents WHERE scene_id = $1', [sceneId]);
    
    const sceneResult = await pool.query(`
        INSERT INTO processed_scenes (scene_id, collection, status, acquired_at, bbox)
        VALUES ($1, 'sentinel-1-grd', 'queued', '2026-10-08T00:00:00Z', '[0,0,1,1]'::jsonb)
        RETURNING id
    `, [sceneId]);
    const dbSceneId = sceneResult.rows[0].id;

    await worker.processSceneById(dbSceneId);

    const incRes = await pool.query('SELECT * FROM osis_incidents WHERE scene_id = $1', [sceneId]);
    assert.equal(incRes.rows.length, 1, 'Exactly one incident created');
    
    const psRes = await pool.query('SELECT incident_id, status FROM processed_scenes WHERE id = $1', [dbSceneId]);
    assert.equal(psRes.rows[0].incident_id, incRes.rows[0].id, 'processed_scenes linked to incident');
    assert.equal(psRes.rows[0].status, 'completed', 'Scene status is completed');
});

after(async () => {
    childProcess.spawn = originalSpawn;
    sentinel.getSentinel1GrdImage = originalGetSentinel1GrdImage;
    fs.writeFile = originalWriteFile;
    fs.rename = originalRename;
});

