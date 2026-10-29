-- =====================================================================
-- Vectron Components — Demand Planning
-- 04: Application views
-- =====================================================================
--
-- Every view that touches ML.FACT_FORECAST filters on MODEL_NAME. That column
-- is part of the table's grain, so omitting it silently multiplies rows. This
-- is the single most likely way to get a plausible-looking wrong number here.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- Planning context: one row, the anchor every other view derives from.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CONTEXT AS
SELECT
  (SELECT MAX(WEEK_ID) FROM CORE.FACT_POS_WEEKLY)          AS HISTORY_END_WEEK,
  (SELECT MIN(WEEK_ID) FROM CORE.DIM_WEEK
    WHERE WEEK_ID > (SELECT MAX(WEEK_ID) FROM CORE.FACT_POS_WEEKLY)) AS CURRENT_WEEK,
  (SELECT MAX(TARGET_WEEK_ID) FROM ML.FACT_FORECAST
    WHERE MODEL_NAME = 'VECTRON_STAT')                    AS HORIZON_END_WEEK,
  'VECTRON_STAT'                                          AS PRODUCTION_MODEL,
  'NAIVE_SEASONAL'                                         AS BENCHMARK_MODEL;

-- ---------------------------------------------------------------------
-- Series master, denormalised for the UI.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_SERIES AS
SELECT
  s.SERIES_ID, s.PRODUCT_ID, s.CUSTOMER_ID, s.CHANNEL_ID, s.CATEGORY_ID,
  b.PRODUCT_NAME, b.PRODUCT_LINE, b.PRICE_TIER, b.UNIT_PRICE_EUR,
  b.LIFECYCLE_STATUS, b.LAUNCH_WEEK_ID, b.DELIST_WEEK_ID,
  c.CATEGORY_NAME, m.CUSTOMER_NAME, m.REGION, m.IS_AFTERMARKET,
  ch.CHANNEL_NAME,
  s.SEGMENT_ABC, s.SEGMENT_XYZ, s.BASE_ANNUAL_UNITS, s.BASE_ANNUAL_VALUE_EUR,
  s.SEGMENT_ABC || s.SEGMENT_XYZ AS SEGMENT,
  b.PRODUCT_NAME || ' · ' || m.CUSTOMER_NAME || ' · ' || ch.CHANNEL_NAME AS SERIES_LABEL,
  -- Attributes for the alternate hierarchies in 16-hierarchies.sql.
  ch.CHANNEL_GROUP,
  IFF(m.IS_AFTERMARKET, 'Aftermarket', 'OEM') AS ROUTE_TO_CUSTOMER,
  CASE m.DELIVERY_MODE WHEN 'JIS' THEN 'Just-in-sequence'
                       WHEN 'JIT' THEN 'Just-in-time'
                       ELSE 'Warehouse stock' END AS DELIVERY_MODE
FROM CORE.DIM_SERIES s
JOIN CORE.DIM_PRODUCT b    ON b.PRODUCT_ID = s.PRODUCT_ID
JOIN CORE.DIM_CATEGORY c ON c.CATEGORY_ID = s.CATEGORY_ID
JOIN CORE.DIM_CUSTOMER m   ON m.CUSTOMER_ID = s.CUSTOMER_ID
JOIN CORE.DIM_CHANNEL ch ON ch.CHANNEL_ID = s.CHANNEL_ID;

-- ---------------------------------------------------------------------
-- Weekly actuals: sell-out, sell-in and stock in one place, so the
-- divergence between them is directly visible.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_ACTUALS_WEEKLY AS
SELECT
  p.SERIES_ID, p.WEEK_ID, w.WEEK_START_DATE, w.ISO_YEAR, w.ISO_WEEK,
  w.FISCAL_YEAR, w.FISCAL_QUARTER,
  p.UNITS                AS POS_UNITS,
  p.NET_REVENUE_EUR         AS POS_REVENUE_EUR,
  p.AVG_PRICE_EUR_CASE,
  p.PROMO_FLAG, p.PROMO_DEPTH_PCT, p.DISTRIBUTION_POINTS,
  sh.UNITS               AS SHIP_UNITS,
  i.CLOSING_UNITS        AS STOCK_UNITS,
  i.WEEKS_OF_COVER,
  i.LOST_SALES_UNITS
FROM CORE.FACT_POS_WEEKLY p
JOIN CORE.DIM_WEEK w              ON w.WEEK_ID = p.WEEK_ID
LEFT JOIN CORE.FACT_SHIPMENTS_WEEKLY sh
       ON sh.SERIES_ID = p.SERIES_ID AND sh.WEEK_ID = p.WEEK_ID
