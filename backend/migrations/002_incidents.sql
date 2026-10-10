-- Additive incident archive. Independent of legacy integer spill IDs.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS osis_incidents (
    id UUID PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL,
    image_at TIMESTAMPTZ NOT NULL,
    spill_geom geometry(Polygon,4326) NOT NULL,
    origin_geom geometry(Point,4326) NOT NULL,
    report JSONB NOT NULL CHECK (report->>'status' = 'completed')
);
CREATE INDEX IF NOT EXISTS osis_incidents_spill_gist ON osis_incidents USING gist(spill_geom);
CREATE INDEX IF NOT EXISTS osis_incidents_origin_gist ON osis_incidents USING gist(origin_geom);
CREATE INDEX IF NOT EXISTS osis_incidents_image_time ON osis_incidents(image_at);
-- JSONB keeps all scientific evidence/provenance as an immutable report snapshot.
-- Views expose normalized per-incident records without duplicating legacy vessels.
CREATE OR REPLACE VIEW osis_spills AS
SELECT id, detected_at, image_at, spill_geom,
       ST_Centroid(spill_geom) AS centroid,
       report->'spill' AS characterization, report->'age' AS age,
       report->'scene' AS image_metadata FROM osis_incidents;
CREATE OR REPLACE VIEW osis_origins AS
SELECT id AS incident_id, origin_geom, report->'origin' AS origin,
       report->'backward' AS backward_trajectory FROM osis_incidents;
CREATE OR REPLACE VIEW osis_drift AS
SELECT id AS incident_id, p->>'timestamp' AS timestamp, p AS position,
       report->'environment' AS environment
FROM osis_incidents CROSS JOIN LATERAL jsonb_array_elements(report->'forward') p;
CREATE OR REPLACE VIEW osis_candidates AS
SELECT id AS incident_id, c->>'mmsi' AS mmsi, c->>'name' AS name,
       (c->>'score')::double precision AS responsibility_score, c AS evidence
FROM osis_incidents CROSS JOIN LATERAL jsonb_array_elements(report->'candidates') c;
CREATE OR REPLACE VIEW osis_ais_positions AS
SELECT incident_id, mmsi, (p->>'timestamp')::timestamptz AS timestamp,
       ST_SetSRID(ST_MakePoint((p->>'longitude')::double precision,
                              (p->>'latitude')::double precision),4326) AS geom,
       p AS observation
FROM osis_candidates CROSS JOIN LATERAL jsonb_array_elements(evidence->'track') p;
CREATE OR REPLACE VIEW osis_ais_anomalies AS
SELECT id AS incident_id, a->>'mmsi' AS mmsi, a AS anomaly
FROM osis_incidents CROSS JOIN LATERAL jsonb_array_elements(report->'anomalies') a;