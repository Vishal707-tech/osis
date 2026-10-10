require('dotenv').config();
const app = require('./src/app');

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
  console.log(`Check health status at http://localhost:${PORT}/api/health`);
});

const gracefulShutdown = async (signal) => {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);
  
  // Stop background services
  require('./src/services/scene-poller.service').stop();
  require('./src/services/scene-worker.service').stopWorker();
  require('./src/services/ais.service').stop();
  
  // Close Express server
  server.close(async () => {
    console.log('[server] Express closed.');
    try {
      await require('./src/config/db').end();
      console.log('[server] Database pool closed.');
      process.exit(0);
    } catch (err) {
      console.error('[server] Error during database closure:', err);
      process.exit(1);
    }
  });
  
  // Failsafe timeout
  setTimeout(() => {
    console.error('[server] Forcefully shutting down after 10s');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled Rejection at:', promise, 'reason:', reason);
});

