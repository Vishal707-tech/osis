const pool = require('./src/config/db');

async function seed() {
  console.log('Seeding initial data into PostgreSQL...');

  // 1. Spills
  const spills = [
    {
      id: 1,
      polygonWkt: 'POLYGON((72.408 15.268, 72.441 15.281, 72.478 15.272, 72.499 15.246, 72.487 15.213, 72.452 15.196, 72.418 15.206, 72.399 15.236, 72.408 15.268))',
      centroidWkt: 'POINT(72.451 15.234)',
      area_sqm: 12400000,
      confidence: 94,
      estimated_age_hours: 7.5,
      detected_at: '2026-09-04 05:30:00',
      satellite_source: 'Sentinel-1',
      status: 'active'
    },
    {
      id: 2,
      polygonWkt: 'POLYGON((73.11 16.50, 73.13 16.50, 73.13 16.52, 73.11 16.52, 73.11 16.50))',
      centroidWkt: 'POINT(73.120 16.512)',
      area_sqm: 3100000,
      confidence: 82,
      estimated_age_hours: 3.0,
      detected_at: '2026-09-03 11:15:00',
      satellite_source: 'Sentinel-2',
      status: 'monitored'
    },
    {
      id: 3,
      polygonWkt: 'POLYGON((71.98 14.88, 72.00 14.88, 72.00 14.90, 71.98 14.90, 71.98 14.88))',
      centroidWkt: 'POINT(71.990 14.890)',
      area_sqm: 25600000,
      confidence: 98,
      estimated_age_hours: 15.0,
      detected_at: '2026-09-02 08:45:00',
      satellite_source: 'Sentinel-1',
      status: 'cleanup'
    }
  ];

  for (const s of spills) {
    await pool.query(`
      INSERT INTO spills (id, geom, centroid, area_sqm, confidence, estimated_age_hours, detected_at, satellite_source, status)
      VALUES ($1, ST_GeomFromText($2, 4326), ST_GeomFromText($3, 4326), $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        geom = EXCLUDED.geom,
        centroid = EXCLUDED.centroid,
        area_sqm = EXCLUDED.area_sqm,
        confidence = EXCLUDED.confidence,
        estimated_age_hours = EXCLUDED.estimated_age_hours,
        detected_at = EXCLUDED.detected_at,
        satellite_source = EXCLUDED.satellite_source,
        status = EXCLUDED.status;
    `, [s.id, s.polygonWkt, s.centroidWkt, s.area_sqm, s.confidence, s.estimated_age_hours, s.detected_at, s.satellite_source, s.status]);
  }
  console.log('✅ Spills seeded (3 rows)');

  // 2. Vessels
  const vessels = [
    { mmsi: 419008472, imo: 9312044, name: 'MT Kaveri Star', vessel_type: 'Crude oil tanker', flag: 'India' },
    { mmsi: 563114900, imo: 9541289, name: 'Ocean Meridian', vessel_type: 'Bulk carrier', flag: 'Singapore' },
    { mmsi: 470221830, imo: 9483321, name: 'Al Nahda II', vessel_type: 'Product tanker', flag: 'UAE' },
    { mmsi: 419770021, imo: null, name: 'Sagar Pravah', vessel_type: 'Fishing trawler', flag: 'India' },
    { mmsi: 352998117, imo: 9621430, name: 'Pacific Harrier', vessel_type: 'Container ship', flag: 'Panama' }
  ];

  for (const v of vessels) {
    await pool.query(`
      INSERT INTO vessels (mmsi, imo, name, vessel_type, flag)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (mmsi) DO UPDATE SET
        imo = EXCLUDED.imo,
        name = EXCLUDED.name,
        vessel_type = EXCLUDED.vessel_type,
        flag = EXCLUDED.flag;
    `, [v.mmsi, v.imo, v.name, v.vessel_type, v.flag]);
  }
  console.log('✅ Vessels seeded (5 rows)');

  // 3. Vessel Tracks for candidates
  const tracks = [
    // MT Kaveri Star
    {
      mmsi: 419008472, speed: 11.4, heading: 248, points: [
        { lon: 72.741, lat: 15.372, time: '2026-09-03 21:00:00' },
        { lon: 72.702, lat: 15.351, time: '2026-09-03 21:45:00' },
        { lon: 72.668, lat: 15.332, time: '2026-09-03 22:30:00' },
        { lon: 72.630, lat: 15.309, time: '2026-09-03 23:15:00' },
        { lon: 72.588, lat: 15.290, time: '2026-09-04 03:00:00' },
        { lon: 72.541, lat: 15.271, time: '2026-09-04 05:05:00' },
      ]
    },
    // Ocean Meridian
    {
      mmsi: 563114900, speed: 13.1, heading: 202, points: [
        { lon: 72.512, lat: 15.451, time: '2026-09-04 02:00:00' },
        { lon: 72.505, lat: 15.409, time: '2026-09-04 02:50:00' },
        { lon: 72.498, lat: 15.366, time: '2026-09-04 03:40:00' },
        { lon: 72.492, lat: 15.322, time: '2026-09-04 04:30:00' },
        { lon: 72.487, lat: 15.281, time: '2026-09-04 05:28:00' },
      ]
    },
    // Al Nahda II
    {
      mmsi: 470221830, speed: 9.6, heading: 271, points: [
        { lon: 72.309, lat: 15.148, time: '2026-09-04 01:15:00' },
        { lon: 72.352, lat: 15.161, time: '2026-09-04 02:05:00' },
        { lon: 72.398, lat: 15.172, time: '2026-09-04 02:55:00' },
        { lon: 72.444, lat: 15.181, time: '2026-09-04 03:45:00' },
        { lon: 72.489, lat: 15.190, time: '2026-09-04 04:41:00' },
      ]
    },
    // Sagar Pravah
    {
      mmsi: 419770021, speed: 4.2, heading: 61, points: [
        { lon: 72.348, lat: 15.302, time: '2026-09-04 02:00:00' },
        { lon: 72.372, lat: 15.312, time: '2026-09-04 03:10:00' },
        { lon: 72.397, lat: 15.318, time: '2026-09-04 04:20:00' },
        { lon: 72.421, lat: 15.327, time: '2026-09-04 05:30:00' },
      ]
    },
    // Pacific Harrier
    {
      mmsi: 352998117, speed: 16.8, heading: 154, points: [
        { lon: 72.601, lat: 15.061, time: '2026-09-04 04:00:00' },
        { lon: 72.634, lat: 15.090, time: '2026-09-04 04:25:00' },
        { lon: 72.664, lat: 15.121, time: '2026-09-04 04:55:00' },
        { lon: 72.693, lat: 15.152, time: '2026-09-04 05:22:00' },
      ]
    }
  ];

  await pool.query('DELETE FROM vessel_tracks;');
  for (const t of tracks) {
    for (const pt of t.points) {
      await pool.query(`
        INSERT INTO vessel_tracks (mmsi, timestamp, geom, speed, heading)
        VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6);
      `, [t.mmsi, pt.time, pt.lon, pt.lat, t.speed, t.heading]);
    }
  }
  console.log('✅ Vessel tracks seeded');

  // 4. Drift predictions for SP-001 (reverse backtracking)
  const driftPoints = [
    { hoursAgo: 0, lat: 15.234, lon: 72.451, time: '2026-09-04 05:30:00' },
    { hoursAgo: 1, lat: 15.246, lon: 72.472, time: '2026-09-04 04:30:00' },
    { hoursAgo: 2, lat: 15.259, lon: 72.494, time: '2026-09-04 03:30:00' },
    { hoursAgo: 3, lat: 15.271, lon: 72.518, time: '2026-09-04 02:30:00' },
    { hoursAgo: 4, lat: 15.280, lon: 72.544, time: '2026-09-04 01:30:00' },
    { hoursAgo: 5, lat: 15.288, lon: 72.571, time: '2026-09-04 00:30:00' },
    { hoursAgo: 6, lat: 15.294, lon: 72.598, time: '2026-09-03 23:30:00' },
    { hoursAgo: 7, lat: 15.301, lon: 72.624, time: '2026-09-03 22:30:00' },
    { hoursAgo: 8, lat: 15.309, lon: 72.649, time: '2026-09-03 21:30:00' },
    { hoursAgo: 9, lat: 15.318, lon: 72.673, time: '2026-09-03 20:30:00' }
  ];

  await pool.query('DELETE FROM drift_predictions WHERE spill_id = 1;');
  for (const dp of driftPoints) {
    await pool.query(`
      INSERT INTO drift_predictions (spill_id, timestamp, geom, direction)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5);
    `, [1, dp.time, dp.lon, dp.lat, 'backward']);
  }
  console.log('✅ Drift predictions seeded for SP-001 (10 trajectory points)');

  // 5. Spill Vessel Attribution for SP-001
  const attributions = [
    {
      spill_id: 1,
      mmsi: 419008472, // MT Kaveri Star
      distance_from_origin_m: 800,
      time_difference_minutes: 15,
      trajectory_score: 96,
      behavior_score: 88,
      responsibility_score: 92
    },
    {
      spill_id: 1,
      mmsi: 470221830, // Al Nahda II
      distance_from_origin_m: 8600,
      time_difference_minutes: 45,
      trajectory_score: 71,
      behavior_score: 79,
      responsibility_score: 74
    },
    {
      spill_id: 1,
      mmsi: 563114900, // Ocean Meridian
      distance_from_origin_m: 14200,
      time_difference_minutes: 80,
      trajectory_score: 58,
      behavior_score: 22,
      responsibility_score: 47
    },
    {
      spill_id: 1,
      mmsi: 352998117, // Pacific Harrier
      distance_from_origin_m: 21500,
      time_difference_minutes: 120,
      trajectory_score: 24,
      behavior_score: 15,
      responsibility_score: 28
    },
    {
      spill_id: 1,
      mmsi: 419770021, // Sagar Pravah
      distance_from_origin_m: 28000,
      time_difference_minutes: 180,
      trajectory_score: 30,
      behavior_score: 2,
      responsibility_score: 12
    }
  ];

  for (const a of attributions) {
    await pool.query(`
      INSERT INTO spill_vessel_attribution (spill_id, mmsi, distance_from_origin_m, time_difference_minutes, trajectory_score, behavior_score, responsibility_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (spill_id, mmsi) DO UPDATE SET
        distance_from_origin_m = EXCLUDED.distance_from_origin_m,
        time_difference_minutes = EXCLUDED.time_difference_minutes,
        trajectory_score = EXCLUDED.trajectory_score,
        behavior_score = EXCLUDED.behavior_score,
        responsibility_score = EXCLUDED.responsibility_score;
    `, [a.spill_id, a.mmsi, a.distance_from_origin_m, a.time_difference_minutes, a.trajectory_score, a.behavior_score, a.responsibility_score]);
  }
  console.log('✅ Spill-Vessel Attributions seeded for SP-001 (5 records)');

  console.log('🎉 Database seeding complete!');
  await pool.end();
}

seed().catch(err => {
  console.error('❌ Seeding error:', err);
  process.exit(1);
});