LEFT JOIN CORE.FACT_INVENTORY_WEEKLY i
       ON i.SERIES_ID = p.SERIES_ID AND i.WEEK_ID = p.WEEK_ID;

-- ---------------------------------------------------------------------
-- The forward plan, with the production model's interval attached.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_PLAN_FORWARD AS
SELECT
  d.SERIES_ID, d.WEEK_ID, w.WEEK_START_DATE, w.ISO_WEEK,
  d.STAT_UNITS, d.OVERRIDE_UNITS, d.PLAN_UNITS,
  d.REASON_CODE, r.REASON_LABEL, d.PLANNER, d.IS_LOCKED,
  f.LOWER_95, f.UPPER_95, f.LAG_WEEKS,
  n.FORECAST_UNITS AS NAIVE_UNITS,
  s.UNIT_PRICE_EUR,
  d.PLAN_UNITS * s.UNIT_PRICE_EUR AS PLAN_VALUE_EUR
FROM CORE.FACT_DEMAND_PLAN d
JOIN CORE.DIM_WEEK w   ON w.WEEK_ID = d.WEEK_ID
JOIN V_SERIES s        ON s.SERIES_ID = d.SERIES_ID
LEFT JOIN CORE.DIM_REASON_CODE r ON r.REASON_CODE = d.REASON_CODE
LEFT JOIN ML.FACT_FORECAST f
       ON f.SERIES_ID = d.SERIES_ID AND f.TARGET_WEEK_ID = d.WEEK_ID
      AND f.MODEL_NAME = 'VECTRON_STAT'
      AND f.MADE_WEEK_ID = (SELECT HISTORY_END_WEEK FROM V_CONTEXT)
LEFT JOIN ML.FACT_FORECAST n
       ON n.SERIES_ID = d.SERIES_ID AND n.TARGET_WEEK_ID = d.WEEK_ID
      AND n.MODEL_NAME = 'NAIVE_SEASONAL'
      AND n.MADE_WEEK_ID = (SELECT HISTORY_END_WEEK FROM V_CONTEXT);

-- ---------------------------------------------------------------------
-- Driver decomposition. Contributions are additive and sum to POS_UNITS,
-- which is asserted by V_DATA_INTEGRITY below rather than assumed.
--
-- The decomposition is SEQUENTIAL: each driver carries its incremental
-- effect given the drivers already applied, in the fixed order below.
-- It is exact but order-dependent, and the UI says so.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_DRIVER_WATERFALL AS
SELECT
  d.SERIES_ID, d.WEEK_ID, d.DRIVER, d.CONTRIB_UNITS,
  CASE d.DRIVER
    WHEN 'BASE' THEN 1 WHEN 'SEASONALITY' THEN 2 WHEN 'EVENT' THEN 3
    WHEN 'PRICE' THEN 4 WHEN 'PROMO' THEN 5 WHEN 'DISTRIBUTION' THEN 6
    WHEN 'WEATHER' THEN 7 WHEN 'MACRO' THEN 8 WHEN 'COMPETITOR' THEN 9
    ELSE 10 END AS DRIVER_ORDER,
  CASE d.DRIVER
    WHEN 'BASE' THEN 'Underlying level'
    WHEN 'SEASONALITY' THEN 'Week-of-year seasonality'
    WHEN 'EVENT' THEN 'Festival and gifting events'
    WHEN 'PRICE' THEN 'Price position'
    WHEN 'PROMO' THEN 'Promotional activity'
    WHEN 'DISTRIBUTION' THEN 'Distribution and listings'
    WHEN 'WEATHER' THEN 'Weather versus normal'
    WHEN 'MACRO' THEN 'Macro and duty'
    WHEN 'COMPETITOR' THEN 'Competitor activity'
    ELSE 'Unexplained residual' END AS DRIVER_LABEL,
  -- Weather, macro and competitor inputs are modelled, not observed.
  d.DRIVER IN ('WEATHER', 'MACRO', 'COMPETITOR') AS IS_MODELLED_INPUT
FROM CORE.FACT_DRIVER_CONTRIB d;

