-- =====================================================================
-- Vectron Components — Demand Planning
-- 07: OEM call-offs (EDI delivery schedules)
-- =====================================================================
--
-- FACT_EDI_RELEASE is written by scripts/calloffs.py: one schedule per OE
-- series per week, 12 weeks deep, zoned FIRM (0-2) / TRADE (3-8) /
-- FORECAST (9-12). SYNTHETIC; bias and noise are illustrative.
--
-- The questions this file answers, each as its own view:
--   1. How good is each OEM's schedule, by zone and horizon?   V_CALLOFF_ACCURACY
--   2. Beyond the firm zone, is Vectron's own forecast better
--      than the OEM's release made in the same week?           V_CALLOFF_VS_MODEL
--   3. How much does the call for one week move between
--      releases (the nervousness the plants feel)?             V_CALLOFF_VOLATILITY
--   4. How did the call for a given week evolve?               V_CALLOFF_WATERFALL
--   5. What does a monthly read do to a moving shutdown?       V_MONTHLY_YOY, V_SHUTDOWN_ALIGNED
--
-- Run scripts/calloffs.py BEFORE this file (it creates the fact table).
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_CALLOFF_SCORED — every release line that now has an outturn.
-- Truth is the realised OE pull. Release lines for weeks after the last
-- actual are excluded here; they are live, not scoreable.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CALLOFF_SCORED AS
SELECT
  r.SERIES_ID, r.RELEASE_WEEK_ID, r.TARGET_WEEK_ID, r.HORIZON_WEEKS, r.ZONE,
  s.CUSTOMER_ID, s.CUSTOMER_NAME, s.CATEGORY_NAME, s.PRODUCT_NAME, s.CHANNEL_NAME,
  s.UNIT_PRICE_EUR,
  r.RELEASE_UNITS,
  COALESCE(p.UNITS, 0)                       AS ACTUAL_UNITS,
  r.RELEASE_UNITS - COALESCE(p.UNITS, 0)     AS ERROR_UNITS
FROM CORE.FACT_EDI_RELEASE r
JOIN V_SERIES s ON s.SERIES_ID = r.SERIES_ID
LEFT JOIN CORE.FACT_POS_WEEKLY p
       ON p.SERIES_ID = r.SERIES_ID AND p.WEEK_ID = r.TARGET_WEEK_ID
WHERE r.TARGET_WEEK_ID <= (SELECT HISTORY_END_WEEK FROM V_CONTEXT);

-- ---------------------------------------------------------------------
-- V_CALLOFF_ACCURACY — WAPE and bias by customer, zone and horizon.
-- Bias is signed: positive means the OEM called more than it pulled.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CALLOFF_ACCURACY AS
SELECT
  CUSTOMER_ID, CUSTOMER_NAME, ZONE, HORIZON_WEEKS,
  COUNT(*)                                             AS LINES,
  SUM(ACTUAL_UNITS)                                    AS ACTUAL_UNITS,
  SUM(RELEASE_UNITS)                                   AS RELEASE_UNITS,
  SUM(ABS(ERROR_UNITS)) / NULLIF(SUM(ACTUAL_UNITS), 0) AS WAPE,
  SUM(ERROR_UNITS)      / NULLIF(SUM(ACTUAL_UNITS), 0) AS BIAS
FROM V_CALLOFF_SCORED
GROUP BY 1, 2, 3, 4;

