-- =====================================================================
-- Vectron Components — Demand Planning
-- 03: Planning series and weekly fact tables
-- =====================================================================
--
-- DIM_SERIES is a deterministic expansion of PRODUCT_CUSTOMER_MIX x
-- CHANNEL_MIX rather than a hand-written list, so it cannot drift from
-- the reviewed mix tables.
--
-- The floor is 1,000 pieces a year, deliberately low. Service-parts series
-- (OES, IAM) are small and intermittent by nature, and they are exactly
-- the series where standard forecasting fails; flooring them out would
-- delete the problem the service-parts module exists to show.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_SERIES — the planning grain: product x customer x channel
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_SERIES AS
WITH expanded AS (
  SELECT
    b.PRODUCT_ID,
    m.CUSTOMER_ID,
    c.CHANNEL_ID,
    b.CATEGORY_ID,
    b.ANNUAL_UNITS_GLOBAL * bm.VOLUME_SHARE * cm.SHARE AS BASE_ANNUAL_UNITS,
    b.UNIT_PRICE_EUR,
    b.LIFECYCLE_STATUS,
    b.LAUNCH_WEEK_ID,
    b.DELIST_WEEK_ID
  FROM DIM_PRODUCT b
  JOIN PRODUCT_CUSTOMER_MIX bm ON bm.PRODUCT_ID = b.PRODUCT_ID
  JOIN DIM_CUSTOMER       m  ON m.CUSTOMER_ID = bm.CUSTOMER_ID
  JOIN CHANNEL_MIX      cm ON cm.CUSTOMER_ID = m.CUSTOMER_ID
  JOIN DIM_CHANNEL      c  ON c.CHANNEL_ID = cm.CHANNEL_ID
),
floored AS (
  SELECT * FROM expanded WHERE BASE_ANNUAL_UNITS >= 1000
),
scored AS (
  SELECT
    f.*,
    f.BASE_ANNUAL_UNITS * f.UNIT_PRICE_EUR AS BASE_ANNUAL_VALUE_EUR,
    SUM(f.BASE_ANNUAL_UNITS * f.UNIT_PRICE_EUR) OVER () AS TOTAL_VALUE,
    SUM(f.BASE_ANNUAL_UNITS * f.UNIT_PRICE_EUR) OVER (
      ORDER BY f.BASE_ANNUAL_UNITS * f.UNIT_PRICE_EUR DESC
      ROWS UNBOUNDED PRECEDING
    ) AS CUM_VALUE
  FROM floored f
)
SELECT
  s.PRODUCT_ID || '|' || s.CUSTOMER_ID || '|' || s.CHANNEL_ID AS SERIES_ID,
  s.PRODUCT_ID,
  s.CUSTOMER_ID,
  s.CHANNEL_ID,
  s.CATEGORY_ID,
  ROUND(s.BASE_ANNUAL_UNITS, 0)                          AS BASE_ANNUAL_UNITS,
  ROUND(s.BASE_ANNUAL_VALUE_EUR, 0)                      AS BASE_ANNUAL_VALUE_EUR,
  -- ABC on cumulative value contribution: A to 80%, B to 95%, C the tail
  CASE WHEN s.CUM_VALUE / s.TOTAL_VALUE <= 0.80 THEN 'A'
       WHEN s.CUM_VALUE / s.TOTAL_VALUE <= 0.95 THEN 'B'
       ELSE 'C' END                                      AS SEGMENT_ABC,
  s.LIFECYCLE_STATUS,
  s.LAUNCH_WEEK_ID,
  s.DELIST_WEEK_ID,
  -- XYZ (demand variability) is assigned by the generator once actual
  -- volatility is known; seeded here so the column is never null.
  'Y'                                                    AS SEGMENT_XYZ,
  TRUE                                                   AS IS_ACTIVE
FROM scored s;

ALTER TABLE DIM_SERIES ADD PRIMARY KEY (SERIES_ID);

COMMENT ON TABLE DIM_SERIES IS
  'Planning series at part family x customer x channel, floored at 1000 pieces a year';

