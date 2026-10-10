'use strict';
const https = require('https');
const dns = require('dns');
const limits = require('./resource-limits');

let active = 0;

function boundedFetch(urlStr, options = {}, maxBytes = limits.downloadBytes) {
    return new Promise((resolve, reject) => {
        if (active >= 2) {
            return reject(new Error('CDSE request capacity reached; retry shortly'));
        }
        active++;

        let isDone = false;
        let timer;
        const cleanup = () => {
            isDone = true;
            clearTimeout(timer);
            active--;
        };

        const url = new URL(urlStr);
        const headers = options.headers || {};
        if (options.body && typeof options.body === 'string' && !headers['Content-Length'] && !headers['content-length']) {
            headers['Content-Length'] = Buffer.byteLength(options.body).toString();
        }

        const reqOptions = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: headers,
            lookup: (hostname, dnsOptions, callback) => {
                dns.lookup(hostname, { ...dnsOptions, family: 4 }, callback);
            }
        };

        const req = https.request(reqOptions, (res) => {
            if (isDone) {
                res.destroy();
                return;
            }

            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                cleanup();
                req.destroy();
                const err = new Error('unexpected redirect');
                err.name = 'TypeError';
                return reject(err);
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
                let errBody = '';
                res.on('data', chunk => errBody += chunk);
                res.on('end', () => {
                    cleanup();
                    req.destroy();
                    console.error('CDSE HTTP ' + res.statusCode + ' error body:', errBody);
                    return reject(new Error(`CDSE access unavailable (HTTP ${res.statusCode}); check account permissions/quota`));
                });
                return;
            }

            const contentLength = res.headers['content-length'];
            if (contentLength && Number(contentLength) > maxBytes) {
                cleanup();
                req.destroy();
                return reject(new Error('CDSE response exceeds size limit'));
            }

            let bytes = 0;
            const chunks = [];

            res.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > maxBytes) {
                    cleanup();
                    res.destroy();
                    reject(new Error('CDSE response exceeds size limit'));
                } else {
                    chunks.push(chunk);
                }
            });

            res.on('end', () => {
                if (isDone) return;
                cleanup();
                
                const buffer = Buffer.concat(chunks);
                const headersMap = {
                    get: (name) => res.headers[name.toLowerCase()] || null
                };

                resolve({
                    ok: true,
                    status: res.statusCode,
                    headers: headersMap,
                    json: async () => JSON.parse(buffer.toString('utf8')),
                    arrayBuffer: async () => buffer,
                });
            });

            res.on('error', (err) => {
                if (isDone) return;
                cleanup();
                if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                    return reject(new Error('CDSE request timed out; retry manually'));
                }
                reject(err);
            });
        });

        req.on('error', (err) => {
            if (isDone) return;
            cleanup();
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                return reject(new Error('CDSE request timed out; retry manually'));
            }
            reject(err);
        });

        timer = setTimeout(() => {
            if (isDone) return;
            cleanup();
            req.destroy();
            const err = new Error('CDSE request timed out; retry manually');
            err.name = 'TimeoutError';
            reject(err);
        }, limits.requestMs);

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

module.exports = boundedFetch;
