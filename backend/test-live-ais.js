const pool = require("./src/config/db");

async function main() {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const query = `
    SELECT
      mmsi,
      ST_Y(geom) AS lat,
      ST_X(geom) AS lon,
      speed,
      course,
      timestamp,
      ST_Distance(
        geom,
        ST_SetSRID(ST_MakePoint(4.9, 52.4), 4326)::geography
      ) AS distance_m
    FROM live_ais
    WHERE timestamp >= $1
      AND ST_DWithin(
        geom,
        ST_SetSRID(ST_MakePoint(4.9, 52.4), 4326)::geography,
        50000
      )
    ORDER BY distance_m ASC
    LIMIT 20
  `;

    const result = await pool.query(query, [since]);

    console.log("Since:", since);
    console.table(result.rows);

    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
});