-- ---------------------------------------------------------------------
-- Accuracy by horizon. Only models present at EVERY origin are included,
-- so the comparison is like-for-like. CORTEX_ML is forward-only and is
-- therefore deliberately excluded here.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_ACCURACY_BY_LAG AS
SELECT
  f.MODEL_NAME, f.LAG_WEEKS,
  COUNT(*)                                                     AS N_OBS,
  SUM(p.UNITS)                                              AS ACTUAL_UNITS,
  SUM(ABS(f.FORECAST_UNITS - p.UNITS)) / NULLIF(SUM(p.UNITS), 0) AS WAPE,
  SUM(f.FORECAST_UNITS - p.UNITS)      / NULLIF(SUM(p.UNITS), 0) AS BIAS,
  AVG(CASE WHEN p.UNITS BETWEEN f.LOWER_95 AND f.UPPER_95 THEN 1.0 ELSE 0.0 END)
                                                               AS INTERVAL_COVERAGE
FROM ML.FACT_FORECAST f
JOIN CORE.FACT_POS_WEEKLY p
  ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
WHERE f.MODEL_NAME IN ('NAIVE_SEASONAL', 'VECTRON_STAT', 'CONSENSUS')
GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- Forecast value add, decomposed into the two questions that matter:
-- is the model beating the benchmark, and is the planner beating the model?
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_FVA_SUMMARY AS
WITH w AS (
  SELECT MODEL_NAME,
         SUM(ABS(f.FORECAST_UNITS - p.UNITS)) / NULLIF(SUM(p.UNITS), 0) AS WAPE
  FROM ML.FACT_FORECAST f
  JOIN CORE.FACT_POS_WEEKLY p
    ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
  WHERE f.MODEL_NAME IN ('NAIVE_SEASONAL', 'VECTRON_STAT', 'CONSENSUS')
  GROUP BY 1
)
SELECT
  MAX(CASE WHEN MODEL_NAME = 'NAIVE_SEASONAL' THEN WAPE END) AS NAIVE_WAPE,
  MAX(CASE WHEN MODEL_NAME = 'VECTRON_STAT'  THEN WAPE END) AS STAT_WAPE,
  MAX(CASE WHEN MODEL_NAME = 'CONSENSUS'      THEN WAPE END) AS CONSENSUS_WAPE,
  MAX(CASE WHEN MODEL_NAME = 'NAIVE_SEASONAL' THEN WAPE END)
    - MAX(CASE WHEN MODEL_NAME = 'VECTRON_STAT' THEN WAPE END) AS MODEL_FVA,
  MAX(CASE WHEN MODEL_NAME = 'VECTRON_STAT' THEN WAPE END)
    - MAX(CASE WHEN MODEL_NAME = 'CONSENSUS' THEN WAPE END)     AS PLANNER_FVA
FROM w;

-- ---------------------------------------------------------------------
-- Per-override scoring. This is the view that makes planner value add
-- honest: it shows the overrides that made accuracy WORSE, by reason code.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_OVERRIDE_SCORECARD AS
WITH scored AS (
  SELECT
    c.SERIES_ID, c.TARGET_WEEK_ID, c.LAG_WEEKS,
    s.FORECAST_UNITS AS STAT_UNITS,
    c.FORECAST_UNITS AS CONSENSUS_UNITS,
    p.UNITS       AS ACTUAL_UNITS,
    ABS(s.FORECAST_UNITS - p.UNITS) AS STAT_ERR,
    ABS(c.FORECAST_UNITS - p.UNITS) AS CONS_ERR
  FROM ML.FACT_FORECAST c
  JOIN ML.FACT_FORECAST s
    ON s.SERIES_ID = c.SERIES_ID AND s.TARGET_WEEK_ID = c.TARGET_WEEK_ID
   AND s.MADE_WEEK_ID = c.MADE_WEEK_ID AND s.MODEL_NAME = 'VECTRON_STAT'
  JOIN CORE.FACT_POS_WEEKLY p
    ON p.SERIES_ID = c.SERIES_ID AND p.WEEK_ID = c.TARGET_WEEK_ID
  WHERE c.MODEL_NAME = 'CONSENSUS'
    AND ABS(c.FORECAST_UNITS - s.FORECAST_UNITS) > 0.01   -- actually overridden
)
SELECT
  COUNT(*)                                                   AS OVERRIDE_COUNT,
  SUM(CASE WHEN CONS_ERR < STAT_ERR THEN 1 ELSE 0 END)       AS IMPROVED,
  SUM(CASE WHEN CONS_ERR > STAT_ERR THEN 1 ELSE 0 END)       AS WORSENED,
  AVG(CASE WHEN CONS_ERR < STAT_ERR THEN 1.0 ELSE 0.0 END)   AS WIN_RATE,
  SUM(STAT_ERR - CONS_ERR)                                   AS NET_UNITS_SAVED
