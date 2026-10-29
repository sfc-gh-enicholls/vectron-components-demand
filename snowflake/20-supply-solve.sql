-- =====================================================================
-- 20-supply-solve.sql — constrained solve: result tables + procedure
-- =====================================================================
-- Results of SP_SUPPLY_SOLVE (scripts/supply_solve.py), one set per
-- PLAN_SOURCE ('COMMITTED' or a SCENARIO_ID). A new solve for a source
-- replaces that source's rows in one transaction. PLAN_VERSION is a hash of
-- the demand the solve read, so the app can tell when the live plan has
-- moved on since the last solve ("solved against an earlier plan").
--
-- The procedure is registered by scripts/deploy_supply_solve.py (it inlines
-- the Python file). Run this file first, then that script.
-- =====================================================================
USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

CREATE TABLE IF NOT EXISTS FACT_SUPPLY_SOLVE_RUN (
  RUN_ID              VARCHAR(40)  NOT NULL,
  PLAN_SOURCE         VARCHAR(60)  NOT NULL,
  PLAN_VERSION        VARCHAR(40)  NOT NULL,
  SOLVED_AT           TIMESTAMP_LTZ NOT NULL,
  TRIGGER_NAME        VARCHAR(40),
  ORDER_COUNT         NUMBER(10,0),
  REQUESTED_UNITS     NUMBER(18,4),
  PRODUCED_UNITS      NUMBER(18,4),
  ON_TIME_UNITS       NUMBER(18,4),
  LIQUID_SHORT_UNITS  NUMBER(18,4),
  UNMET_UNITS         NUMBER(18,4)
);
-- When the agent's supply signal was last rebuilt from this run (22).
ALTER TABLE FACT_SUPPLY_SOLVE_RUN ADD COLUMN IF NOT EXISTS SIGNAL_REFRESHED_AT TIMESTAMP_LTZ;

CREATE TABLE IF NOT EXISTS FACT_SUPPLY_PLAN (
  RUN_ID              VARCHAR(40)  NOT NULL,
  PLAN_SOURCE         VARCHAR(60)  NOT NULL,
  SKU_ID              VARCHAR(40)  NOT NULL,
  PRODUCT_ID            VARCHAR(20)  NOT NULL,
  CUSTOMER_ID           VARCHAR(10)  NOT NULL,
  SITE_ID             VARCHAR(10)  NOT NULL,
  LINE_ID             VARCHAR(12),
  PRIORITY_TIER       NUMBER(2,0)  NOT NULL,
  RELEASE_WEEK_NO     NUMBER(3,0)  NOT NULL,
  RECEIPT_WEEK_NO     NUMBER(3,0)  NOT NULL,
  LEAD_WEEKS          NUMBER(3,0)  NOT NULL,
  REQUESTED_UNITS     NUMBER(18,4) NOT NULL,
  LIQUID_SHORT_UNITS  NUMBER(18,4) NOT NULL,
  PRODUCED_UNITS      NUMBER(18,4) NOT NULL,
  ON_TIME_UNITS       NUMBER(18,4) NOT NULL,
  LATE_UNITS          NUMBER(18,4) NOT NULL,
  UNMET_UNITS         NUMBER(18,4) NOT NULL,
  FIRST_PROD_WEEK_NO  NUMBER(3,0),
  LAST_PROD_WEEK_NO   NUMBER(3,0),
  BINDING             VARCHAR(40)
);

CREATE TABLE IF NOT EXISTS FACT_SUPPLY_LINE_WEEK (
  RUN_ID            VARCHAR(40) NOT NULL,
  PLAN_SOURCE       VARCHAR(60) NOT NULL,
  LINE_ID           VARCHAR(12) NOT NULL,
  WEEK_NO           NUMBER(3,0) NOT NULL,
  CAPACITY_UNITS    NUMBER(18,4) NOT NULL,
  REQUESTED_UNITS   NUMBER(18,4) NOT NULL,
  PRODUCED_UNITS    NUMBER(18,4) NOT NULL,
  LOT_EXCESS_UNITS  NUMBER(18,4) NOT NULL
);

CREATE TABLE IF NOT EXISTS FACT_SUPPLY_ITEM_WEEK (
  RUN_ID       VARCHAR(40) NOT NULL,
  PLAN_SOURCE  VARCHAR(60) NOT NULL,
  ITEM_ID      VARCHAR(20) NOT NULL,
  WEEK_NO      NUMBER(3,0) NOT NULL,
  STOCK_UNITS  NUMBER(22,4) NOT NULL
);

USE SCHEMA APP;

-- Latest solve per source, and whether the live demand has moved since.
CREATE OR REPLACE VIEW V_SUPPLY_SOLVE_STATUS AS
SELECT r.*,
       r.PLAN_VERSION <> (SELECT TO_VARCHAR(HASH_AGG(d.SERIES_ID, d.WEEK_ID, d.UNITS))
                          FROM APP.V_SUPPLY_DEMAND_SOURCE d
                          WHERE d.PLAN_SOURCE = r.PLAN_SOURCE) AS IS_STALE
FROM CORE.FACT_SUPPLY_SOLVE_RUN r;

-- Constrained allocation by customer x product x receipt week, for the app.
CREATE OR REPLACE VIEW V_SUPPLY_ALLOCATION AS
SELECT sp.PLAN_SOURCE, sp.CUSTOMER_ID, sp.PRODUCT_ID, sp.PRIORITY_TIER,
       sp.RECEIPT_WEEK_NO, pw.WEEK_ID AS RECEIPT_WEEK_ID,
       SUM(sp.REQUESTED_UNITS)    AS REQUESTED_UNITS,
       SUM(sp.ON_TIME_UNITS)      AS ON_TIME_UNITS,
       SUM(sp.LATE_UNITS)         AS LATE_UNITS,
       SUM(sp.LIQUID_SHORT_UNITS) AS LIQUID_SHORT_UNITS,
       SUM(sp.UNMET_UNITS)        AS UNMET_UNITS
FROM CORE.FACT_SUPPLY_PLAN sp
JOIN APP.V_PLAN_WEEK pw ON pw.WEEK_NO = sp.RECEIPT_WEEK_NO
GROUP BY ALL;
