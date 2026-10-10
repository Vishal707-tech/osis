'use strict';
// Operator settings may LOWER these hard laptop-safe ceilings, never remove them.
const bounded = (key, fallback, ceiling) => {
    const value = Number(process.env[key]);
    return Number.isFinite(value) && value >= 1
        ? Math.min(Math.floor(value), ceiling)
        : fallback;
};
module.exports = {
    analyses: bounded('OSIS_MAX_ANALYSES', 2, 2),
    uploadBytes: bounded('OSIS_UPLOAD_MAX_MIB', 8, 8) * 1024 * 1024,
    downloadBytes: bounded('OSIS_DOWNLOAD_MAX_MIB', 8, 8) * 1024 * 1024,
    requestMs: bounded('OSIS_REQUEST_TIMEOUT_MS', 15000, 60000),
    maxReports: bounded('OSIS_MAX_REPORTS', 100, 100),
    analysesPerMinute: bounded('OSIS_ANALYSES_PER_MINUTE', 20, 30),
    maxAoiDegrees: 0.2,
};
