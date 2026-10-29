-- =====================================================================
-- Vectron Components — Demand Planning
-- 07c: Service parts — intermittent demand, scored honestly
-- =====================================================================
--
-- ML.SERIES_DEMAND_CLASS and the CROSTON / SBA rows in ML.FACT_FORECAST are
-- written by scripts/croston.py (run after forecast.py).
--
-- Why MASE and not WAPE: on a series that is zero most weeks, percentage
-- errors explode or are undefined, and WAPE rewards forecasting zero.
-- MASE (Hyndman & Koehler 2006) scales each model's absolute error by the
-- in-sample mean absolute one-week change of the same series, measured on
-- the window BEFORE the backtest, so it is comparable across series and
-- below 1 means better than a naive "same as last week".
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA APP;

CREATE OR REPLACE VIEW V_DEMAND_CLASS AS
SELECT c.SERIES_ID, c.ADI, c.CV2, c.DEMAND_CLASS, c.WINDOW_FROM, c.WINDOW_TO,
       s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_ID, s.CHANNEL_NAME, s.CATEGORY_NAME,
       s.UNIT_PRICE_EUR,
       c.DEMAND_CLASS IN ('intermittent', 'lumpy') AND s.CHANNEL_ID <> 'CH-OE' AS IS_CROSTON_SCOPE
FROM ML.SERIES_DEMAND_CLASS c
JOIN V_SERIES s ON s.SERIES_ID = c.SERIES_ID;

-- MASE scale per series: mean |y_t - y_{t-1}| over the classification window.
CREATE OR REPLACE VIEW V_MASE_SCALE AS
WITH y AS (
  SELECT p.SERIES_ID, w.WEEK_START_DATE, p.UNITS,
         LAG(p.UNITS) OVER (PARTITION BY p.SERIES_ID ORDER BY w.WEEK_START_DATE) AS PREV
  FROM CORE.FACT_POS_WEEKLY p
  JOIN CORE.DIM_WEEK w ON w.WEEK_ID = p.WEEK_ID
  JOIN ML.SERIES_DEMAND_CLASS c ON c.SERIES_ID = p.SERIES_ID
  WHERE p.WEEK_ID BETWEEN c.WINDOW_FROM AND c.WINDOW_TO
)
SELECT SERIES_ID, AVG(ABS(UNITS - PREV)) AS MASE_SCALE
FROM y WHERE PREV IS NOT NULL
GROUP BY 1;

-- Every backtest forecast for in-scope series, with its outturn. Zero
-- weeks count: FACT_POS_WEEKLY may omit them, so the outturn defaults to 0.
CREATE OR REPLACE VIEW V_SERVICE_SCORED AS
SELECT f.MODEL_NAME, f.SERIES_ID, f.MADE_WEEK_ID, f.TARGET_WEEK_ID, f.LAG_WEEKS,
       f.FORECAST_UNITS, COALESCE(p.UNITS, 0) AS ACTUAL_UNITS,
       f.UPPER_95, d.CHANNEL_ID, d.CUSTOMER_NAME, d.PRODUCT_NAME, d.DEMAND_CLASS
FROM ML.FACT_FORECAST f
JOIN V_DEMAND_CLASS d ON d.SERIES_ID = f.SERIES_ID AND d.IS_CROSTON_SCOPE
LEFT JOIN CORE.FACT_POS_WEEKLY p ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
WHERE f.MODEL_NAME IN ('CROSTON', 'SBA', 'VECTRON_STAT', 'NAIVE_SEASONAL')
  AND f.LAG_WEEKS BETWEEN 1 AND 8
  AND f.TARGET_WEEK_ID <= (SELECT HISTORY_END_WEEK FROM V_CONTEXT)
  -- Only origins where every model has a forecast, so the comparison is
  -- like for like.
  AND EXISTS (SELECT 1 FROM ML.FACT_FORECAST c
              WHERE c.MODEL_NAME = 'CROSTON' AND c.SERIES_ID = f.SERIES_ID
                AND c.MADE_WEEK_ID = f.MADE_WEEK_ID AND c.TARGET_WEEK_ID = f.TARGET_WEEK_ID);

-- Per series and model: MASE, bias as a share of actual, and how often the
-- 95% upper bound covered the week (the stock question for a service part).
CREATE OR REPLACE VIEW V_SERVICE_ACCURACY AS
SELECT s.MODEL_NAME, s.SERIES_ID, s.CHANNEL_ID, s.CUSTOMER_NAME, s.PRODUCT_NAME, s.DEMAND_CLASS,
       COUNT(*)                                          AS N,
       AVG(ABS(s.FORECAST_UNITS - s.ACTUAL_UNITS)) / NULLIF(m.MASE_SCALE, 0) AS MASE,
       SUM(s.FORECAST_UNITS - s.ACTUAL_UNITS) / NULLIF(SUM(s.ACTUAL_UNITS), 0) AS BIAS,
       AVG(IFF(s.ACTUAL_UNITS <= s.UPPER_95, 1, 0))      AS UPPER_COVERAGE,
       SUM(s.ACTUAL_UNITS)                               AS ACTUAL_UNITS,
       SUM(ABS(s.FORECAST_UNITS - s.ACTUAL_UNITS))       AS ABS_ERROR
FROM V_SERVICE_SCORED s
JOIN V_MASE_SCALE m ON m.SERIES_ID = s.SERIES_ID
GROUP BY 1, 2, 3, 4, 5, 6, m.MASE_SCALE
-- A series with no orders in the backtest (a delisted part) has nothing to
-- score; leaving it in would let a model win by forecasting zero.
HAVING SUM(s.ACTUAL_UNITS) > 0;

CREATE OR REPLACE VIEW V_INTEGRITY_SERVICE AS
SELECT 'service_class_coverage' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM CORE.DIM_SERIES s
WHERE NOT EXISTS (SELECT 1 FROM ML.SERIES_DEMAND_CLASS c WHERE c.SERIES_ID = s.SERIES_ID)
UNION ALL
SELECT 'service_croston_scope_only', COUNT(*)
FROM ML.FACT_FORECAST f
LEFT JOIN V_DEMAND_CLASS d ON d.SERIES_ID = f.SERIES_ID
WHERE f.MODEL_NAME IN ('CROSTON', 'SBA') AND NOT COALESCE(d.IS_CROSTON_SCOPE, FALSE)
UNION ALL
SELECT 'service_forecast_non_negative', COUNT(*)
FROM ML.FACT_FORECAST
WHERE MODEL_NAME IN ('CROSTON', 'SBA') AND (FORECAST_UNITS < 0 OR UPPER_95 < FORECAST_UNITS)
UNION ALL
-- SBA is Croston deflated by (1 - alpha/2): never above it.
SELECT 'service_sba_below_croston', COUNT(*)
FROM ML.FACT_FORECAST a
JOIN ML.FACT_FORECAST c
  ON c.SERIES_ID = a.SERIES_ID AND c.MADE_WEEK_ID = a.MADE_WEEK_ID
 AND c.TARGET_WEEK_ID = a.TARGET_WEEK_ID AND c.MODEL_NAME = 'CROSTON'
WHERE a.MODEL_NAME = 'SBA' AND a.FORECAST_UNITS > c.FORECAST_UNITS + 0.0001;

CREATE OR REPLACE VIEW V_INTEGRITY_ALL AS
SELECT CHECK_NAME, VIOLATIONS FROM V_DATA_INTEGRITY
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CALLOFFS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_IHS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_SERVICE;
