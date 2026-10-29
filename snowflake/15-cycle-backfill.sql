-- =====================================================================
-- Vectron Components — Demand Planning
-- 15: Backfill signed-off snapshots for the closed cycles
-- =====================================================================
--
-- The app's sign-off workflow (12, 13) only records cycles signed off from
-- now on. The closed cycles already present in the data (the CYCLE_WEEKs in
-- FACT_PLAN_INPUT before the live one) have no snapshot, so "current plan vs
-- last sign-off" would have nothing to compare against.
--
-- Each closed cycle's snapshot is RECONSTRUCTED from the forecast vintages
-- made that week: ML.FACT_FORECAST holds the CONSENSUS forecast (what was
-- agreed) and VECTRON_STAT (what the model said) keyed by MADE_WEEK_ID, so
-- the plan as it stood at each cycle is recoverable exactly. A vintage covers
-- up to eight weeks after it was made, so a backfilled snapshot is short-range;
-- V_PLAN_VS_SIGNOFF reports weeks beyond it as "not covered", never as zero.
--
-- These rows are marked SNAPSHOT_SOURCE = 'backfill' and the UI labels them
-- "reconstructed". V_INTEGRITY_APPROVALS exempts them from the rule that a
-- sign-off needs an approved request, and only them.
--
-- RUN ORDER: after 12-cycles.sql and after forecast.py (which loads the
-- vintages). Idempotent: a cycle that already exists in DIM_PLAN_CYCLE,
-- however it got there, is never touched, so a real sign-off is never
-- overwritten by a reconstruction.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- Created BEFORE the transaction: DDL commits an open transaction in Snowflake.
CREATE OR REPLACE TEMPORARY TABLE TMP_BACKFILL_CYCLES AS
SELECT DISTINCT i.CYCLE_WEEK
FROM FACT_PLAN_INPUT i
WHERE i.CYCLE_WEEK < (SELECT HISTORY_END_WEEK FROM APP.V_CONTEXT)
  AND NOT EXISTS (SELECT 1 FROM DIM_PLAN_CYCLE c WHERE c.CYCLE_WEEK = i.CYCLE_WEEK)
  AND EXISTS (
    SELECT 1 FROM ML.FACT_FORECAST f
    WHERE f.MODEL_NAME = 'CONSENSUS' AND f.MADE_WEEK_ID = i.CYCLE_WEEK
  );

BEGIN TRANSACTION;

INSERT INTO FACT_PLAN_SNAPSHOT (CYCLE_WEEK, SERIES_ID, WEEK_ID, STAT_UNITS, OVERRIDE_UNITS, PLAN_UNITS, SNAPSHOT_AT)
SELECT con.MADE_WEEK_ID,
       con.SERIES_ID,
       con.TARGET_WEEK_ID,
       stat.FORECAST_UNITS,
       -- An override is recorded only where the consensus departed from the model.
       IFF(stat.FORECAST_UNITS IS NULL OR ABS(con.FORECAST_UNITS - stat.FORECAST_UNITS) >= 0.005,
           con.FORECAST_UNITS, NULL),
       con.FORECAST_UNITS,
       DATEADD(day, 2, w.WEEK_END_DATE)::TIMESTAMP_NTZ
FROM ML.FACT_FORECAST con
JOIN TMP_BACKFILL_CYCLES b ON b.CYCLE_WEEK = con.MADE_WEEK_ID
JOIN DIM_WEEK w ON w.WEEK_ID = con.MADE_WEEK_ID
LEFT JOIN ML.FACT_FORECAST stat
  ON stat.MODEL_NAME = 'VECTRON_STAT'
 AND stat.MADE_WEEK_ID = con.MADE_WEEK_ID
 AND stat.SERIES_ID = con.SERIES_ID
 AND stat.TARGET_WEEK_ID = con.TARGET_WEEK_ID
WHERE con.MODEL_NAME = 'CONSENSUS';

INSERT INTO DIM_PLAN_CYCLE (CYCLE_WEEK, STATUS, OPENED_AT, SIGNED_OFF_BY, SIGNED_OFF_AT,
                            SNAPSHOT_ROWS, SNAPSHOT_UNITS, SNAPSHOT_SOURCE, APPROVAL_REQUEST_ID)
SELECT b.CYCLE_WEEK,
       'signed_off',
       w.WEEK_START_DATE::TIMESTAMP_NTZ,
       'Reconstructed (before the app)',
       DATEADD(day, 2, w.WEEK_END_DATE)::TIMESTAMP_NTZ,
       s.N,
       s.UNITS,
       'backfill',
       NULL
FROM TMP_BACKFILL_CYCLES b
JOIN DIM_WEEK w ON w.WEEK_ID = b.CYCLE_WEEK
JOIN (
  SELECT CYCLE_WEEK, COUNT(*) AS N, SUM(PLAN_UNITS) AS UNITS
  FROM FACT_PLAN_SNAPSHOT GROUP BY 1
) s ON s.CYCLE_WEEK = b.CYCLE_WEEK;

COMMIT;

SELECT CYCLE_WEEK, STATUS, SNAPSHOT_SOURCE, SNAPSHOT_ROWS, SNAPSHOT_UNITS
FROM DIM_PLAN_CYCLE ORDER BY CYCLE_WEEK;
