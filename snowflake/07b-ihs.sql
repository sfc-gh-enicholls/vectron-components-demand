-- =====================================================================
-- Vectron Components — Demand Planning
-- 07b: Outside-in demand from light-vehicle production (IHS layer)
-- =====================================================================
--
-- The tables behind this file are written by scripts/ihs.py:
--   EXT_IHS.DIM_PLATFORM, EXT_IHS.LV_PRODUCTION  SYNTHETIC S&P-style feed
--   CORE.CONTENT_PER_VEHICLE, CORE.PLATFORM_AWARD  Vectron's own master data
--
-- The chain a Tier 1 runs every month:
--   vehicles built (IHS)  x  pieces per vehicle  x  installation rate
--   = demand the vehicle market implies for each OE series
--
-- The installation rate absorbs everything IHS cannot see: Vectron's share
-- of business on a dual-sourced platform, option take rates, regional
-- build splits. It is CALIBRATED, not assumed: realised OE pull over the
-- trailing twelve actual months divided by the IHS-implied volume over the
-- same months. Forward demand then moves with IHS, not with a guess.
--
-- THE SWAP POINT: everything below reads V_LV_PRODUCTION. Today it selects
-- from EXT_IHS (synthetic). With a licensed S&P Global Mobility share,
-- repoint this one view at the share (mapping its platform nameplate codes
-- to PLATFORM_AWARD) and every downstream view, API and page follows.
--
-- Run scripts/ihs.py BEFORE this file.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_LV_PRODUCTION — the swap point. One row per vintage x platform x month.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_LV_PRODUCTION AS
SELECT
  l.VINTAGE_MONTH, l.PLATFORM_ID, p.PLATFORM_NAME, p.CUSTOMER_ID, p.POWERTRAIN,
  p.SOP_MONTH, p.EOP_MONTH,
  l.PROD_MONTH, l.IS_ACTUAL, l.VEHICLES,
  TRUE AS IS_SYNTHETIC
FROM EXT_IHS.LV_PRODUCTION l
JOIN EXT_IHS.DIM_PLATFORM p ON p.PLATFORM_ID = l.PLATFORM_ID;

-- The vintage the planner works from: the most recent publication.
CREATE OR REPLACE VIEW V_LV_LATEST_VINTAGE AS
SELECT MAX(VINTAGE_MONTH) AS VINTAGE_MONTH FROM V_LV_PRODUCTION;

-- ---------------------------------------------------------------------
-- V_OE_MONTHLY — OE series pull and plan by calendar month. Each week is
-- spread over its seven days, so a week straddling two months is split
-- between them; a monthly IHS figure has no four-or-five-week artefact,
-- and neither may the numbers compared with it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_OE_MONTHLY AS
WITH days AS (SELECT SEQ4() AS D FROM TABLE(GENERATOR(ROWCOUNT => 7))),
wk AS (
  SELECT w.WEEK_ID, TO_CHAR(DATEADD(day, days.D, w.WEEK_START_DATE), 'YYYY-MM') AS PROD_MONTH,
         COUNT(*) / 7 AS SHARE
  FROM CORE.DIM_WEEK w CROSS JOIN days
  GROUP BY 1, 2
)
SELECT
  s.SERIES_ID, w.PROD_MONTH,
  SUM(p.UNITS * w.SHARE)       AS ACTUAL_UNITS,
  SUM(d.PLAN_UNITS * w.SHARE)  AS PLAN_UNITS,
  SUM(d.STAT_UNITS * w.SHARE)  AS STAT_UNITS
FROM CORE.DIM_SERIES s
JOIN wk w ON TRUE
LEFT JOIN CORE.FACT_POS_WEEKLY p ON p.SERIES_ID = s.SERIES_ID AND p.WEEK_ID = w.WEEK_ID
LEFT JOIN CORE.FACT_DEMAND_PLAN d ON d.SERIES_ID = s.SERIES_ID AND d.WEEK_ID = w.WEEK_ID
WHERE s.CHANNEL_ID = 'CH-OE'
GROUP BY 1, 2
HAVING SUM(p.UNITS) IS NOT NULL OR SUM(d.PLAN_UNITS) IS NOT NULL;

