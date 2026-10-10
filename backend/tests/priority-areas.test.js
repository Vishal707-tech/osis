'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// We need to manipulate env vars before requiring poller
process.env.POLLER_PRIORITY_AREAS_JSON = JSON.stringify([
    { id: 'area_1', bbox: [10, 10, 10.1, 10.1], priority: 50 },
    { id: 'area_2', bbox: [10.05, 10.05, 10.15, 10.15], priority: 100 },
    { id: 'area_same_prio_a', bbox: [20, 20, 20.1, 20.1], priority: 10 },
    { id: 'area_same_prio_b', bbox: [20, 20, 20.1, 20.1], priority: 10 },
]);
const poller = require('../src/services/scene-poller.service');

test('Priority area validation', () => {
    // Valid areas are loaded
    assert.ok(poller.PRIORITY_AREAS.length >= 4);
    
    // Ordered by priority descending
    assert.equal(poller.PRIORITY_AREAS[0].id, 'area_2'); // priority 100
    assert.equal(poller.PRIORITY_AREAS[1].id, 'area_1'); // priority 50
    
    // Deterministic tie-break by ID
    assert.equal(poller.PRIORITY_AREAS[2].id, 'area_same_prio_a');
    assert.equal(poller.PRIORITY_AREAS[3].id, 'area_same_prio_b');
});

test('Scene intersection and acquisition bbox logic', () => {
    function intersects(b1, b2) {
        return !(b1[2] < b2[0] || b1[0] > b2[2] || b1[3] < b2[1] || b1[1] > b2[3]);
    }

    const sceneBboxMatch = [10.08, 10.08, 10.12, 10.12];
    const intersecting = poller.PRIORITY_AREAS.filter(area => intersects(sceneBboxMatch, area.bbox));
    
    assert.equal(intersecting.length, 2); // intersects both area_1 and area_2
    
    // highest priority wins
    const selected = intersecting[0];
    assert.equal(selected.id, 'area_2');
    assert.deepEqual(selected.bbox, [10.05, 10.05, 10.15, 10.15]);
    
    const sceneBboxOutside = [30, 30, 31, 31];
    const intersectingOutside = poller.PRIORITY_AREAS.filter(area => intersects(sceneBboxOutside, area.bbox));
    assert.equal(intersectingOutside.length, 0); // discarded
});

test('Global discovery payload', async () => {
    // We can't easily assert on searchCatalog args without mocking it in the poller,
    // but we can verify poller doesn't export AOI_BBOX anymore, preventing its usage in searchCatalog
    assert.equal(poller.AOI_BBOX, undefined);
    assert.ok(Array.isArray(poller.PRIORITY_AREAS));
});

test('Poller start does not crash due to missing AOI_BBOX reference', async () => {
    // Start should not throw. 
    // We will stop it right away since it schedules an interval.
    // Also, bounded-fetch may try to do something, so we don't await start() here
    // wait, start() doesn't block the event loop indefinitely except for the interval.
    const startPromise = poller.start().catch(err => {
        assert.fail(`start() threw an error: ${err.message}`);
    });
    
    // give it a tiny bit of time then stop
    await new Promise(r => setTimeout(r, 50));
    poller.stop();
    await startPromise;
});
