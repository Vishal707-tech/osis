const path = require('path');
const fetch = require('./bounded-fetch');
const limits = require('./resource-limits');
function validateSubset(bbox, from, to) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) ||
      !(bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] > -85 && bbox[3] < 85 &&
        bbox[2] > bbox[0] && bbox[3] > bbox[1] && bbox[2] - bbox[0] <= limits.maxAoiDegrees && bbox[3] - bbox[1] <= limits.maxAoiDegrees))
    throw new Error('AOI must be at most 0.2 degrees per side within supported latitudes');
  const duration = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400000) throw new Error('Search interval must be at most 24 hours');
}
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config();

const CDSE_AUTH_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const CDSE_CATALOG_URL = 'https://sh.dataspace.copernicus.eu/catalog/v1/search';
const CDSE_PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Authenticate with Copernicus Data Space Ecosystem using OAuth2 client credentials
 * @returns {Promise<string>} Access token
 */
async function getAccessToken() {
  const clientId = process.env.CDSE_CLIENT_ID?.trim();
  const clientSecret = process.env.CDSE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing CDSE credentials. Please set CDSE_CLIENT_ID and CDSE_CLIENT_SECRET in backend/.env'
    );
  }

  // Return cached token if valid (with 60-second buffer)
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60 * 1000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(CDSE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: params.toString(),
  }, 64 * 1024);

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('CDSE Authentication returned no access_token in response payload');
  }

  cachedToken = data.access_token;
  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  tokenExpiresAt = Date.now() + expiresInSec * 1000;

  return cachedToken;
}

const STAC_PAGE_SIZE = parseInt(process.env.STAC_PAGE_SIZE, 10) || 50;
const STAC_MAX_PAGES = parseInt(process.env.STAC_MAX_PAGES, 10) || 10;

/**
 * Search Copernicus Data Space STAC Catalog for Sentinel-1 scenes
 * @param {Object} options
 * @param {[number, number, number, number]} options.bbox - [minLon, minLat, maxLon, maxLat]
 * @param {string} options.datetime - RFC3339 interval e.g. "2024-09-01T00:00:00Z/2024-09-07T23:59:59Z"
 * @param {number} [options.limit] - Max results to return per page
 * @param {string[]} [options.collections=['sentinel-1-grd']] - Target collections
 */
async function searchCatalog({
  bbox,
  datetime,
  limit = STAC_PAGE_SIZE,
  collections = ['sentinel-1-grd'],
}) {
  const [from, to] = String(datetime).split('/');
  const duration = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400000) throw new Error('Search interval must be at most 24 hours');

  if (bbox !== undefined) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) ||
        !(bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -90 && bbox[3] <= 90 &&
          bbox[2] > bbox[0] && bbox[3] > bbox[1])) {
      throw new Error('Invalid bbox geometry');
    }
  }

  const actualLimit = Math.min(Math.max(1, limit), 500);

  let currentUrl = CDSE_CATALOG_URL;
  let currentMethod = 'POST';
  let currentHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/geo+json',
  };
  let currentBody = JSON.stringify({
    collections,
    bbox,
    datetime,
    limit: actualLimit,
  });

  const allFeatures = [];
  let pagesFetched = 0;
  let nextLink = null;

  while (pagesFetched < STAC_MAX_PAGES) {
    const token = await getAccessToken();
    
    const fetchOptions = {
      method: currentMethod,
      headers: { ...currentHeaders, 'Authorization': `Bearer ${token}` },
    };
    if (currentMethod !== 'GET' && currentMethod !== 'HEAD' && currentBody) {
      fetchOptions.body = currentBody;
    }

    console.log('Sending request to:', currentUrl, 'with method:', currentMethod, 'and body:', currentBody);
    const response = await fetch(currentUrl, fetchOptions);
    const data = await response.json();

    if (data.features && Array.isArray(data.features)) {
      allFeatures.push(...data.features);
    }

    pagesFetched++;

    nextLink = (data.links || []).find(l => l.rel === 'next');
    if (!nextLink) break;

    currentUrl = nextLink.href;
    currentMethod = nextLink.method || 'GET';

    if (nextLink.headers) {
      currentHeaders = { ...nextLink.headers };
    }

    if (nextLink.body) {
      let nextBodyObj;
      if (typeof nextLink.body === 'string') {
        nextBodyObj = JSON.parse(nextLink.body);
      } else {
        nextBodyObj = nextLink.body;
      }
      // Merge with the original search parameters
      currentBody = JSON.stringify({
        collections,
        bbox,
        datetime,
        limit: actualLimit,
        ...nextBodyObj
      });
    } else {
      currentBody = undefined;
    }
  }

  if (nextLink) {
    throw new Error(`Pagination interrupted: maximum pages (${STAC_MAX_PAGES}) reached while more results exist.`);
  }

  return { type: 'FeatureCollection', features: allFeatures };
}

/**
 * Request real Sentinel-1 GRD raster subset via Copernicus Sentinel Hub Process API
 * @param {Object} options
 * @param {[number, number, number, number]} options.bbox - [minLon, minLat, maxLon, maxLat]
 * @param {string} options.from - ISO datetime start e.g. "2024-06-19T00:00:00Z"
 * @param {string} options.to - ISO datetime end e.g. "2024-06-19T23:59:59Z"
 * @param {number} [options.width=512]
 * @param {number} [options.height=512]
 * @param {string} [options.polarization='VV']
 * @returns {Promise<{ buffer: Buffer, contentType: string, status: number }>}
 */