-- ---------------------------------------------------------------------
-- V_IHS_VEHICLE_CONTENT — vehicles x pieces for every series, vintage
-- and month, before the installation rate.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_IHS_VEHICLE_CONTENT AS
SELECT
  a.SERIES_ID, l.VINTAGE_MONTH, l.PROD_MONTH, l.IS_ACTUAL,
  SUM(l.VEHICLES)                          AS VEHICLES,
  SUM(l.VEHICLES * c.PIECES_PER_VEHICLE)   AS CONTENT_PIECES,
  SUM(IFF(l.POWERTRAIN = 'BEV', l.VEHICLES * c.PIECES_PER_VEHICLE, 0)) AS BEV_CONTENT_PIECES
FROM CORE.PLATFORM_AWARD a
JOIN CORE.DIM_SERIES s          ON s.SERIES_ID = a.SERIES_ID
JOIN CORE.CONTENT_PER_VEHICLE c ON c.PRODUCT_ID = s.PRODUCT_ID
JOIN V_LV_PRODUCTION l          ON l.PLATFORM_ID = a.PLATFORM_ID
GROUP BY 1, 2, 3, 4;

-- ---------------------------------------------------------------------
-- V_IHS_INSTALL_RATE — calibrated per series on the latest vintage, over
-- the twelve most recent months that are actual in BOTH sources.
-- Series with no pull in the window (pre-launch) get no rate and are
-- reported as such, rather than given a made-up one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_IHS_INSTALL_RATE AS
WITH win AS (
  SELECT DISTINCT v.PROD_MONTH
  FROM V_IHS_VEHICLE_CONTENT v, V_LV_LATEST_VINTAGE lv
  WHERE v.VINTAGE_MONTH = lv.VINTAGE_MONTH AND v.IS_ACTUAL
  QUALIFY DENSE_RANK() OVER (ORDER BY v.PROD_MONTH DESC) <= 12
)
SELECT
  v.SERIES_ID,
  SUM(v.CONTENT_PIECES)                        AS CONTENT_PIECES_12M,
  SUM(COALESCE(m.ACTUAL_UNITS, 0))             AS ACTUAL_UNITS_12M,
  SUM(COALESCE(m.ACTUAL_UNITS, 0)) / NULLIF(SUM(v.CONTENT_PIECES), 0) AS INSTALL_RATE
FROM V_IHS_VEHICLE_CONTENT v
JOIN V_LV_LATEST_VINTAGE lv ON lv.VINTAGE_MONTH = v.VINTAGE_MONTH
JOIN win ON win.PROD_MONTH = v.PROD_MONTH
LEFT JOIN V_OE_MONTHLY m ON m.SERIES_ID = v.SERIES_ID AND m.PROD_MONTH = v.PROD_MONTH
GROUP BY 1;

-- ---------------------------------------------------------------------
-- V_IHS_IMPLIED_DEMAND — what each vintage implies for each series.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_IHS_IMPLIED_DEMAND AS
SELECT
  v.SERIES_ID, s.CUSTOMER_ID, s.CUSTOMER_NAME, s.CATEGORY_ID, s.CATEGORY_NAME,
  s.PRODUCT_ID, s.PRODUCT_NAME, s.UNIT_PRICE_EUR,
  v.VINTAGE_MONTH, v.PROD_MONTH, v.IS_ACTUAL, v.VEHICLES, v.CONTENT_PIECES,
  r.INSTALL_RATE,
  v.CONTENT_PIECES     * r.INSTALL_RATE AS IMPLIED_UNITS,
  v.BEV_CONTENT_PIECES * r.INSTALL_RATE AS IMPLIED_BEV_UNITS
FROM V_IHS_VEHICLE_CONTENT v
JOIN V_SERIES s ON s.SERIES_ID = v.SERIES_ID
JOIN V_IHS_INSTALL_RATE r ON r.SERIES_ID = v.SERIES_ID
WHERE r.INSTALL_RATE IS NOT NULL;

