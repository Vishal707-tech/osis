'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sentinel = require('../src/services/sentinel.service');
const input = require('../src/services/sar-input.service');

test('on-demand CDSE boundary selects one acquisition, serializes downloads and caches bounded subsets', async () => {
    const scene = require('../data/real-scenes.json')[0];
    const originals = {
        searchCatalog: sentinel.searchCatalog,
        getSentinel1GrdImage: sentinel.getSentinel1GrdImage,
    };
    const credentials = [
        process.env.CDSE_CLIENT_ID,
        process.env.CDSE_CLIENT_SECRET,
    ];
    const calls = [];
    let result,
        concurrent = 0;
    process.env.CDSE_CLIENT_ID = 'test-only';
    process.env.CDSE_CLIENT_SECRET = 'test-only';
    sentinel.searchCatalog = async (options) => {
        assert.equal(options.limit, 5);
        assert.deepEqual(options.bbox, scene.bbox);
        calls.push('catalog');
        return {
            features: [
                {
                    id: 'test-catalog-scene',
                    properties: { datetime: scene.acquiredAt },
                },
            ],
        };
    };
    sentinel.getSentinel1GrdImage = async (options) => {
        assert.equal(concurrent++, 0);
        calls.push(options.polarization);
        assert.equal(Date.parse(options.to) - Date.parse(options.from), 30000);
        concurrent--;
        return { buffer: Buffer.from('test-boundary-only-not-SAR') };
    };
    try {
        result = await input.onDemand(scene);
        assert.ok(result._paths, result._unavailable);
        assert.deepEqual(calls, ['catalog', 'VV', 'VH']);
        assert.equal(result._scene.source, 'cdse_sentinel1');
        assert.equal(result._scene.rasterUnits, 'linear');
        assert.deepEqual(await input.onDemand(scene), result);
        assert.deepEqual(
            calls,
            ['catalog', 'VV', 'VH'],
            'cache must avoid repeat provider calls',
        );
        assert.match(
            await fs.readFile(result._paths.vv, 'utf8'),
            /test-boundary/,
        );
    } finally {
        Object.assign(sentinel, originals);
        for (const [i, key] of [
            'CDSE_CLIENT_ID',
            'CDSE_CLIENT_SECRET',
        ].entries()) {
            if (credentials[i] === undefined) delete process.env[key];
            else process.env[key] = credentials[i];
        }
        if (result?._paths)
            await fs.rm(path.dirname(result._paths.vv), {
                recursive: true,
                force: true,
            });
    }
});
