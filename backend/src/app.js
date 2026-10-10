const express = require('express');
const cors = require('cors');
const pool = require('./config/db');

// Import routes
const healthRoutes = require('./routes/health.routes');
const spillsRoutes = require('./routes/spills.routes');
const detectionRoutes = require('./routes/detection.routes');
const driftRoutes = require('./routes/drift.routes');
const vesselsRoutes = require('./routes/vessels.routes');
const reportsRoutes = require('./routes/reports.routes');
// DAY 1 — autonomous ingestion
const ingestionRoutes = require('./routes/ingestion.routes');
const scenePoller = require('./services/scene-poller.service');
// DAY 2 — autonomous acquisition worker
const workerRoutes = require('./routes/worker.routes');
const sceneWorker = require('./services/scene-worker.service');
const aisService = require('./services/ais.service');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/incidents', require('./routes/incidents.routes'));
app.use('/api/health', healthRoutes);
app.use('/api/spills', spillsRoutes);
app.use('/api/detection', detectionRoutes);
app.use('/api/drift', driftRoutes);
app.use('/api/vessels', vesselsRoutes);
app.use('/api/reports', reportsRoutes);
// DAY 1 — scene ingestion & deduplication queue
app.use('/api/ingestion', ingestionRoutes);
// DAY 2 — scene acquisition worker
app.use('/api/worker', workerRoutes);

const autoStartPoller = process.env.POLLER_AUTOSTART === 'true' || process.env.npm_lifecycle_event === 'start';
if (autoStartPoller) {
  scenePoller.start().catch(err =>
    console.error('[app] Scene poller auto-start failed:', err.message)
  );
}

const autoStartWorker = process.env.OSIS_WORKER_AUTOSTART === 'true' || process.env.npm_lifecycle_event === 'start';
if (autoStartWorker) {
  sceneWorker.startWorker().catch(err =>
    console.error('[app] Scene worker auto-start failed:', err.message)
  );
}

// Auto-start the live AIS ingestion service
if (process.env.AIS_AUTOSTART === 'true') {
  aisService.start();
}

// Basic error handling middleware
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  console.error(`[api] request failed (${status})`);
  res.status(status).json({
    outcome: 'ANALYSIS_INCONCLUSIVE',
    availability: 'PROCESSING_ERROR',
    recovery: 'Review the supported input and resource limits, then retry. No synthetic result was substituted.',
    error: status < 500 || status === 503 || status === 504
      ? err.message : 'Internal Server Error'
  });
});

module.exports = app;
