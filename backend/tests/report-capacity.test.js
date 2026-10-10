'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('report capacity fails gracefully without deleting evidence; corrupt history entry is isolated', async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'osis-capacity-test-'),
    );
    process.env.OSIS_MAX_REPORTS = '1';
    process.env.OSIS_REPORT_DIR = directory;
    process.env.OSIS_SEED_DIR = path.join(directory, 'empty-seeds');
    process.env.OSIS_PERSIST_POSTGRES = 'false';
    const service = require('../src/services/incident.service');
    try {
        const first = await service.analyze({ sceneId: 'demo-no-spill' });
        await assert.rejects(
            service.analyze({ sceneId: 'demo-inconclusive' }),
            { status: 507 },
        );
        assert.equal(
            (await service.get(first.id)).outcome,
            'NO_SPILL_DETECTED',
        );
        assert.deepEqual(await fs.readdir(directory), [`${first.id}.json`]);
        await fs.writeFile(
            path.join(directory, `${first.id}.json`),
            '{malformed',
        );
        assert.deepEqual(await service.list(), []);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
