'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { PassThrough } = require('stream');
const sentinel = require('../src/services/sentinel.service');

function createMockRequest(responseData) {
    return (options, cb) => {
        const req = new PassThrough();
        req.destroy = () => {};
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        
        let responseString = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        res.headers['content-length'] = Buffer.byteLength(responseString).toString();
        
        setTimeout(() => {
            if (cb) cb(res);
            res.write(responseString);
            res.end();
        }, 1);

        return req;
    };
}

test('Pagination: Single-page response', async () => {
    const originalRequest = https.request;
    let requestCount = 0;
    try {
        https.request = (opts, cb) => {
            requestCount++;
            if (opts.hostname === 'identity.dataspace.copernicus.eu') {
                return createMockRequest({ access_token: 'fake-token', expires_in: 3600 })(opts, cb);
            }
            // STAC response without next link
            return createMockRequest({
                features: [{ id: 'scene1' }, { id: 'scene2' }]
            })(opts, cb);
        };

        const result = await sentinel.searchCatalog({
            datetime: '2024-06-19T00:00:00Z/2024-06-19T01:00:00Z',
        });

        assert.equal(result.features.length, 2);
        assert.equal(requestCount, 2); // 1 for token, 1 for STAC
    } finally {
        https.request = originalRequest;
    }
});

test('Pagination: Multi-page response with link handling', async () => {
    const originalRequest = https.request;
    let stacRequests = 0;
    try {
        https.request = (opts, cb) => {
            if (opts.hostname === 'identity.dataspace.copernicus.eu') {
                return createMockRequest({ access_token: 'fake-token', expires_in: 3600 })(opts, cb);
            }
            
            stacRequests++;
            if (stacRequests === 1) {
                // Page 1
                return createMockRequest({
                    features: [{ id: 'scene1' }],
                    links: [
                        { rel: 'next', href: 'https://sh.dataspace.copernicus.eu/catalog/v1/search?page=2', method: 'GET' }
                    ]
                })(opts, cb);
            } else if (stacRequests === 2) {
                // Page 2
                assert.equal(opts.path, '/catalog/v1/search?page=2');
                assert.equal(opts.method, 'GET');
                return createMockRequest({
                    features: [{ id: 'scene2' }],
                    links: [
                        { rel: 'next', href: 'https://sh.dataspace.copernicus.eu/catalog/v1/search?page=3', method: 'POST', body: { cursor: 'abc' } }
                    ]
                })(opts, cb);
            } else {
                // Page 3
                assert.equal(opts.path, '/catalog/v1/search?page=3');
                assert.equal(opts.method, 'POST');
                return createMockRequest({
                    features: [{ id: 'scene3' }]
                })(opts, cb);
            }
        };

        const result = await sentinel.searchCatalog({
            datetime: '2024-06-19T00:00:00Z/2024-06-19T01:00:00Z',
        });

        assert.equal(result.features.length, 3);
        assert.equal(stacRequests, 3);
    } finally {
        https.request = originalRequest;
    }
});

test('Pagination: Failure safety', async () => {
    const originalRequest = https.request;
    let stacRequests = 0;
    try {
        https.request = (opts, cb) => {
            if (opts.hostname === 'identity.dataspace.copernicus.eu') {
                return createMockRequest({ access_token: 'fake-token', expires_in: 3600 })(opts, cb);
            }
            
            stacRequests++;
            if (stacRequests === 1) {
                return createMockRequest({
                    features: [{ id: 'scene1' }],
                    links: [{ rel: 'next', href: 'https://sh.dataspace.copernicus.eu/catalog/v1/search?page=2', method: 'GET' }]
                })(opts, cb);
            } else {
                // Fail on page 2
                return ((options, callback) => {
                    const req = new PassThrough();
                    req.destroy = () => {};
                    const res = new PassThrough();
                    res.statusCode = 500;
                    setTimeout(() => {
                        if (callback) callback(res);
                        res.end();
                    }, 1);
                    return req;
                })(opts, cb);
            }
        };

        await assert.rejects(
            sentinel.searchCatalog({ datetime: '2024-06-19T00:00:00Z/2024-06-19T01:00:00Z' }),
            /HTTP 500/
        );
        assert.equal(stacRequests, 2);
    } finally {
        https.request = originalRequest;
    }
});

test('Pagination: Max-page safety', async () => {
    const originalRequest = https.request;
    // Set max pages to 2 for this test
    process.env.STAC_MAX_PAGES = '2';
    // We need to re-require or mock STAC_MAX_PAGES. Since it's evaluated at module load time, 
    // we can't easily change it dynamically if it's already loaded.
    // Wait, let's just use the loaded STAC_MAX_PAGES, which is 10.
    let stacRequests = 0;
    try {
        https.request = (opts, cb) => {
            if (opts.hostname === 'identity.dataspace.copernicus.eu') {
                return createMockRequest({ access_token: 'fake-token', expires_in: 3600 })(opts, cb);
            }
            
            stacRequests++;
            // Always return a next link
            return createMockRequest({
                features: [{ id: `scene${stacRequests}` }],
                links: [{ rel: 'next', href: `https://sh.dataspace.copernicus.eu/catalog/v1/search?page=${stacRequests+1}`, method: 'GET' }]
            })(opts, cb);
        };

        await assert.rejects(
            sentinel.searchCatalog({ datetime: '2024-06-19T00:00:00Z/2024-06-19T01:00:00Z' }),
            /maximum pages .* reached/
        );
        // Default max pages is 10
        assert.equal(stacRequests, 10);
    } finally {
        https.request = originalRequest;
    }
});
