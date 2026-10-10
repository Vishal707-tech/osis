'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const limits = require('./resource-limits');
const sentinel = require('./sentinel.service');

const emptyScene = (mode, acquiredAt = '') => ({
    id: `${mode.toLowerCase()}-${randomUUID()}`,
    mode,
    source: mode === 'UPLOAD' ? 'user_provided_sar' : 'cdse_sentinel1',
    acquiredAt,
    bbox: null,
    width: 0,
    height: 0,
    pixels: [],
    resolution_m: [],
    polarization: ['VV', 'VH'],
});

async function upload(body, metadata) {
    const scene = emptyScene('UPLOAD');
    let directory;
    const cleanup = async () => {
        if (directory) await fs.rm(directory, { recursive: true, force: true });
    };
    try {
        if (!metadata || Buffer.byteLength(metadata) > 4096)
            throw new Error('Upload metadata missing or too large');
        const meta = JSON.parse(decodeURIComponent(metadata));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta))
            throw new Error('Invalid upload metadata object');
        const {
            vvBytes,
            vvName,
            vhName,
            acquiredAt,
            rasterUnits,
            sarAttested,
        } = meta;
        const forecastHours = meta.forecastHours ?? 24,
            hindcastHours = meta.hindcastHours ?? 6;
        if (
            ![24, 48, 72].includes(forecastHours) ||
            typeof hindcastHours !== 'number' ||
            !Number.isFinite(hindcastHours) ||
            hindcastHours < 1 ||
            hindcastHours > 48
        )
            throw new Error(
                'Upload forecast must be 24/48/72 hours and hindcast scenario 1–48 hours',
            );
        if (
            !Buffer.isBuffer(body) ||
            !Number.isInteger(vvBytes) ||
            vvBytes < 8 ||
            vvBytes > limits.uploadBytes ||
            body.length - vvBytes < 8 ||
            body.length - vvBytes > limits.uploadBytes
        )
            throw new Error(
                'Provide two SAR GeoTIFF subsets, at most 8 MiB per polarization',
            );
        if (
            ![vvName, vhName].every(
                (n) =>
                    typeof n === 'string' &&
                    n.length <= 180 &&
                    /\.tiff?$/i.test(n),
            )
        )
            throw new Error(
                'Unsupported upload: floating-point VV/VH GeoTIFF required; RGB/JPEG/PNG photographs are not SAR',
            );
        if (sarAttested !== true || !['db', 'linear'].includes(rasterUnits))
            throw new Error(
                'Declare calibrated SAR units and attest that these are VV/VH SAR, not photographs',
            );
        if (
            typeof acquiredAt !== 'string' ||
            !/(Z|[+-]\d\d:\d\d)$/.test(acquiredAt) ||
            !Number.isFinite(Date.parse(acquiredAt))
        )
            throw new Error(
                'Acquisition timestamp must be a valid timezone-qualified date',
            );
        scene.acquiredAt = new Date(acquiredAt).toISOString();
        const vv = body.subarray(0, vvBytes),
            vh = body.subarray(vvBytes);
        let info;
        try {
            info = sentinel.parseTiffMetadata(vv);
            sentinel.parseTiffMetadata(vh);
        } catch {
            throw new Error(
                'Invalid TIFF header; export calibrated EPSG:4326 VV/VH subsets',
            );
        }
        if (
            !info.geoBbox ||
            info.width !== 512 ||
            info.height !== 512 ||
            info.samplesPerPixel !== 1 ||
            info.bitsPerSample !== 32 ||
            !info.sampleFormat.startsWith('FLOAT')
        )
            throw new Error(
                'Supported input: single-band 512x512 FLOAT32 north-up EPSG:4326 GeoTIFF VV/VH pair',
            );
        const [w, s, e, n] = info.geoBbox;
        if (
            ![w, s, e, n].every(Number.isFinite) ||
            !(
                w >= -180 &&
                e <= 180 &&
                s > -85 &&
                n < 85 &&
                e > w &&
                n > s &&
                e - w <= 0.2 &&
                n - s <= 0.2
            )
        )
            throw new Error(
                'Upload AOI exceeds 0.2 degrees per side or has invalid coordinates',
            );
        Object.assign(scene, {
            bbox: info.geoBbox,
            rasterUnits,
            sourceAttestation:
                'Operator declares SAR; authenticity and timestamp not independently verified',
        });
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osis-upload-'));
        const paths = {
            vv: path.join(directory, 'vv.tif'),
            vh: path.join(directory, 'vh.tif'),
        };
        await fs.writeFile(paths.vv, vv, { flag: 'wx' });
        await fs.writeFile(paths.vh, vh, { flag: 'wx' });
        return {
            _scene: scene,
            _paths: paths,
            forecastHours,
            hindcastHours,
            cleanup,
        };
    } catch (error) {
        await cleanup();
        return {
            _scene: scene,
            _unavailable:
                error instanceof SyntaxError || error instanceof URIError
                    ? 'Invalid upload metadata'
                    : error.code
                      ? 'Upload storage unavailable; check writable temporary directory and free disk space'
                      : error.message,
            cleanup,
        };
    }
}