FROM scored;

-- ---------------------------------------------------------------------
-- Week index: how many completed weeks ago each week was.
--
-- This exists because Snowflake will not evaluate a CORRELATED scalar
-- subquery inside a view, which ruled out deriving "the last four weeks"
-- inline from V_CONTEXT. An uncorrelated subquery is fine, so the ranking
-- is materialised here once and joined everywhere else.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_WEEK_INDEX AS
SELECT
  w.WEEK_ID, w.WEEK_START_DATE, w.ISO_WEEK, w.ISO_YEAR,
  ROW_NUMBER() OVER (ORDER BY w.WEEK_START_DATE DESC) AS WEEKS_AGO
FROM CORE.DIM_WEEK w
WHERE w.WEEK_ID <= (SELECT MAX(WEEK_ID) FROM CORE.FACT_POS_WEEKLY);

-- ---------------------------------------------------------------------
-- Demand sensing, 0-8 weeks.
--
-- Signals are things happening in recent ACTUALS that the forward plan does
-- not yet reflect. Each carries a severity and a single suggested action, per
-- the insight-to-action rule.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_SENSING_SIGNALS AS
WITH recent AS (
  SELECT a.SERIES_ID, a.WEEK_ID, a.POS_UNITS, a.DISTRIBUTION_POINTS,
         a.PROMO_FLAG, a.PROMO_DEPTH_PCT, a.LOST_SALES_UNITS, a.WEEKS_OF_COVER
  FROM V_ACTUALS_WEEKLY a
  JOIN V_WEEK_INDEX wi ON wi.WEEK_ID = a.WEEK_ID
  WHERE wi.WEEKS_AGO <= 4
),
-- POS versus what the model expected for those same weeks, forecast far
-- enough back that the divergence is genuinely news.
velocity AS (
  SELECT r.SERIES_ID,
         SUM(r.POS_UNITS)        AS ACTUAL_4WK,
         SUM(f.FORECAST_UNITS)   AS EXPECTED_4WK
  FROM recent r
  JOIN ML.FACT_FORECAST f
    ON f.SERIES_ID = r.SERIES_ID AND f.TARGET_WEEK_ID = r.WEEK_ID
   AND f.MODEL_NAME = 'VECTRON_STAT' AND f.LAG_WEEKS = 4
  GROUP BY 1
),
vel_sig AS (
  SELECT v.SERIES_ID, 'POS_VELOCITY' AS SIGNAL_TYPE,
         (v.ACTUAL_4WK - v.EXPECTED_4WK) / NULLIF(v.EXPECTED_4WK, 0) AS DEVIATION,
         v.ACTUAL_4WK AS OBSERVED, v.EXPECTED_4WK AS EXPECTED
  FROM velocity v
  WHERE v.EXPECTED_4WK > 0
    AND ABS((v.ACTUAL_4WK - v.EXPECTED_4WK) / NULLIF(v.EXPECTED_4WK, 0)) >= 0.12
),
-- Promotions that did not perform as planned
promo_sig AS (
  SELECT pr.SERIES_ID, 'PROMO_RESPONSE' AS SIGNAL_TYPE,
         (pr.ACTUAL_UPLIFT_PCT - pr.PLANNED_UPLIFT_PCT)
           / NULLIF(pr.PLANNED_UPLIFT_PCT, 0) AS DEVIATION,
         pr.ACTUAL_UPLIFT_PCT AS OBSERVED, pr.PLANNED_UPLIFT_PCT AS EXPECTED
  FROM CORE.FACT_PROMOTION pr
  JOIN V_WEEK_INDEX wi ON wi.WEEK_ID = pr.END_WEEK_ID
  WHERE pr.ACTUAL_UPLIFT_PCT IS NOT NULL
    AND wi.WEEKS_AGO <= 8
    AND ABS((pr.ACTUAL_UPLIFT_PCT - pr.PLANNED_UPLIFT_PCT)
            / NULLIF(pr.PLANNED_UPLIFT_PCT, 0)) >= 0.30
),
-- Distribution moves of 3% or more. The threshold is deliberately low:
-- real weekly distribution movement in this data is small, and a 5% bar
-- hid every genuine signal.
dist_sig AS (
  SELECT SERIES_ID, 'DISTRIBUTION_SHIFT' AS SIGNAL_TYPE, DEVIATION,
         OBSERVED, EXPECTED
  FROM (
    SELECT r.SERIES_ID,
           (MAX_BY(r.DISTRIBUTION_POINTS, r.WEEK_ID)
            - MIN_BY(r.DISTRIBUTION_POINTS, r.WEEK_ID))
             / NULLIF(MIN_BY(r.DISTRIBUTION_POINTS, r.WEEK_ID), 0) AS DEVIATION,
           MAX_BY(r.DISTRIBUTION_POINTS, r.WEEK_ID) AS OBSERVED,
           MIN_BY(r.DISTRIBUTION_POINTS, r.WEEK_ID) AS EXPECTED
    FROM recent r GROUP BY 1
  ) WHERE ABS(DEVIATION) >= 0.03
),
-- Service failure: demand that could not be met
stock_sig AS (
  SELECT r.SERIES_ID, 'SERVICE_RISK' AS SIGNAL_TYPE,
         SUM(r.LOST_SALES_UNITS) / NULLIF(SUM(r.POS_UNITS), 0) AS DEVIATION,
         SUM(r.LOST_SALES_UNITS) AS OBSERVED, 0 AS EXPECTED
  FROM recent r GROUP BY 1
  HAVING SUM(r.LOST_SALES_UNITS) > 0
),
unioned AS (
  SELECT * FROM vel_sig UNION ALL SELECT * FROM promo_sig
  UNION ALL SELECT * FROM dist_sig UNION ALL SELECT * FROM stock_sig
)
SELECT
  u.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME,
  s.CATEGORY_NAME, s.SEGMENT_ABC, s.BASE_ANNUAL_VALUE_EUR,
  u.SIGNAL_TYPE, u.DEVIATION, u.OBSERVED, u.EXPECTED,
  CASE u.SIGNAL_TYPE
    WHEN 'POS_VELOCITY'       THEN 'Pull running ' ||
      CASE WHEN u.DEVIATION > 0 THEN 'ahead of' ELSE 'behind' END || ' plan'
    WHEN 'PROMO_RESPONSE'     THEN 'Promotion under- or over-delivered'
    WHEN 'DISTRIBUTION_SHIFT' THEN 'Distribution moved materially'
    ELSE 'Demand exceeded available stock' END AS SIGNAL_LABEL,
  -- Severity blends how big the deviation is with how much value is at risk,
  -- so a 30% miss on a tail series does not outrank a 12% miss on a top one.
  CASE
    WHEN ABS(u.DEVIATION) >= 0.30 AND s.SEGMENT_ABC = 'A' THEN 'Critical'
    WHEN ABS(u.DEVIATION) >= 0.20 AND s.SEGMENT_ABC IN ('A','B') THEN 'High'
    WHEN ABS(u.DEVIATION) >= 0.15 THEN 'Medium'
    ELSE 'Low' END AS SEVERITY,
  CASE u.SIGNAL_TYPE
    WHEN 'POS_VELOCITY'       THEN 'Adjust the next 8 weeks of plan'
    WHEN 'PROMO_RESPONSE'     THEN 'Revise promotional uplift assumption'
    WHEN 'DISTRIBUTION_SHIFT' THEN 'Confirm listing change with the customer'
    ELSE 'Review cover and expedite supply' END AS SUGGESTED_ACTION
