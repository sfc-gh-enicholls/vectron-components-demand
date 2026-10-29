-- =====================================================================
-- Vectron Components — Demand Planning
-- 12: Planning cycles and signed-off snapshots
-- =====================================================================
--
-- A cycle is one weekly S&OP round, keyed by the week the actuals end
-- (V_CONTEXT.HISTORY_END_WEEK). It is open while the plan is being worked,
-- in_review once sign-off has been requested, and signed_off once the S&OP
-- lead approves. Sign-off writes an immutable copy of the committed plan to
-- FACT_PLAN_SNAPSHOT, which is what "current plan vs last sign-off" compares
-- against.
--
-- FACT_DEMAND_PLAN keeps no history (03 rebuilds it and forecast.py truncates
-- it), so without this table there is no record of what was agreed.
--
-- Like 05 and 06, everything here is IF NOT EXISTS: cycle and snapshot state
-- must survive a data rebuild. The promote and sign-off procedures live in
-- 13-approvals.sql because both refuse to run without an approved request.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_PLAN_CYCLE — one row per S&OP cycle.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DIM_PLAN_CYCLE (
  CYCLE_WEEK          VARCHAR(10)  PRIMARY KEY,
  -- open | in_review | signed_off
  STATUS              VARCHAR(20)  NOT NULL DEFAULT 'open',
  OPENED_AT           TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  SIGNED_OFF_BY       VARCHAR(80),
  SIGNED_OFF_AT       TIMESTAMP_NTZ,
  -- Written at sign-off and asserted by the integrity checks below, so a
  -- snapshot that lost or gained rows afterwards is detectable.
  SNAPSHOT_ROWS       NUMBER(10,0),
  SNAPSHOT_UNITS      NUMBER(16,2),
  -- signoff: approved in the app. backfill: reconstructed for a closed cycle
  -- from that cycle's CONSENSUS forecast vintage (see 12/Task 7 notes).
  SNAPSHOT_SOURCE     VARCHAR(20),
  APPROVAL_REQUEST_ID VARCHAR(40)
);

-- ---------------------------------------------------------------------
-- FACT_PLAN_SNAPSHOT — the committed plan as signed off. Never updated.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_PLAN_SNAPSHOT (
  CYCLE_WEEK     VARCHAR(10)  NOT NULL,
  SERIES_ID      VARCHAR(80)  NOT NULL,
  WEEK_ID        VARCHAR(10)  NOT NULL,
  STAT_UNITS     NUMBER(14,2),
  OVERRIDE_UNITS NUMBER(14,2),
  PLAN_UNITS     NUMBER(14,2) NOT NULL,
  SNAPSHOT_AT    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (CYCLE_WEEK, SERIES_ID, WEEK_ID)
);

-- The live cycle is opened if it does not exist yet. Re-running this file
-- never reopens a cycle that has already been signed off.
MERGE INTO DIM_PLAN_CYCLE AS target
USING (SELECT HISTORY_END_WEEK AS CYCLE_WEEK FROM APP.V_CONTEXT) AS source
ON target.CYCLE_WEEK = source.CYCLE_WEEK
WHEN NOT MATCHED THEN INSERT (CYCLE_WEEK, STATUS) VALUES (source.CYCLE_WEEK, 'open');

USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_PLAN_CYCLE — cycles with the live one flagged.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_PLAN_CYCLE AS
SELECT c.CYCLE_WEEK,
       c.STATUS,
       c.OPENED_AT,
       c.SIGNED_OFF_BY,
       c.SIGNED_OFF_AT,
       c.SNAPSHOT_ROWS,
       c.SNAPSHOT_UNITS,
       c.SNAPSHOT_SOURCE,
       c.APPROVAL_REQUEST_ID,
       c.CYCLE_WEEK = ctx.HISTORY_END_WEEK AS IS_CURRENT
FROM CORE.DIM_PLAN_CYCLE c
CROSS JOIN V_CONTEXT ctx;