-- ---------------------------------------------------------------------
-- V_CALLOFF_CORRECTED — the OEM release, corrected for that OEM's own
-- track record at that horizon.
--
-- MEASURED FINDING THIS RESPONDS TO: beyond the firm zone the OEM's
-- release beats a statistical model for most customers (the OEM knows its
-- own build schedule), but it is consistently HIGH. So the useful move is
-- not to replace the OEM's number, it is to de-bias it.
--
-- No leakage: the correction for a release made in week R uses only lines
-- whose target week is BEFORE R (their outturn was known when the release
-- arrived), over the trailing 26 weeks, for the same customer and horizon.
-- Lines with fewer than 8 weeks of track record are left uncorrected.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CALLOFF_CORRECTED AS
WITH cb AS (
  SELECT CUSTOMER_ID, HORIZON_WEEKS, TARGET_WEEK_ID,
         SUM(RELEASE_UNITS) AS R, SUM(ACTUAL_UNITS) AS A
  FROM V_CALLOFF_SCORED
  GROUP BY 1, 2, 3
),
factor AS (
  SELECT k.CUSTOMER_ID, k.HORIZON_WEEKS, k.RELEASE_WEEK_ID,
         SUM(cb.R) / NULLIF(SUM(cb.A), 0) AS RATIO,
         COUNT(*)                          AS TRACK_WEEKS
  FROM (SELECT DISTINCT CUSTOMER_ID, HORIZON_WEEKS, RELEASE_WEEK_ID FROM V_CALLOFF_SCORED) k
  JOIN V_WEEK_INDEX rw ON rw.WEEK_ID = k.RELEASE_WEEK_ID
  JOIN cb ON cb.CUSTOMER_ID = k.CUSTOMER_ID AND cb.HORIZON_WEEKS = k.HORIZON_WEEKS
  JOIN V_WEEK_INDEX tw ON tw.WEEK_ID = cb.TARGET_WEEK_ID
  WHERE tw.WEEKS_AGO > rw.WEEKS_AGO AND tw.WEEKS_AGO <= rw.WEEKS_AGO + 26
  GROUP BY 1, 2, 3
)
SELECT c.*,
       f.RATIO AS BIAS_RATIO, f.TRACK_WEEKS,
       IFF(f.TRACK_WEEKS >= 8 AND f.RATIO > 0, c.RELEASE_UNITS / f.RATIO, c.RELEASE_UNITS)
         AS CORRECTED_UNITS
FROM V_CALLOFF_SCORED c
LEFT JOIN factor f
  ON f.CUSTOMER_ID = c.CUSTOMER_ID AND f.HORIZON_WEEKS = c.HORIZON_WEEKS
 AND f.RELEASE_WEEK_ID = c.RELEASE_WEEK_ID;

-- ---------------------------------------------------------------------
-- V_CALLOFF_VS_MODEL — the outside-in question a Tier 1 actually asks:
-- beyond the firm zone, should we plan on the OEM's number or our own?
--
-- Compared like for like: the OEM release made in week R for week R+h
-- against VECTRON_STAT made at origin R with lag h, and against the
-- bias-corrected release. Only horizons the backtest covers (1-8) and
-- origins it covers are included, so no side gets a horizon another lacks.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CALLOFF_VS_MODEL AS
SELECT
  c.CUSTOMER_ID, c.CUSTOMER_NAME, c.ZONE, c.HORIZON_WEEKS,
  COUNT(*)                                                          AS LINES,
  SUM(c.ACTUAL_UNITS)                                               AS ACTUAL_UNITS,
  SUM(ABS(c.ERROR_UNITS)) / NULLIF(SUM(c.ACTUAL_UNITS), 0)          AS OEM_WAPE,
  SUM(ABS(c.CORRECTED_UNITS - c.ACTUAL_UNITS)) / NULLIF(SUM(c.ACTUAL_UNITS), 0)
                                                                    AS CORRECTED_WAPE,
  SUM(ABS(f.FORECAST_UNITS - c.ACTUAL_UNITS)) / NULLIF(SUM(c.ACTUAL_UNITS), 0)
                                                                    AS MODEL_WAPE,
  SUM(c.ERROR_UNITS) / NULLIF(SUM(c.ACTUAL_UNITS), 0)               AS OEM_BIAS,
  SUM(c.CORRECTED_UNITS - c.ACTUAL_UNITS) / NULLIF(SUM(c.ACTUAL_UNITS), 0)
                                                                    AS CORRECTED_BIAS,
  SUM(f.FORECAST_UNITS - c.ACTUAL_UNITS) / NULLIF(SUM(c.ACTUAL_UNITS), 0)
                                                                    AS MODEL_BIAS
FROM V_CALLOFF_CORRECTED c
JOIN ML.FACT_FORECAST f
  ON f.SERIES_ID = c.SERIES_ID
 AND f.MADE_WEEK_ID = c.RELEASE_WEEK_ID
 AND f.TARGET_WEEK_ID = c.TARGET_WEEK_ID
 AND f.MODEL_NAME = 'VECTRON_STAT'
