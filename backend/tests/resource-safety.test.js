'use strict';
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/db');
const poller = require('../src/services/scene-poller.service');
const worker = require('../src/services/scene-worker.service');

beforeEach(async () => {
    await pool.query('DELETE FROM processed_scenes WHERE scene_id LIKE \'test_res_%\'');
});

test('Poller Overlap Protection: concurrent pollOnce() returns immediately', async () => {
    // Force the first pollOnce to hang a bit
    mock.method(require('../src/services/sentinel.service'), 'searchCatalog', async () => {
        await new Promise(r => setTimeout(r, 100));
        return { features: [] };
    });

    const p1 = poller.pollOnce();
    assert.equal(poller.status().inFlight, true);
    
    // This should skip immediately and return
    await poller.pollOnce(); 
    
    // Wait for the first one to finish
    await p1;
    assert.equal(poller.status().inFlight, false);

    mock.restoreAll();
});

test('Worker Concurrency Protection: concurrent processNextScene() returns busy', async () => {
    // Insert a dummy scene
    await pool.query(`INSERT INTO processed_scenes (scene_id, bbox, status, acquired_at) VALUES ('test_res_w_1', '[0,0,0.1,0.1]'::jsonb, 'queued', NOW())`);

    // Mock getSentinel1GrdImage to delay so the lock is held
    const acquireMock = mock.method(require('../src/services/sentinel.service'), 'getSentinel1GrdImage', async () => {
        await new Promise(r => setTimeout(r, 100));
        return { buffer: Buffer.from('dummy') };
    });
    
    // Wait for internal lock to clear if any
    while(worker.workerStatus().inFlight) await new Promise(r=>setTimeout(r,10));

    const p1 = worker.processNextScene();
    
    // Wait for the first call to acquire the inFlight lock
    while(!worker.workerStatus().inFlight) await new Promise(r=>setTimeout(r, 10));

    // Second call should return busy
    const p2Result = await worker.processNextScene();
    assert.equal(p2Result.claimed, false);
    assert.equal(p2Result.status, 'busy');

    // Wait for the first one to finish
    await p1;
    assert.equal(worker.workerStatus().inFlight, false);

    mock.restoreAll();
});

test('Disk Cleanup: directory is removed after processing', async () => {
    // Insert a dummy scene
    await pool.query(`INSERT INTO processed_scenes (scene_id, bbox, status, acquired_at) VALUES ('test_res_cleanup', '[0,0,0.1,0.1]'::jsonb, 'queued', NOW())`);

    // Mock getSentinel1GrdImage to just create a dummy file
    mock.method(require('../src/services/sentinel.service'), 'getSentinel1GrdImage', async () => {
        return { buffer: Buffer.from('dummy') };
    });

    const result = await worker.processNextScene();
    assert.equal(result.claimed, true);

    // The directory should NOT exist
    const sceneDir = path.join(__dirname, '../../data/scenes/test_res_cleanup');
    try {
        await fs.access(sceneDir);
        assert.fail('Directory was not deleted');
    } catch (err) {
        assert.equal(err.code, 'ENOENT');
    }

    mock.restoreAll();
});

test('Queue Depth Protection: aborts poll if queue is at capacity', async () => {
    const limit = poller.status().config.queueLimit;
    
    // Insert a batch of rows to exceed the limit
    let values = [];
    for(let i=0; i <= limit; i++) {
        values.push(`('test_res_q_${i}', 'queued')`);
    }
    await pool.query(`INSERT INTO processed_scenes (scene_id, status) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`);

    let searchCalled = false;
    mock.method(require('../src/services/sentinel.service'), 'searchCatalog', async () => {
        searchCalled = true;
        return { features: [] };
    });

    await poller.pollOnce();

    assert.equal(searchCalled, false, 'searchCatalog should not be called when queue is full');

    // cleanup
    await pool.query('DELETE FROM processed_scenes WHERE scene_id LIKE \'test_res_%\'');
    mock.restoreAll();
});