-- ---------------------------------------------------------------------
-- V_PLAN_VS_SIGNOFF — current committed plan against the latest signed-off
-- snapshot, at series x week, carrying the hierarchy so the UI can scope it.
--
-- SIGNOFF_UNITS is NULL where the last sign-off did not cover that week
-- (it was beyond that cycle's horizon). That is reported as "not covered",
-- never as zero, because a zero would read as a cut.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_PLAN_VS_SIGNOFF AS
WITH last_signoff AS (
  SELECT MAX(CYCLE_WEEK) AS CYCLE_WEEK
  FROM CORE.DIM_PLAN_CYCLE
  WHERE STATUS = 'signed_off'
)
SELECT ls.CYCLE_WEEK                     AS SIGNOFF_CYCLE_WEEK,
       p.SERIES_ID,
       p.WEEK_ID,
       s.CATEGORY_NAME,
       s.PRODUCT_NAME,
       s.CUSTOMER_NAME,
       s.CHANNEL_NAME,
       p.PLAN_UNITS                      AS CURRENT_UNITS,
       snap.PLAN_UNITS                   AS SIGNOFF_UNITS,
       IFF(snap.PLAN_UNITS IS NULL, NULL, p.PLAN_UNITS - snap.PLAN_UNITS) AS DELTA_UNITS
FROM CORE.FACT_DEMAND_PLAN p
JOIN V_SERIES s ON s.SERIES_ID = p.SERIES_ID
CROSS JOIN last_signoff ls
LEFT JOIN CORE.FACT_PLAN_SNAPSHOT snap
  ON snap.CYCLE_WEEK = ls.CYCLE_WEEK
 AND snap.SERIES_ID = p.SERIES_ID
 AND snap.WEEK_ID = p.WEEK_ID;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_CYCLES
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_CYCLES AS
-- A signed-off cycle's snapshot still has exactly the rows recorded at sign-off.
SELECT 'snapshot_row_count' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM CORE.DIM_PLAN_CYCLE c
LEFT JOIN (
  SELECT CYCLE_WEEK, COUNT(*) AS N, SUM(PLAN_UNITS) AS UNITS
  FROM CORE.FACT_PLAN_SNAPSHOT GROUP BY 1
) s ON s.CYCLE_WEEK = c.CYCLE_WEEK
WHERE c.STATUS = 'signed_off'
  AND (COALESCE(s.N, 0) <> COALESCE(c.SNAPSHOT_ROWS, -1)
       OR ABS(COALESCE(s.UNITS, 0) - COALESCE(c.SNAPSHOT_UNITS, 0))
          > GREATEST(1.0, ABS(COALESCE(c.SNAPSHOT_UNITS, 0)) * 1e-9))
UNION ALL
-- Only a signed-off cycle may own snapshot rows.
SELECT 'snapshot_unsigned_cycle', COUNT(*)
FROM CORE.FACT_PLAN_SNAPSHOT s
LEFT JOIN CORE.DIM_PLAN_CYCLE c ON c.CYCLE_WEEK = s.CYCLE_WEEK
WHERE c.CYCLE_WEEK IS NULL OR c.STATUS <> 'signed_off'
UNION ALL
-- While the live cycle is signed off, the committed plan must equal its
-- snapshot: the lock held.
SELECT 'signed_off_plan_drift', COUNT(*)
FROM CORE.FACT_DEMAND_PLAN p
JOIN V_CONTEXT ctx ON TRUE
JOIN CORE.DIM_PLAN_CYCLE c
  ON c.CYCLE_WEEK = ctx.HISTORY_END_WEEK AND c.STATUS = 'signed_off'
LEFT JOIN CORE.FACT_PLAN_SNAPSHOT s
  ON s.CYCLE_WEEK = c.CYCLE_WEEK AND s.SERIES_ID = p.SERIES_ID AND s.WEEK_ID = p.WEEK_ID
WHERE s.SERIES_ID IS NULL OR ABS(s.PLAN_UNITS - p.PLAN_UNITS) >= 0.005
UNION ALL
-- At most one cycle is being worked at a time.
SELECT 'single_open_cycle', GREATEST(COUNT(*) - 1, 0)
FROM CORE.DIM_PLAN_CYCLE
WHERE STATUS IN ('open', 'in_review')
UNION ALL
SELECT 'cycle_status_domain', COUNT(*)
FROM CORE.DIM_PLAN_CYCLE
WHERE STATUS NOT IN ('open', 'in_review', 'signed_off');

-- ---------------------------------------------------------------------
-- V_INTEGRITY_ALL — extended for cycles. Composed, never redefined.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_ALL AS
SELECT CHECK_NAME, VIOLATIONS FROM V_DATA_INTEGRITY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CALLOFFS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_IHS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_SERVICE
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_VALUE
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_DUTY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_SIGNALS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CYCLES;