async function getSentinel1GrdImage({
  bbox,
  from,
  to,
  width = 512,
  height = 512,
  polarization = 'VV',
}) {
  validateSubset(bbox, from, to);
  if (width !== 512 || height !== 512 || !['VV', 'VH'].includes(polarization)) throw new Error('Only 512x512 VV/VH SAR subsets are supported');
  const token = await getAccessToken();

  const evalscript = `//VERSION=3
function setup() {
  return {
    input: ["${polarization}"],
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(samples) {
  return [samples.${polarization}];
}`;

  const payload = {
    input: {
      bounds: {
        bbox,
        properties: {
          crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
        },
      },
      data: [
        {
          type: 'sentinel-1-grd',
          dataFilter: {
            timeRange: {
              from,
              to,
            },
          },
        },
      ],
    },
    output: {
      width,
      height,
      responses: [
        {
          identifier: 'default',
          format: {
            type: 'image/tiff',
          },
        },
      ],
    },
    evalscript,
  };

  const response = await fetch(CDSE_PROCESS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'image/tiff',
    },
    body: JSON.stringify(payload),
  });

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  return {
    buffer,
    contentType: response.headers.get('content-type') || 'image/tiff',
    status: response.status,
  };
}

/**
 * Inspect TIFF binary buffer and extract GeoTIFF metadata tags
 * @param {Buffer} buffer
 */
function parseTiffMetadata(buffer) {
  if (!buffer || buffer.length < 8) {
    throw new Error('Invalid buffer size for TIFF header');
  }

  const isLE = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
  const isBE = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;

  if (!isLE && !isBE) {
    throw new Error('Invalid TIFF header magic number');
  }

  const readUint16 = (off) => isBE ? buffer.readUInt16BE(off) : buffer.readUInt16LE(off);
  const readUint32 = (off) => isBE ? buffer.readUInt32BE(off) : buffer.readUInt32LE(off);
  const readDouble = (off) => isBE ? buffer.readDoubleBE(off) : buffer.readDoubleLE(off);

  const ifdOffset = readUint32(4);
  if (ifdOffset >= buffer.length) {
    throw new Error('Corrupted TIFF: IFD offset out of bounds');
  }

  const numEntries = readUint16(ifdOffset);
  const tags = {};
  let tiepointOffset = null;
  let pixelScaleOffset = null;

  for (let i = 0; i < numEntries; i++) {
    const entryOff = ifdOffset + 2 + i * 12;
    if (entryOff + 12 > buffer.length) break;
    const tag = readUint16(entryOff);
    const type = readUint16(entryOff + 2);
    const count = readUint32(entryOff + 4);
    // In TIFF, if data fits in 4 bytes, it's stored in value offset.
    // For type 3 (SHORT, 2 bytes), in big-endian it's at offset, read as uint16.
    const val = type === 3 ? readUint16(entryOff + 8) : readUint32(entryOff + 8);
    tags[tag] = { type, count, val };

    if (tag === 33922) tiepointOffset = readUint32(entryOff + 8);
    if (tag === 33550) pixelScaleOffset = readUint32(entryOff + 8);
  }

  const width = tags[256]?.val || 0;
  const height = tags[257]?.val || 0;
  const bitsPerSample = tags[258]?.val || 0;
  const sampleFormatCode = tags[339]?.val || 0;
  const samplesPerPixel = tags[277]?.val || 1;
  const compression = tags[259]?.val === 32946 ? 'Deflate (Zip)' : tags[259]?.val === 1 ? 'None' : `Code ${tags[259]?.val}`;

  const sampleFormatStr = sampleFormatCode === 3 ? 'FLOAT32 (IEEE 32-bit Floating Point)'
    : sampleFormatCode === 1 ? 'UINT (Unsigned Integer)'
    : sampleFormatCode === 2 ? 'INT (Signed Integer)'
    : `Format Code ${sampleFormatCode}`;

  const isGeoTiff = Boolean(tags[33550] || tags[33922] || tags[34735]);

  let geoBbox = null;
  let pixelScale = null;
  let tiepoint = null;

  if (tiepointOffset && pixelScaleOffset && tiepointOffset + 48 <= buffer.length && pixelScaleOffset + 24 <= buffer.length) {
    tiepoint = [0, 1, 2, 3, 4, 5].map(i => readDouble(tiepointOffset + i * 8));
    pixelScale = [0, 1, 2].map(i => readDouble(pixelScaleOffset + i * 8));

    const minX = Number(tiepoint[3].toFixed(6));
    const maxY = Number(tiepoint[4].toFixed(6));
    const maxX = Number((minX + width * pixelScale[0]).toFixed(6));
    const minY = Number((maxY - height * pixelScale[1]).toFixed(6));
    geoBbox = [minX, minY, maxX, maxY];
  }

  return {
    isTiff: true,
    endianness: isBE ? 'Big-endian' : 'Little-endian',
    width,
    height,
    bitsPerSample,
    samplesPerPixel,
    sampleFormat: sampleFormatStr,
    compression,
    isGeoTiff,
    hasGeoKeys: Boolean(tags[34735]),
    hasModelTiepoint: Boolean(tags[33922]),
    hasModelPixelScale: Boolean(tags[33550]),
    geoBbox,
    pixelScale: pixelScale ? { xDeg: pixelScale[0], yDeg: pixelScale[1] } : null,
    sizeBytes: buffer.length,
    crs: 'EPSG:4326 / WGS84 (OGC CRS84)',
  };
}

module.exports = {
  CDSE_AUTH_URL,
  CDSE_CATALOG_URL,
  CDSE_PROCESS_URL,
  getAccessToken,
  searchCatalog,
  getSentinel1GrdImage,
  parseTiffMetadata,
};