-- ---------------------------------------------------------------------
-- FACT_POS_WEEKLY — sell-out. The consumer-facing truth and the basis
-- for demand sensing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_POS_WEEKLY (
  SERIES_ID           VARCHAR(80)  NOT NULL,
  WEEK_ID             VARCHAR(10)  NOT NULL,
  UNITS            NUMBER(14,2) NOT NULL,
  NET_REVENUE_EUR     NUMBER(16,2) NOT NULL,
  AVG_PRICE_EUR_CASE  NUMBER(10,2) NOT NULL,
  PROMO_FLAG          BOOLEAN      NOT NULL,
  PROMO_DEPTH_PCT     NUMBER(5,4)  NOT NULL,
  DISTRIBUTION_POINTS NUMBER(10,0) NOT NULL,
  PRIMARY KEY (SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- FACT_SHIPMENTS_WEEKLY — sell-in. Diverges from sell-out by design:
-- trade stock builds ahead of events and drains after them, which is
-- exactly the phenomenon the phasing story depends on.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_SHIPMENTS_WEEKLY (
  SERIES_ID       VARCHAR(80)  NOT NULL,
  WEEK_ID         VARCHAR(10)  NOT NULL,
  UNITS        NUMBER(14,2) NOT NULL,
  NET_REVENUE_EUR NUMBER(16,2) NOT NULL,
  PRIMARY KEY (SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- FACT_INVENTORY_WEEKLY — channel stock. This is what makes sell-in and
-- sell-out reconcile rather than being two unrelated series. A planner
-- will check that opening + shipments - POS = closing.
--
-- LOST_SALES_UNITS closes that identity honestly. Where demand exceeded
-- available stock the shortfall is recorded rather than clamped away, so
-- the reconciliation becomes exact:
--
--   opening + shipments - (POS - lost_sales) = closing
--
-- and service failure becomes a visible planning signal instead of a
-- silent data inconsistency.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_INVENTORY_WEEKLY (
  SERIES_ID        VARCHAR(80)  NOT NULL,
  WEEK_ID          VARCHAR(10)  NOT NULL,
  OPENING_UNITS NUMBER(14,2) NOT NULL,
  CLOSING_UNITS NUMBER(14,2) NOT NULL,
  WEEKS_OF_COVER   NUMBER(8,2),
  LOST_SALES_UNITS NUMBER(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- FACT_DRIVER_CONTRIB — the decomposition behind every number.
--
-- Contributions are additive in units and sum to FACT_POS_WEEKLY.UNITS
-- for the same series and week. That constraint is what lets the UI claim
-- a waterfall explains the actual value rather than merely resembling it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_DRIVER_CONTRIB (
  SERIES_ID      VARCHAR(80)  NOT NULL,
  WEEK_ID        VARCHAR(10)  NOT NULL,
  DRIVER         VARCHAR(30)  NOT NULL,
  CONTRIB_UNITS  NUMBER(14,2) NOT NULL,
  PRIMARY KEY (SERIES_ID, WEEK_ID, DRIVER)
);

COMMENT ON TABLE FACT_DRIVER_CONTRIB IS
  'Additive decomposition: BASE, SEASONALITY, EVENT, PRICE, PROMO, DISTRIBUTION, WEATHER, MACRO, COMPETITOR, RESIDUAL. Sums to FACT_POS_WEEKLY.UNITS.';

-- ---------------------------------------------------------------------
-- Exogenous driver tables
--
-- SYNTHETIC DATA. Weather, macro and competitor activity here are
-- generated with realistic structure and plausible magnitudes, but they
-- are not observations. The application labels them as modelled inputs
-- wherever they are surfaced, for the same reason the carbon factors in
-- the sibling application are labelled as assumptions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_WEATHER_WEEKLY (
  CUSTOMER_ID       VARCHAR(20)  NOT NULL,
  WEEK_ID         VARCHAR(10)  NOT NULL,
  TEMP_ANOMALY_C  NUMBER(5,2)  NOT NULL,
  IS_HEATWAVE     BOOLEAN      NOT NULL,
  IS_COLDSNAP     BOOLEAN      NOT NULL,
  PRIMARY KEY (CUSTOMER_ID, WEEK_ID)
);

COMMENT ON TABLE FACT_WEATHER_WEEKLY IS
  'SYNTHETIC. Temperature anomaly versus seasonal normal, modelled not observed.';

CREATE OR REPLACE TABLE FACT_MACRO_WEEKLY (
  CUSTOMER_ID              VARCHAR(20) NOT NULL,
  WEEK_ID                VARCHAR(10) NOT NULL,
  AUTO_SENTIMENT_IDX NUMBER(6,2) NOT NULL,
  FX_INDEX_VS_EUR        NUMBER(8,4) NOT NULL,
  TARIFF_INDEX           NUMBER(6,3) NOT NULL,
  FLEET_MILEAGE_IDX   NUMBER(6,2) NOT NULL,
  PRIMARY KEY (CUSTOMER_ID, WEEK_ID)
);

COMMENT ON TABLE FACT_MACRO_WEEKLY IS
  'SYNTHETIC. Macro indices modelled with realistic structure, not sourced.';

CREATE OR REPLACE TABLE FACT_COMPETITOR_ACTIVITY (
  CUSTOMER_ID     VARCHAR(20)  NOT NULL,
  CATEGORY_ID   VARCHAR(20)  NOT NULL,
  WEEK_ID       VARCHAR(10)  NOT NULL,
  COMPETITOR    VARCHAR(60)  NOT NULL,
  ACTIVITY_TYPE VARCHAR(30)  NOT NULL,
  INTENSITY     NUMBER(4,3)  NOT NULL,
  PRIMARY KEY (CUSTOMER_ID, CATEGORY_ID, WEEK_ID, COMPETITOR)
);

COMMENT ON TABLE FACT_COMPETITOR_ACTIVITY IS
  'SYNTHETIC. Illustrative competitive activity; competitor names are real companies but the activity is modelled.';

-- ---------------------------------------------------------------------
-- FACT_PROMOTION — the promotion calendar, with planned versus realised
-- uplift so promo effectiveness is measurable rather than assumed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_PROMOTION (
  PROMO_ID           VARCHAR(40)  PRIMARY KEY,
  SERIES_ID          VARCHAR(80)  NOT NULL,
  START_WEEK_ID      VARCHAR(10)  NOT NULL,
  END_WEEK_ID        VARCHAR(10)  NOT NULL,
  MECHANIC           VARCHAR(40)  NOT NULL,
  DEPTH_PCT          NUMBER(5,4)  NOT NULL,
  PLANNED_UPLIFT_PCT NUMBER(6,4)  NOT NULL,
  ACTUAL_UPLIFT_PCT  NUMBER(6,4)
);

-- ---------------------------------------------------------------------
-- FACT_DEMAND_PLAN — the planner-editable layer.
--
-- STAT_UNITS is what the model said; OVERRIDE_UNITS is what the planner
-- said; PLAN_UNITS is what was committed. Keeping all three is what makes
-- forecast value add computable, including the units where the override
-- made accuracy worse.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE FACT_DEMAND_PLAN (
  SERIES_ID      VARCHAR(80)  NOT NULL,
  WEEK_ID        VARCHAR(10)  NOT NULL,
  STAT_UNITS     NUMBER(14,2) NOT NULL,
  OVERRIDE_UNITS NUMBER(14,2),
  PLAN_UNITS     NUMBER(14,2) NOT NULL,
  REASON_CODE    VARCHAR(30),
  OVERRIDE_NOTE  VARCHAR(500),
  PLANNER        VARCHAR(60),
  IS_LOCKED      BOOLEAN      NOT NULL DEFAULT FALSE,
  UPDATED_AT     TIMESTAMP_NTZ,
  PRIMARY KEY (SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- ML.FACT_FORECAST — lag-versioned forecast history.
--
-- The composite key is the whole point. Storing what we believed at the
-- time, keyed by when we believed it, is what makes forecast value add
-- and accuracy-by-horizon real subtractions rather than assertions.
--
-- MODEL_NAME is part of the key, so every query MUST filter on it or
-- rows fan out silently. That mistake cost real debugging time in the
-- sibling application.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE VECTRON_DEMAND.ML.FACT_FORECAST (
  SERIES_ID       VARCHAR(80)  NOT NULL,
  TARGET_WEEK_ID  VARCHAR(10)  NOT NULL,
  MADE_WEEK_ID    VARCHAR(10)  NOT NULL,
  LAG_WEEKS       NUMBER(3,0)  NOT NULL,
  MODEL_NAME      VARCHAR(30)  NOT NULL,
  FORECAST_UNITS  NUMBER(14,2) NOT NULL,
  LOWER_95        NUMBER(14,2),
  UPPER_95        NUMBER(14,2),
  PRIMARY KEY (SERIES_ID, TARGET_WEEK_ID, MADE_WEEK_ID, MODEL_NAME)
);

COMMENT ON TABLE VECTRON_DEMAND.ML.FACT_FORECAST IS
  'Lag-versioned forecasts. MODEL_NAME is part of the grain: filter on it or rows fan out.';
