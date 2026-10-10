'use strict';
// Opt-in: runs actual archived rasters/checkpoint, never substitutes test SAR output.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('archived classical/hybrid HTTP reports retain SAR with missing environmental assets', {
    skip: process.env.OSIS_TEST_REAL_SAR !== 'true', timeout: 120000
}, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osis-real-test-'));
    const keys = ['OSIS_REPORT_DIR', 'OSIS_PERSIST_POSTGRES', 'REAL_SAR_PYTHON',
        'REAL_CURRENT_NETCDF', 'REAL_WIND_NETCDF', 'REAL_AIS_CSV', 'REAL_AIS_MANIFEST'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.OSIS_REPORT_DIR = directory;
    process.env.OSIS_PERSIST_POSTGRES = 'true';
    process.env.REAL_SAR_PYTHON ||= path.resolve(__dirname, '../../.venv-ml/Scripts/python.exe');
    for (const key of keys.slice(3)) process.env[key] = path.join(directory, 'missing-asset');
    const app = require('../src/app');
    const pool = require('../src/config/db');
    const query = pool.query;
    let databaseQueries = 0;
    pool.query = async () => { databaseQueries++; throw new Error('REAL must not query seeded AIS or mirror partial reports'); };
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/incidents`;
    try {
        const scenes = await (await fetch(`${base}/scenes`)).json();
        const scene = scenes.find(s => s.id === 's1a-20240619-karnataka');
        assert.ok(scene);
        for (const detector of ['classical', 'hybrid']) {
            const response = await fetch(`${base}/analyze`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'REAL', sceneId: scene.id, detector, hindcastHours: 6 }) });
            assert.equal(response.status, 201);
            const report = await response.json();
            assert.equal(report.stageStatus.detection.status, 'completed', report.stageStatus.detection.reason);
            assert.equal(report.detector.name, detector);
            assert.ok(report.scene.jointValidFraction >= .5);
            assert.equal(report.scene.width, 128);
            assert.equal(report.mask.length, 128);
            assert.match(report.scene.assetSha256.vv, /^[a-f0-9]{64}$/);
            if (detector === 'hybrid') assert.match(report.detector.checkpointSha256, /^[a-f0-9]{64}$/);
            assert.equal(report.status, report.detections.length ? 'partial' : 'no_candidates');
            assert.equal(report.stageStatus.environment.status, 'unavailable');
            assert.equal(report.persistence.database, 'unavailable_local_fallback');
            assert.equal(report.age, null);
            assert.equal(report.origin, null);
            assert.deepEqual(report.candidates, []);
            assert.deepEqual(report.backward, []);
            assert.deepEqual(report.forward, []);
            assert.ok(!JSON.stringify(report).includes('synthetic_demo'));
            assert.ok(!JSON.stringify(report).includes(directory));
            assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${report.id}.json`), 'utf8')), report);
            for (const suffix of ['', '/report']) {
                assert.deepEqual(await (await fetch(`${base}/${report.id}${suffix}`)).json(), report);
            }
            const origin = await (await fetch(`${base}/${report.id}/origin`)).json();
            assert.deepEqual(origin, { origin: null, backward: [] });
            for (const suffix of ['/spill', '/drift', '/vessels']) {
                assert.equal((await fetch(`${base}/${report.id}${suffix}`)).status, 200);
            }
            assert.equal((await fetch(`${base}/${report.id}/vessels/123456789`)).status, 404);
            const history = await (await fetch(base)).json();
            assert.ok(history.some(r => r.id === report.id && r.mode === 'REAL' && r.status === report.status));
            console.info(JSON.stringify({ detector, status: report.status, outcome: report.outcome, quality: report.detector.quality, coverage: report.scene.jointValidFraction,
                candidates: report.detections.length, contourKm2: report.spill?.metrics.areaKm2,
                maskKm2: report.spill?.maskAreaKm2 }));
        }
        assert.equal(databaseQueries, 2); // Optional mirror only; never seeded AIS queries.
    } finally {
        pool.query = query;
        await new Promise(resolve => server.close(resolve));
        await pool.end();
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
        await fs.rm(directory, { recursive: true, force: true });
    }
});