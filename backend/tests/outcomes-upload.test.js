'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test(
    'outcome API, unavailable CDSE, invalid uploads and recovery',
    { timeout: 120000 },
    async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'osis-outcome-test-'),
        );
        process.env.OSIS_REPORT_DIR = directory;
        process.env.OSIS_PERSIST_POSTGRES = 'false';
        const app = require('../src/app');
        const pool = require('../src/config/db');
        // Set AFTER existing config loading, without reading or editing .env.
        process.env.CDSE_CLIENT_ID = '';
        process.env.CDSE_CLIENT_SECRET = '';
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}/api/incidents`;
        const post = (body) =>
            fetch(`${base}/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        try {
            for (const [sceneId, outcome] of [
                ['demo-arabian-sea', 'SPILL_DETECTED'],
                ['demo-no-spill', 'NO_SPILL_DETECTED'],
                ['demo-inconclusive', 'ANALYSIS_INCONCLUSIVE'],
            ]) {
                const response = await post({ sceneId });
                assert.equal(response.status, 201);
                const report = await response.json();
                assert.equal(report.outcome, outcome);
                assert.ok(report.scene.footprint);
                assert.ok(report.processedAt);
                assert.deepEqual(
                    await (await fetch(`${base}/${report.id}/report`)).json(),
                    report,
                );
            }
            const real = await (
                await post({
                    mode: 'REAL',
                    sceneId: 's1a-20240619-karnataka',
                    onDemand: true,
                })
            ).json();
            assert.equal(real.outcome, 'ANALYSIS_INCONCLUSIVE');
            assert.equal(real.availability, 'REAL_DATA_UNAVAILABLE');
            assert.match(real.outcomeReason, /CDSE_CLIENT_ID/);
            assert.equal(real.origin, null);
            for (const metadata of [
                '',
                'not-json',
                'null',
                '%not-encoded',
                encodeURIComponent(
                    JSON.stringify({
                        vvName: 'photo.jpg',
                        vhName: 'photo.jpg',
                        vvBytes: 8,
                    }),
                ),
            ]) {
                const response = await fetch(`${base}/upload`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-OSIS-SAR-Metadata': metadata,
                    },
                    body: Buffer.alloc(16),
                });
                assert.equal(response.status, 201);
                const invalid = await response.json();
                assert.equal(invalid.mode, 'UPLOAD');
                assert.equal(invalid.outcome, 'ANALYSIS_INCONCLUSIVE');
                assert.equal(invalid.origin, null);
                assert.equal(invalid.scene.bbox, null);
                assert.deepEqual(
                    await (await fetch(`${base}/${invalid.id}/report`)).json(),
                    invalid,
                );
            }
            assert.equal(
                (await post({})).status,
                201,
                'DEMO recovers after invalid uploads',
            );
            const oversized = await fetch(`${base}/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: Buffer.alloc(16 * 1024 * 1024 + 1),
            });
            assert.equal(oversized.status, 413);
            assert.equal(
                (await oversized.json()).outcome,
                'ANALYSIS_INCONCLUSIVE',
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await pool.end();
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
);

test(
    'valid uploaded archived SAR executes actual hybrid detector and cleans temporary products',
    { skip: process.env.OSIS_TEST_REAL_SAR !== 'true', timeout: 120000 },
    async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'osis-upload-test-'),
        );
        process.env.OSIS_REPORT_DIR = directory;
        process.env.OSIS_PERSIST_POSTGRES = 'false';
        const app = require('../src/app');
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        process.env.REAL_CURRENT_NETCDF = path.join(directory, 'absent.nc');
        process.env.REAL_WIND_NETCDF = path.join(directory, 'absent.nc');
        process.env.REAL_SAR_PYTHON ||= path.resolve(
            __dirname,
            '../../.venv-ml/Scripts/python.exe',
        );
        try {
            const vv = await fs.readFile(
                path.resolve(
                    __dirname,
                    '../data/sentinel-test/s1a_20240619_vv_db.tif',
                ),
            );
            const vh = await fs.readFile(
                path.resolve(
                    __dirname,
                    '../data/sentinel-test/s1a_20240619_vh_db.tif',
                ),
            );
            const metadata = encodeURIComponent(
                JSON.stringify({
                    vvBytes: vv.length,
                    vvName: 'vv.tif',
                    vhName: 'vh.tif',
                    rasterUnits: 'db',
                    acquiredAt: '2024-06-19T00:48:37Z',
                    sarAttested: true,
                }),
            );
            const before = (await fs.readdir(os.tmpdir()))
                .filter((n) => /^osis-upload-[A-Za-z0-9]{6}$/.test(n))
                .sort();
            const response = await fetch(
                `http://127.0.0.1:${server.address().port}/api/incidents/upload`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-OSIS-SAR-Metadata': metadata,
                    },
                    body: Buffer.concat([vv, vh]),
                },
            );
            assert.equal(response.status, 201);
            const r = await response.json();
            assert.equal(
                r.stageStatus.detection.status,
                'completed',
                r.outcomeReason,
            );
            assert.equal(r.mode, 'UPLOAD');
            assert.equal(r.detector.name, 'hybrid');
            assert.equal(r.scene.width, 128);
            assert.ok(r.detector.quality);
            assert.ok(
                [
                    'SPILL_DETECTED',
                    'NO_SPILL_DETECTED',
                    'ANALYSIS_INCONCLUSIVE',
                ].includes(r.outcome),
            );
            assert.equal(r.age, null);
            assert.equal(r.origin, null);
            assert.ok(!JSON.stringify(r).includes('synthetic_demo'));
            assert.deepEqual(
                (await fs.readdir(os.tmpdir()))
                    .filter((n) => /^osis-upload-[A-Za-z0-9]{6}$/.test(n))
                    .sort(),
                before,
            );
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(directory, { recursive: true, force: true });
        }
    },
);
