const pool = require('./src/config/db');

pool.query(`
  SELECT
    COUNT(*) AS reports,
    COUNT(DISTINCT mmsi) AS vessels,
    MIN(timestamp) AS oldest,
    MAX(timestamp) AS newest
  FROM live_ais
  WHERE timestamp >= NOW() - INTERVAL '15 minutes'
`)
    .then(({ rows }) => {
        console.table(rows);
    })
    .catch(console.error)
    .finally(() => pool.end());