let cache,
    busy = false,
    lastAttempt = 0;
async function onDemand(entry) {
    const { vv, vh, ...publicScene } = entry;
    const scene = {
        ...emptyScene('REAL'),
        ...publicScene,
        rasterUnits: 'linear',
        source: 'cdse_sentinel1',
    };
    if (cache && cache.expires <= Date.now()) {
        await fs.rm(cache.directory, { recursive: true, force: true });
        cache = null;
    }
    if (cache?.id === entry.id) {
        try {
            await fs.access(cache.paths.vv);
            await fs.access(cache.paths.vh);
            return { _scene: cache.scene, _paths: cache.paths };
        } catch {
            await fs.rm(cache.directory, { recursive: true, force: true });
            cache = null;
        }
    }
    if (
        !process.env.CDSE_CLIENT_ID?.trim() ||
        !process.env.CDSE_CLIENT_SECRET?.trim()
    )
        return {
            _scene: scene,
            _unavailable:
                'REAL_DATA_UNAVAILABLE: CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are required, with Sentinel Hub Process API access',
        };
    if (busy || Date.now() - lastAttempt < 60000)
        return {
            _scene: scene,
            _unavailable:
                'REAL_DATA_UNAVAILABLE: CDSE capacity/cooldown reached; retry after 60 seconds',
        };
    busy = true;
    lastAttempt = Date.now();
    let directory;
    try {
        // Expire only directories created by this adapter with its ownership marker.
        for (const name of (await fs.readdir(os.tmpdir())).filter((n) =>
            /^osis-cdse-[A-Za-z0-9]{6}$/.test(n),
        )) {
            const stale = path.join(os.tmpdir(), name);
            try {
                const marker = JSON.parse(
                    await fs.readFile(
                        path.join(stale, 'osis-cache.json'),
                        'utf8',
                    ),
                );
                if (
                    marker.owner === 'osis-cdse-v1' &&
                    marker.expires < Date.now()
                )
                    await fs.rm(stale, { recursive: true, force: true });
            } catch {
                /* Do not remove unrecognized directories. */
            }
        }
        const date = entry.acquiredAt.slice(0, 10);
        const catalog = await sentinel.searchCatalog({
            bbox: entry.bbox,
            datetime: `${date}T00:00:00Z/${date}T23:59:59Z`,
            limit: 5,
        });
        const selected = catalog.features?.find(
            (f) =>
                Math.abs(
                    Date.parse(f.properties?.datetime) -
                        Date.parse(entry.acquiredAt),
                ) < 1000,
        );
        if (!selected)
            throw new Error(
                'Selected acquisition not returned by bounded catalog search',
            );
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osis-cdse-'));
        await fs.writeFile(
            path.join(directory, 'osis-cache.json'),
            JSON.stringify({
                owner: 'osis-cdse-v1',
                expires: Date.now() + 3600000,
            }),
        );
        const paths = {};
        // Two sequential AOI-cropped outputs for ONE acquisition; never a SAFE archive.
        for (const pol of ['vv', 'vh']) {
            const result = await sentinel.getSentinel1GrdImage({
                bbox: entry.bbox,
                from: entry.acquiredAt,
                to: new Date(
                    Date.parse(entry.acquiredAt) + 30000,
                ).toISOString(),
                polarization: pol.toUpperCase(),
            });
            paths[pol] = path.join(directory, `${pol}.tif`);
            await fs.writeFile(paths[pol], result.buffer, { flag: 'wx' });
        }
        scene.catalogId = String(selected.id).slice(0, 240);
        scene.selectionMeaning =
            'Catalog acquisition time; Process API 30-second acquisition window, AOI cropped on provider';
        cache = {
            id: entry.id,
            scene,
            paths,
            directory,
            expires: Date.now() + 3600000,
        };
        const owned = directory;
        const timer = setTimeout(() => {
            if (cache?.directory === owned) cache = null;
            fs.rm(owned, { recursive: true, force: true }).catch(() => {});
        }, 3600000);
        timer.unref();
        return { _scene: scene, _paths: paths };
    } catch {
        if (directory) await fs.rm(directory, { recursive: true, force: true });
        return {
            _scene: scene,
            _unavailable:
                'REAL_DATA_UNAVAILABLE: bounded CDSE search/process request failed; verify credentials, quota, acquisition availability and network; retry after 60 seconds',
        };
    } finally {
        busy = false;
    }
}
module.exports = { upload, onDemand };
