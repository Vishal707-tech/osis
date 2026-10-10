'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('Seed fixtures fallback exposes 4 core scenarios when runtime directory is empty', async () => {
    const emptyRuntimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'osis-seed-test-'));
    process.env.OSIS_REPORT_DIR = emptyRuntimeDir;
    delete process.env.OSIS_SEED_DIR; // Use default backend/data/seed-incidents

    const service = require('../src/services/incident.service');
    const reports = await service.list();

    assert.equal(reports.length, 4, 'Should return exactly 4 baseline scenarios');
    const sceneIds = new Set(reports.map(r => r.sceneId));
    assert.ok(sceneIds.has('demo-arabian-sea'), 'Must include demo-arabian-sea');
    assert.ok(sceneIds.has('s1a-20240619-karnataka'), 'Must include s1a-20240619-karnataka');
    assert.ok(sceneIds.has('demo-inconclusive'), 'Must include demo-inconclusive');
    assert.ok(sceneIds.has('demo-no-spill'), 'Must include demo-no-spill');

    // Verify each report can be retrieved in full
    for (const summary of reports) {
        const full = await service.get(summary.id);
        assert.equal(full.id, summary.id);
        assert.equal(full.scene?.id, summary.sceneId);
        assert.ok(full.outcome, 'Must have outcome');
    }

    // Verify HTTP endpoint works end-to-end
    const app = require('../src/app');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const res = await fetch(`${base}/api/incidents`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.length, 4);

        const httpSceneIds = new Set(data.map(r => r.sceneId));
        assert.ok(httpSceneIds.has('demo-arabian-sea'));
        assert.ok(httpSceneIds.has('s1a-20240619-karnataka'));
        assert.ok(httpSceneIds.has('demo-inconclusive'));
        assert.ok(httpSceneIds.has('demo-no-spill'));
    } finally {
        server.close();
        await fs.rm(emptyRuntimeDir, { recursive: true, force: true });
    }
});