-- ---------------------------------------------------------------------
-- V_IHS_GAP — latest vintage against Vectron's own plan, by series and
-- month. Positive gap: Vectron plans MORE than the vehicle market
-- implies. Plan exists only to the end of the planning horizon; beyond
-- that the row carries IHS alone (the long view).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_IHS_GAP AS
SELECT
  i.SERIES_ID, i.CUSTOMER_ID, i.CUSTOMER_NAME, i.CATEGORY_ID, i.CATEGORY_NAME,
  i.PRODUCT_ID, i.PRODUCT_NAME, i.UNIT_PRICE_EUR,
  i.PROD_MONTH, i.IS_ACTUAL,
  i.VEHICLES, i.IMPLIED_UNITS, i.IMPLIED_BEV_UNITS,
  m.ACTUAL_UNITS, m.PLAN_UNITS,
  m.PLAN_UNITS - i.IMPLIED_UNITS AS GAP_UNITS
FROM V_IHS_IMPLIED_DEMAND i
JOIN V_LV_LATEST_VINTAGE lv ON lv.VINTAGE_MONTH = i.VINTAGE_MONTH
LEFT JOIN V_OE_MONTHLY m ON m.SERIES_ID = i.SERIES_ID AND m.PROD_MONTH = i.PROD_MONTH;

-- ---------------------------------------------------------------------
-- V_IHS_VINTAGE_WALK — how the vehicle market's view of a calendar year
-- moved, publication by publication, in Vectron pieces and euros.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_IHS_VINTAGE_WALK AS
SELECT
  CUSTOMER_ID, CUSTOMER_NAME, CATEGORY_ID, CATEGORY_NAME,
  VINTAGE_MONTH, LEFT(PROD_MONTH, 4)::INT AS PROD_YEAR,
  SUM(IMPLIED_UNITS)                  AS IMPLIED_UNITS,
  SUM(IMPLIED_BEV_UNITS)              AS IMPLIED_BEV_UNITS,
  SUM(IMPLIED_UNITS * UNIT_PRICE_EUR) AS IMPLIED_REVENUE_EUR,
  SUM(IMPLIED_BEV_UNITS * UNIT_PRICE_EUR) AS IMPLIED_BEV_REVENUE_EUR
FROM V_IHS_IMPLIED_DEMAND
GROUP BY 1, 2, 3, 4, 5, 6;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_IHS — checks the layer is internally sound.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_IHS AS
SELECT 'ihs_oe_series_awarded' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM CORE.DIM_SERIES s
WHERE s.CHANNEL_ID = 'CH-OE'
  AND NOT EXISTS (SELECT 1 FROM CORE.PLATFORM_AWARD a WHERE a.SERIES_ID = s.SERIES_ID)
UNION ALL
SELECT 'ihs_award_fits_powertrain', COUNT(*)
FROM CORE.PLATFORM_AWARD a
JOIN CORE.DIM_SERIES s          ON s.SERIES_ID = a.SERIES_ID
JOIN CORE.CONTENT_PER_VEHICLE c ON c.PRODUCT_ID = s.PRODUCT_ID
JOIN EXT_IHS.DIM_PLATFORM p     ON p.PLATFORM_ID = a.PLATFORM_ID
WHERE c.FITS_POWERTRAIN <> 'ALL' AND c.FITS_POWERTRAIN <> p.POWERTRAIN
UNION ALL
SELECT 'ihs_award_same_oem', COUNT(*)
FROM CORE.PLATFORM_AWARD a
JOIN CORE.DIM_SERIES s      ON s.SERIES_ID = a.SERIES_ID
JOIN EXT_IHS.DIM_PLATFORM p ON p.PLATFORM_ID = a.PLATFORM_ID
WHERE p.CUSTOMER_ID <> s.CUSTOMER_ID
UNION ALL
SELECT 'ihs_vehicles_non_negative', COUNT(*) FROM EXT_IHS.LV_PRODUCTION WHERE VEHICLES < 0
UNION ALL
-- Calibration closes: implied equals actual over the window, to the piece.
SELECT 'ihs_calibration_closes', COUNT(*)
FROM V_IHS_INSTALL_RATE
WHERE INSTALL_RATE IS NOT NULL
  AND ABS(CONTENT_PIECES_12M * INSTALL_RATE - ACTUAL_UNITS_12M) > 1;

CREATE OR REPLACE VIEW V_INTEGRITY_ALL AS
SELECT CHECK_NAME, VIOLATIONS FROM V_DATA_INTEGRITY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CALLOFFS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_IHS;
