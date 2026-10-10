'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('HTTP end-to-end analysis, durable reports, validation and graceful failures', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osis-test-'));
    process.env.OSIS_REPORT_DIR = directory;
    process.env.OSIS_SEED_DIR = path.join(directory, 'empty-seeds');
    process.env.OSIS_PERSIST_POSTGRES = 'false';
    const app = require('../src/app');
    const pool = require('../src/config/db');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = body => fetch(`${base}/api/incidents/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const python = process.env.PYTHON_PATH;
    const sarPython = process.env.REAL_SAR_PYTHON;
    try {
        assert.equal((await fetch(`${base}/api/health`)).status, 200);
        assert.deepEqual(await (await fetch(`${base}/api/incidents`)).json(), []);
        const scenes = await (await fetch(`${base}/api/incidents/scenes`)).json();
        assert.equal(scenes[0].source, 'synthetic_demo');
        const realScene = scenes.find(s => s.mode === 'REAL');
        assert.ok(realScene);
        assert.equal(realScene.vv, undefined);
        assert.equal(realScene.vh, undefined);

        for (const body of [{ forecastHours: 0 }, { forecastHours: '24' }, { sceneId: 'remote' }, { secret: 'x' }, [],
            { mode: 'real' }, { mode: 'REAL' }, { sceneId: realScene.id }, { detector: 'classical' },
            { mode: 'REAL', sceneId: realScene.id, detector: 'auto' },
            { mode: 'REAL', sceneId: realScene.id, hindcastHours: '6' },
            { mode: 'REAL', sceneId: realScene.id, hindcastHours: 49 },
            { mode: 'REAL', sceneId: realScene.id, vv: '/private' }]) {
            assert.equal((await post(body)).status, 400);
        }
        const malformed = await fetch(`${base}/api/incidents/analyze`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
        });
        assert.equal(malformed.status, 400);

        const response = await post({ forecastHours: 72 });
        assert.equal(response.status, 201);
        const report = await response.json();
        assert.equal(report.status, 'completed');
        assert.equal(report.forward.length, 73);
        assert.equal(report.detections.length, 2);
        assert.equal(report.candidates.length, 3);
        assert.equal(report.leadingCandidate, '000000001');
        assert.equal(report.anomalies[0].durationHours, 2);
        assert.equal(report.persistence.database, 'disabled');
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${report.id}.json`), 'utf8')), report);

        for (const suffix of ['', '/spill', '/origin', '/drift', '/vessels', '/report', '/vessels/000000001']) {
            assert.equal((await fetch(`${base}/api/incidents/${report.id}${suffix}`)).status, 200);
        }
        const download = await fetch(`${base}/api/incidents/${report.id}/report`);
        assert.match(download.headers.get('content-disposition'), /attachment/);
        assert.deepEqual(await download.json(), report);
        const list = await (await fetch(`${base}/api/incidents`)).json();
        assert.equal(list[0].id, report.id);
        assert.equal((await fetch(`${base}/api/incidents/invalid`)).status, 400);
        assert.equal((await fetch(`${base}/api/incidents/00000000-0000-0000-0000-000000000000`)).status, 404);
        assert.equal((await fetch(`${base}/api/incidents/${report.id}/vessels/unknown`)).status, 404);

        process.env.REAL_SAR_PYTHON = path.join(directory, 'missing-sar-python');
        const partialResponse = await post({ mode: 'REAL', sceneId: realScene.id, hindcastHours: 6 });
        assert.equal(partialResponse.status, 201);
        const partial = await partialResponse.json();
        assert.equal(partial.mode, 'REAL');
        assert.equal(partial.status, 'partial');
        assert.equal(partial.stageStatus.detection.status, 'unavailable');
        assert.equal(partial.age, null);
        assert.equal(partial.origin, null);
        assert.deepEqual(partial.detections, []);
        assert.deepEqual(partial.candidates, []);
        assert.deepEqual(partial.forward, []);
        assert.ok(!JSON.stringify(partial).includes('synthetic_demo'));
        assert.deepEqual(await (await fetch(`${base}/api/incidents/${partial.id}/report`)).json(), partial);

        // Deliberately missing interpreter must produce a useful error, never a substituted result.
        process.env.PYTHON_PATH = path.join(directory, 'missing-python');
        assert.equal((await post({})).status, 503);
        if (python === undefined) delete process.env.PYTHON_PATH;
        else process.env.PYTHON_PATH = python;

        // Simulate database outage without changing any real database configuration/data.
        const query = pool.query;
        pool.query = async () => { throw new Error('simulated unavailable database'); };
        process.env.OSIS_PERSIST_POSTGRES = 'true';
        try {
            const fallback = await post({ forecastHours: 24 });
            assert.equal(fallback.status, 201);
            const saved = await fallback.json();
            assert.equal(saved.persistence.database, 'unavailable_local_fallback');
            assert.equal((await fetch(`${base}/api/incidents/${saved.id}`)).status, 200);
        } finally {
            pool.query = query;
        }
    } finally {
        if (sarPython === undefined) delete process.env.REAL_SAR_PYTHON;
        else process.env.REAL_SAR_PYTHON = sarPython;
        if (python === undefined) delete process.env.PYTHON_PATH;
        else process.env.PYTHON_PATH = python;
        await new Promise(resolve => server.close(resolve));
        await pool.end();
        // Only remove the temporary directory created by this test.
        await fs.rm(directory, { recursive: true, force: true });
    }
});