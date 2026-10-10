'use strict';

const WebSocket = require('ws');
const pool = require('../config/db');

class AISService {
  constructor() {
    this.ws = null;
    this.isActive = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.cleanupTimer = null;
    this.batch = [];
    this.batchTimer = null;
  }

  start() {
    if (this.isActive) return;
    const apiKey = process.env.AISSTREAM_API_KEY;
    if (!apiKey) {
      console.warn('[ais] AISSTREAM_API_KEY not set. Live AIS ingestion disabled.');
      return;
    }

    console.log('[ais] Starting live AIS ingestion...');
    this.isActive = true;
    this.connect();
    
    // Cleanup every 30 minutes (3 days retention)
    this.cleanupTimer = setInterval(() => this.cleanup(), 30 * 60 * 1000);
  }

  stop() {
    this.isActive = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.flushBatch(); // Try to flush any remaining
    console.log('[ais] Live AIS ingestion stopped.');
  }

  normalizeTimestamp(timeStr) {
    if (!timeStr) return null;
    let clean = timeStr;
    if (clean.includes(' +0000 UTC')) {
      clean = clean.replace(' +0000 UTC', 'Z');
      clean = clean.replace(' ', 'T');
      clean = clean.replace(/(\.\d{3})\d+Z$/, '$1Z');
    }
    const d = new Date(clean);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  connect() {
    if (!this.isActive) return;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const apiKey = process.env.AISSTREAM_API_KEY;
    const url = process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream';
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[ais] Connected to AISStream.');
      this.reconnectAttempts = 0;
      
      const subscriptionMessage = {
        Apikey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]], // Global for now or can be bounded
        FiltersShipMMSI: [],
        FilterMessageTypes: ["PositionReport"]
      };
      this.ws.send(JSON.stringify(subscriptionMessage));
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.MessageType === 'PositionReport') {
          const report = message.Message.PositionReport;
          const mmsi = message.MetaData.MMSI;
          const lat = report.Latitude;
          const lon = report.Longitude;
          const rawTime = message.MetaData.time_utc;
          const time = this.normalizeTimestamp(rawTime);
          
          if (!time) {
            console.error(`[ais] Invalid timestamp received: ${rawTime}`);
            return;
          }
          
          let speed = null;
          if (typeof report.Sog === 'number' && !isNaN(report.Sog) && report.Sog !== 102.3) {
            speed = report.Sog;
          }
          let course = null;
          if (typeof report.Cog === 'number' && !isNaN(report.Cog) && report.Cog !== 360) {
            course = report.Cog;
          }
          
          if (lat != null && lon != null && mmsi) {
             this.batch.push({ mmsi, time, lat, lon, speed, course });
             this.scheduleFlush();
          }
        }
      } catch (err) {
        // Ignore malformed messages silently
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[ais] WebSocket error:', err.message);
      // error will trigger close
    });
  }

  scheduleReconnect() {
    if (!this.isActive) return;
    if (this.reconnectTimer) return;

    // Backoff: 5, 10, 20, 40, 60
    let delay = 5000 * Math.pow(2, this.reconnectAttempts);
    if (delay > 60000) delay = 60000;
    
    console.log(`[ais] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  scheduleFlush() {
    if (this.batchTimer) return;
    // Flush every 2 seconds
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, 2000);
  }

  async flushBatch() {
    if (this.batch.length === 0) return;
    const currentBatch = [...this.batch];
    this.batch = [];

    try {
      const values = [];
      let queryParams = [];
      let i = 1;
      for (const row of currentBatch) {
        values.push(`($${i++}, $${i++}, ST_SetSRID(ST_MakePoint($${i++}, $${i++}), 4326), $${i++}, $${i++})`);
        queryParams.push(row.mmsi, row.time, row.lon, row.lat, row.speed, row.course);
      }
      
      const query = `
        INSERT INTO live_ais (mmsi, timestamp, geom, speed, course) 
        VALUES ${values.join(', ')}
      `;
      await pool.query(query, queryParams);
    } catch (err) {
      console.error('[ais] Database flush error:', err.message);
    }
  }

  async cleanup() {
    try {
      await pool.query(`DELETE FROM live_ais WHERE timestamp < NOW() - INTERVAL '3 days'`);
    } catch (err) {
      console.error('[ais] Cleanup error:', err.message);
    }
  }
}

module.exports = new AISService();
