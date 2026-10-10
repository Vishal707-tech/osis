-- 006_incident_idempotency.sql
-- Create backup of ALL rows that belong to a duplicate group before deletion
CREATE TABLE IF NOT EXISTS _osis_incidents_backup_dups AS
SELECT * FROM osis_incidents
WHERE report->'scene'->>'id' IN (
    SELECT report->'scene'->>'id'
    FROM osis_incidents
    GROUP BY 1
    HAVING count(*) > 1
);

-- Delete non-canonical duplicates
-- 1. Keep if it is linked from processed_scenes
-- 2. If multiple are not linked, keep the one with max(detected_at)
WITH dups AS (
    SELECT report->'scene'->>'id' as scene_id
    FROM osis_incidents
    GROUP BY 1
    HAVING count(*) > 1
),
ranked AS (
    SELECT 
        i.id,
        i.report->'scene'->>'id' as scene_id,
        CASE WHEN ps.incident_id = i.id THEN 1 ELSE 0 END as is_linked,
        i.detected_at,
        ROW_NUMBER() OVER (
            PARTITION BY i.report->'scene'->>'id' 
            ORDER BY 
                CASE WHEN ps.incident_id = i.id THEN 1 ELSE 0 END DESC,
                i.detected_at DESC
        ) as rn
    FROM osis_incidents i
    LEFT JOIN processed_scenes ps ON ps.scene_id = i.report->'scene'->>'id'
    WHERE i.report->'scene'->>'id' IN (SELECT scene_id FROM dups)
)
DELETE FROM osis_incidents
WHERE id IN (
    SELECT id FROM ranked WHERE rn > 1
);

-- Add scene_id column
ALTER TABLE osis_incidents ADD COLUMN scene_id TEXT;

-- Backfill scene_id
UPDATE osis_incidents SET scene_id = report->'scene'->>'id';

-- Ensure no NULLs and apply constraint
ALTER TABLE osis_incidents ALTER COLUMN scene_id SET NOT NULL;
ALTER TABLE osis_incidents ADD CONSTRAINT osis_incidents_scene_id_key UNIQUE(scene_id);
