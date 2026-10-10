-- ==============================================================================
-- O.S.I.S. (Oil Spill Identification System)
-- Migration 004: Sentinel-1 Scene Ingestion & Deduplication
-- ==============================================================================
-- Description:
--   Creates the `processed_scenes` table that acts as the deduplication
--   registry and work-queue for autonomous Sentinel-1 GRD scene ingestion
--   from the Copernicus Data Space Ecosystem (CDSE).
--
--   Lifecycle:
--     queued   -> (Day 2 worker picks up)
--     processing
--     completed | failed
--
-- Safety:
--   Idempotent script (uses IF NOT EXISTS / DO-blocks). Safe to re-run.
-- ==============================================================================

-- 1. Core scene registry / deduplication table
CREATE TABLE IF NOT EXISTS processed_scenes (
    id              SERIAL PRIMARY KEY,

    -- STAC feature identity -- unique per CDSE scene
    scene_id        TEXT NOT NULL,
    collection      TEXT NOT NULL DEFAULT 'sentinel-1-grd',

    -- Acquisition geometry & time (from STAC properties)
    bbox            JSONB,
    footprint       GEOMETRY(Polygon, 4326),
    acquired_at     TIMESTAMPTZ,
    platform        TEXT,
    orbit_direction TEXT,
    polarization    TEXT,

    -- Queue lifecycle
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processing_at   TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    -- Optional link to downstream result
    incident_id     UUID REFERENCES osis_incidents(id) ON DELETE SET NULL,

    -- Error tracking
    error_message   TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,

    -- Raw STAC feature snapshot for auditability
    stac_feature    JSONB,

    -- Deduplication: one row per scene_id+collection
    CONSTRAINT processed_scenes_unique_scene UNIQUE (scene_id, collection)
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_processed_scenes_status
    ON processed_scenes (status);

CREATE INDEX IF NOT EXISTS idx_processed_scenes_acquired_at
    ON processed_scenes (acquired_at DESC);

CREATE INDEX IF NOT EXISTS idx_processed_scenes_queued_at
    ON processed_scenes (queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_processed_scenes_footprint
    ON processed_scenes USING GIST (footprint)
    WHERE footprint IS NOT NULL;

-- 3. Poller state table -- persists last poll window so restarts do not re-scan
CREATE TABLE IF NOT EXISTS ingestion_state (
    singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    last_polled_at  TIMESTAMPTZ,
    last_scene_at   TIMESTAMPTZ,
    poll_count      INTEGER NOT NULL DEFAULT 0,
    scenes_queued   INTEGER NOT NULL DEFAULT 0
);

-- Ensure exactly one row exists
INSERT INTO ingestion_state (singleton) VALUES (TRUE)
    ON CONFLICT (singleton) DO NOTHING;

-- ==============================================================================
-- End of Migration 004
-- ==============================================================================
