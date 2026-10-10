BEGIN;

CREATE TABLE IF NOT EXISTS live_ais (
    mmsi VARCHAR(30) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    geom GEOMETRY(Point, 4326) NOT NULL,
    speed DOUBLE PRECISION,
    course DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS live_ais_ts_idx ON live_ais(timestamp);
CREATE INDEX IF NOT EXISTS live_ais_geom_gist ON live_ais USING gist(geom);

COMMIT;