WHERE c.HORIZON_WEEKS BETWEEN 1 AND 8
GROUP BY 1, 2, 3, 4;

-- ---------------------------------------------------------------------
-- V_CALLOFF_VOLATILITY — release-to-release movement for the same week.
--
-- For each target week, how far did the quantity move between consecutive
-- releases? Measured as SUM(|change|) / SUM(quantity), so a large series
-- moving 5% weighs more than a small one moving 40%. This is the number
-- plant schedulers mean when they call a customer "nervous".
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CALLOFF_VOLATILITY AS
WITH seq AS (
  SELECT
    r.SERIES_ID, r.TARGET_WEEK_ID, r.RELEASE_WEEK_ID, r.ZONE, r.RELEASE_UNITS,
    LAG(r.RELEASE_UNITS) OVER (
      PARTITION BY r.SERIES_ID, r.TARGET_WEEK_ID ORDER BY r.RELEASE_WEEK_ID
    ) AS PRIOR_UNITS
  FROM CORE.FACT_EDI_RELEASE r
)
SELECT
  s.CUSTOMER_ID, s.CUSTOMER_NAME, q.ZONE,
  COUNT(*)                                                     AS CHANGES,
  SUM(ABS(q.RELEASE_UNITS - q.PRIOR_UNITS))
    / NULLIF(SUM(q.PRIOR_UNITS), 0)                            AS MEAN_ABS_CHANGE,
  COUNT_IF(ABS(q.RELEASE_UNITS - q.PRIOR_UNITS)
           > 0.10 * NULLIF(q.PRIOR_UNITS, 0)) / COUNT(*)       AS SHARE_OVER_10PCT
FROM seq q
JOIN V_SERIES s ON s.SERIES_ID = q.SERIES_ID
WHERE q.PRIOR_UNITS IS NOT NULL
GROUP BY 1, 2, 3;

-- ---------------------------------------------------------------------
-- V_CALLOFF_WATERFALL — the call for each target week, release by release.
-- Aggregated to customer x target week so the page can draw the classic
-- "how did week 46 converge" view at any customer scope.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CALLOFF_WATERFALL AS
SELECT
  r.SERIES_ID, s.CUSTOMER_ID, s.CUSTOMER_NAME, s.CATEGORY_NAME, s.PRODUCT_NAME,
  s.CHANNEL_NAME,
  r.TARGET_WEEK_ID, r.RELEASE_WEEK_ID, r.HORIZON_WEEKS, r.ZONE, r.RELEASE_UNITS,
  p.UNITS AS ACTUAL_UNITS
FROM CORE.FACT_EDI_RELEASE r
JOIN V_SERIES s ON s.SERIES_ID = r.SERIES_ID
LEFT JOIN CORE.FACT_POS_WEEKLY p
       ON p.SERIES_ID = r.SERIES_ID AND p.WEEK_ID = r.TARGET_WEEK_ID;

-- ---------------------------------------------------------------------
-- V_MONTHLY_YOY — what a monthly report says. OE pull by customer and
-- calendar month, with prior year alongside, so the page can show the
-- "August collapsed" read that a moving shutdown produces.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_MONTHLY_YOY AS
WITH m AS (
  SELECT s.CUSTOMER_ID, s.CUSTOMER_NAME, w.ISO_YEAR AS YEAR, w.CALENDAR_MONTH AS MONTH,
         SUM(p.UNITS) AS UNITS
  FROM CORE.FACT_POS_WEEKLY p
  JOIN V_SERIES s ON s.SERIES_ID = p.SERIES_ID
  JOIN CORE.DIM_WEEK w ON w.WEEK_ID = p.WEEK_ID
  WHERE s.CHANNEL_ID = 'CH-OE'
  GROUP BY 1, 2, 3, 4
)
SELECT m.*, py.UNITS AS PRIOR_YEAR_UNITS,
       m.UNITS / NULLIF(py.UNITS, 0) - 1 AS YOY