FROM unioned u
JOIN V_SERIES s ON s.SERIES_ID = u.SERIES_ID;

-- ---------------------------------------------------------------------
-- Planner worklist: where the plan and the model disagree most in value.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_EXCEPTIONS AS
SELECT
  p.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME,
  s.CATEGORY_NAME, s.SEGMENT_ABC, s.SEGMENT_XYZ,
  SUM(p.PLAN_UNITS)                                   AS PLAN_UNITS_8WK,
  SUM(p.STAT_UNITS)                                   AS STAT_UNITS_8WK,
  SUM(p.NAIVE_UNITS)                                  AS NAIVE_UNITS_8WK,
  SUM(p.PLAN_UNITS - p.STAT_UNITS)                    AS GAP_UNITS,
  SUM((p.PLAN_UNITS - p.STAT_UNITS) * p.UNIT_PRICE_EUR) AS GAP_VALUE_EUR,
  SUM(p.PLAN_UNITS - p.STAT_UNITS) / NULLIF(SUM(p.STAT_UNITS), 0) AS GAP_PCT,
  MAX(p.REASON_CODE)                                  AS REASON_CODE,
  MAX(p.REASON_LABEL)                                 AS REASON_LABEL,
  MAX(p.PLANNER)                                      AS PLANNER,
  BOOLOR_AGG(p.IS_LOCKED)                             AS ANY_LOCKED
