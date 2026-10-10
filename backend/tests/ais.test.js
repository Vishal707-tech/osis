const test = require('node:test');
const assert = require('node:assert');
const aisService = require('../src/services/ais.service');
const pool = require('../src/config/db');
const { WebSocketServer } = require('ws');
const http = require('http');
const { randomUUID } = require('crypto');

test('AIS Service - start/stop', () => {
    const originalKey = process.env.AISSTREAM_API_KEY;
    delete process.env.AISSTREAM_API_KEY;
    
    assert.strictEqual(aisService.isActive, false);
    // start without API key
    aisService.start();
    assert.strictEqual(aisService.isActive, false, 'Should not start without API key');

    process.env.AISSTREAM_API_KEY = 'mock-key';
    aisService.start();
    assert.strictEqual(aisService.isActive, true, 'Should start with API key');
    assert.ok(aisService.cleanupTimer);

    aisService.stop();
    assert.strictEqual(aisService.isActive, false, 'Should be inactive after stop');
    assert.strictEqual(aisService.ws, null);
    assert.strictEqual(aisService.cleanupTimer, null);
    
    process.env.AISSTREAM_API_KEY = originalKey;
});

test('AIS Service - Timestamp Normalization', () => {
    // 1. Go-style nanosecond UTC string
    const goStyle = "2026-10-07 17:37:09.016653628 +0000 UTC";
    const normalized1 = aisService.normalizeTimestamp(goStyle);
    assert.strictEqual(normalized1, "2026-10-07T17:37:09.016Z");

    // 2. Already valid ISO string
    const isoStyle = "2026-10-07T17:37:09.016Z";
    const normalized2 = aisService.normalizeTimestamp(isoStyle);
    assert.strictEqual(normalized2, "2026-10-07T17:37:09.016Z");

    // 3. Go-style with NO milliseconds
    const goNoMs = "2026-10-07 17:37:09 +0000 UTC";
    const normalized3 = aisService.normalizeTimestamp(goNoMs);
    assert.strictEqual(normalized3, "2026-10-07T17:37:09.000Z");

    // 4. Invalid timestamp
    const invalid = "Not a real date";
    const normalized4 = aisService.normalizeTimestamp(invalid);
    assert.strictEqual(normalized4, null);
});

test('AIS Service - Mocked WebSocket Reconnect & Parsing', async () => {
    // We mock the WebSocket server to test connect, parse and backoff
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    let clientConnected = false;
    let receivedSub = null;

    wss.on('connection', (ws) => {
        clientConnected = true;
        ws.on('message', (data) => {
            receivedSub = JSON.parse(data);
            // send a mock position report WITHOUT speed/course
            ws.send(JSON.stringify({
                MessageType: 'PositionReport',
                MetaData: { MMSI: '123456789', time_utc: "2026-10-07 17:37:09.016653628 +0000 UTC" },
                Message: { PositionReport: { Latitude: 12.34, Longitude: 56.78 } }
            }));
            // send a mock position report WITH speed/course
            ws.send(JSON.stringify({
                MessageType: 'PositionReport',
                MetaData: { MMSI: '987654321', time_utc: "2026-10-07 17:37:10 +0000 UTC" },
                Message: { PositionReport: { Latitude: 23.45, Longitude: 67.89, Sog: 15.2, Cog: 180.5 } }
            }));
            // send a malformed message
            ws.send('invalid json');
            
            // force close
            setTimeout(() => ws.close(), 100);
        });
    });

    await new Promise(resolve => {
        server.listen(0, () => {
            const port = server.address().port;
            resolve(port);
        });
    });
    const port = server.address().port;
    
    try {
        process.env.AISSTREAM_API_KEY = 'mock-key';
        process.env.AISSTREAM_URL = `ws://localhost:${port}`;
        aisService.start();

        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(clientConnected, true);
        assert.strictEqual(receivedSub.Apikey, 'mock-key');

        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(aisService.batch.length, 2);
        assert.strictEqual(aisService.batch[0].mmsi, '123456789');
        assert.strictEqual(aisService.batch[0].speed, null);
        assert.strictEqual(aisService.batch[0].course, null);
        
        assert.strictEqual(aisService.batch[1].mmsi, '987654321');
        assert.strictEqual(aisService.batch[1].speed, 15.2);
        assert.strictEqual(aisService.batch[1].course, 180.5);

        await new Promise(resolve => setTimeout(resolve, 150));
        // Client should have been disconnected and reconnected scheduled
        assert.ok(aisService.reconnectTimer);
        
        aisService.stop();
    } finally {
        server.close();
    }
});