FROM m
LEFT JOIN m py
  ON py.CUSTOMER_ID = m.CUSTOMER_ID AND py.YEAR = m.YEAR - 1 AND py.MONTH = m.MONTH;

-- ---------------------------------------------------------------------
-- V_SHUTDOWN_ALIGNED — the same data read the way a planner reads it:
-- weeks counted from the start of that year's summer shutdown. Aligned
-- this way, consecutive years overlay almost exactly, which is the proof
-- that nothing changed except the calendar.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_SHUTDOWN_ALIGNED AS
WITH sd AS (
  SELECT TRIM(c.value) AS CUSTOMER_ID, YEAR(e.EVENT_DATE) AS YEAR,
         e.WEEK_ID AS SHUTDOWN_WEEK_ID, e.EVENT_DATE, e.DURATION_WEEKS
  FROM CORE.DIM_EVENT e,
       LATERAL SPLIT_TO_TABLE(e.CUSTOMER_SCOPE, ',') c
  WHERE e.EVENT_TYPE = 'SHUTDOWN' AND e.EVENT_ID NOT LIKE 'EVT-XMS%'
),
wk AS (
  SELECT s.CUSTOMER_ID, p.WEEK_ID, SUM(p.UNITS) AS UNITS
  FROM CORE.FACT_POS_WEEKLY p
  JOIN V_SERIES s ON s.SERIES_ID = p.SERIES_ID
  WHERE s.CHANNEL_ID = 'CH-OE'
  GROUP BY 1, 2
)
SELECT sd.CUSTOMER_ID, sd.YEAR, sd.SHUTDOWN_WEEK_ID, sd.EVENT_DATE, sd.DURATION_WEEKS,
       wi.WEEKS_AGO - w2.WEEKS_AGO AS OFFSET_WEEKS,
       w2.WEEK_ID, wk.UNITS
FROM sd
JOIN V_WEEK_INDEX wi ON wi.WEEK_ID = sd.SHUTDOWN_WEEK_ID
JOIN V_WEEK_INDEX w2 ON w2.WEEKS_AGO BETWEEN wi.WEEKS_AGO - 8 AND wi.WEEKS_AGO + 6
JOIN wk ON wk.CUSTOMER_ID = sd.CUSTOMER_ID AND wk.WEEK_ID = w2.WEEK_ID;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_CALLOFFS — the assertions this file owns.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_CALLOFFS AS
SELECT 'calloff_oe_only' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM CORE.FACT_EDI_RELEASE r
JOIN CORE.DIM_SERIES s ON s.SERIES_ID = r.SERIES_ID
WHERE s.CHANNEL_ID <> 'CH-OE'
UNION ALL
SELECT 'calloff_zone_matches_horizon', COUNT(*)
FROM CORE.FACT_EDI_RELEASE
WHERE ZONE <> CASE WHEN HORIZON_WEEKS <= 2 THEN 'FIRM'
                   WHEN HORIZON_WEEKS <= 8 THEN 'TRADE' ELSE 'FORECAST' END
UNION ALL
SELECT 'calloff_non_negative', COUNT(*)
FROM CORE.FACT_EDI_RELEASE WHERE RELEASE_UNITS < 0
UNION ALL
-- Every OE series has a release in every release week.
SELECT 'calloff_release_coverage', COUNT(*)
FROM (
  SELECT s.SERIES_ID, rw.RELEASE_WEEK_ID
  FROM CORE.DIM_SERIES s
  CROSS JOIN (SELECT DISTINCT RELEASE_WEEK_ID FROM CORE.FACT_EDI_RELEASE) rw
  WHERE s.CHANNEL_ID = 'CH-OE'
) e
LEFT JOIN (SELECT DISTINCT SERIES_ID, RELEASE_WEEK_ID FROM CORE.FACT_EDI_RELEASE) r
  ON r.SERIES_ID = e.SERIES_ID AND r.RELEASE_WEEK_ID = e.RELEASE_WEEK_ID
WHERE r.SERIES_ID IS NULL;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_ALL — composed, never redefined (later files extend it).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_ALL AS
SELECT CHECK_NAME, VIOLATIONS FROM V_DATA_INTEGRITY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CALLOFFS;