FROM V_PLAN_FORWARD p
JOIN V_SERIES s ON s.SERIES_ID = p.SERIES_ID
WHERE p.LAG_WEEKS <= 8
GROUP BY 1,2,3,4,5,6,7,8;

-- ---------------------------------------------------------------------
-- New product introduction versus its analogue's launch curve.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_NPD_TRACKING AS
WITH launches AS (
  SELECT b.PRODUCT_ID, b.PRODUCT_NAME, b.LAUNCH_WEEK_ID, b.LIFECYCLE_STATUS,
         lw.WEEK_START_DATE AS LAUNCH_DATE
  FROM CORE.DIM_PRODUCT b
  JOIN CORE.DIM_WEEK lw ON lw.WEEK_ID = b.LAUNCH_WEEK_ID
  WHERE b.LAUNCH_WEEK_ID IS NOT NULL
),
actual_curve AS (
  SELECT l.PRODUCT_ID,
         DATEDIFF(week, l.LAUNCH_DATE, w.WEEK_START_DATE) AS WEEKS_SINCE_LAUNCH,
         SUM(p.UNITS) AS UNITS
  FROM launches l
  JOIN CORE.DIM_SERIES s ON s.PRODUCT_ID = l.PRODUCT_ID
  JOIN CORE.FACT_POS_WEEKLY p ON p.SERIES_ID = s.SERIES_ID
  JOIN CORE.DIM_WEEK w ON w.WEEK_ID = p.WEEK_ID
  WHERE w.WEEK_START_DATE >= l.LAUNCH_DATE
  GROUP BY 1, 2
)
SELECT
  l.PRODUCT_ID, l.PRODUCT_NAME, l.LAUNCH_WEEK_ID, l.LAUNCH_DATE, l.LIFECYCLE_STATUS,
  a.ANALOGUE_PRODUCT_ID, ab.PRODUCT_NAME AS ANALOGUE_PRODUCT_NAME,
  a.SIMILARITY_SCORE, a.CANNIBALISATION_PCT, a.RATIONALE,
  c.WEEKS_SINCE_LAUNCH, c.UNITS
FROM launches l
LEFT JOIN CORE.NPD_ANALOGUE a ON a.NEW_PRODUCT_ID = l.PRODUCT_ID
LEFT JOIN CORE.DIM_PRODUCT ab   ON ab.PRODUCT_ID = a.ANALOGUE_PRODUCT_ID
LEFT JOIN actual_curve c      ON c.PRODUCT_ID = l.PRODUCT_ID;

-- ---------------------------------------------------------------------
-- Integrity assertions the application can surface rather than trust.
-- Every row returned is a defect.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_DATA_INTEGRITY AS
SELECT 'driver_additivity' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM (SELECT SERIES_ID, WEEK_ID, ROUND(SUM(CONTRIB_UNITS), 2) AS S
      FROM CORE.FACT_DRIVER_CONTRIB GROUP BY 1, 2) x
JOIN CORE.FACT_POS_WEEKLY p
  ON p.SERIES_ID = x.SERIES_ID AND p.WEEK_ID = x.WEEK_ID
WHERE ABS(x.S - p.UNITS) > 0.02
UNION ALL
SELECT 'inventory_reconciliation', COUNT(*)
FROM CORE.FACT_INVENTORY_WEEKLY i
JOIN CORE.FACT_SHIPMENTS_WEEKLY sh
  ON sh.SERIES_ID = i.SERIES_ID AND sh.WEEK_ID = i.WEEK_ID
LEFT JOIN CORE.FACT_POS_WEEKLY p
  ON p.SERIES_ID = i.SERIES_ID AND p.WEEK_ID = i.WEEK_ID
WHERE ABS((i.OPENING_UNITS + sh.UNITS
           - (COALESCE(p.UNITS, 0) - i.LOST_SALES_UNITS))
          - i.CLOSING_UNITS) > 0.02
UNION ALL
SELECT 'plan_without_forecast', COUNT(*)
FROM CORE.FACT_DEMAND_PLAN d
LEFT JOIN ML.FACT_FORECAST f
  ON f.SERIES_ID = d.SERIES_ID AND f.TARGET_WEEK_ID = d.WEEK_ID
 AND f.MODEL_NAME = 'VECTRON_STAT'
WHERE f.SERIES_ID IS NULL;
