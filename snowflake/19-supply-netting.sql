-- =====================================================================
-- 19-supply-netting.sql — the LIVE supply layer (plain views)
-- =====================================================================
-- Recomputes on every read. A change to the committed plan (an approved
-- promotion writing FACT_DEMAND_PLAN) or to a scenario's edits is reflected
-- the next time any of these views is queried, with no job, refresh or
-- export in between. Plain views rather than dynamic tables because:
--   * the demand tables are rebuilt with CREATE OR REPLACE / TRUNCATE by the
--     data scripts, which would reinitialise any dynamic table on them;
--   * dynamic tables have a 1-minute minimum lag; a view has none.
--
-- Everything here is CLOSED-FORM, so it can be a view:
--   gross requirement -> BOM explosion -> safety stock -> net requirement
--   (lot-for-lot, via a running MAX of cumulative shortfall) -> lead-time
--   offset -> unconstrained line load and dry-goods need.
-- The steps where each week depends on the previous one's DECISION (lot
-- sizing, capacity carry-forward, priority allocation) are NOT here; they
-- are in the constrained solve (scripts/supply_solve.py).
--
-- PLAN_SOURCE is 'COMMITTED' or a SCENARIO_ID, so one definition serves the
-- committed plan and every scenario. Always filter on it.
-- Run after 18.
-- =====================================================================
USE DATABASE VECTRON_DEMAND;
USE SCHEMA APP;

-- Forward planning weeks, numbered 1..52 from the week after history end.
CREATE OR REPLACE VIEW V_PLAN_WEEK AS
SELECT w.WEEK_ID, w.WEEK_START_DATE, w.CALENDAR_MONTH, w.ISO_YEAR,
       ROW_NUMBER() OVER (ORDER BY w.WEEK_START_DATE) AS WEEK_NO
FROM CORE.DIM_WEEK w
WHERE w.WEEK_ID > (SELECT HISTORY_END_WEEK FROM APP.V_CONTEXT);

-- Demand to plan for: committed plan plus every live scenario.
CREATE OR REPLACE VIEW V_SUPPLY_DEMAND_SOURCE AS
SELECT 'COMMITTED' AS PLAN_SOURCE, d.SERIES_ID, d.WEEK_ID, d.PLAN_UNITS AS UNITS
FROM CORE.FACT_DEMAND_PLAN d
UNION ALL
SELECT sp.SCENARIO_ID, sp.SERIES_ID, sp.WEEK_ID, sp.SCENARIO_UNITS
FROM APP.V_SCENARIO_PLAN sp;

-- The list of plan sources, from the dimension rather than DISTINCT over
-- the demand rows (which would scan every scenario's whole plan).
CREATE OR REPLACE VIEW V_PLAN_SOURCE AS
SELECT 'COMMITTED' AS PLAN_SOURCE, 'Committed plan' AS PLAN_SOURCE_NAME
UNION ALL
SELECT SCENARIO_ID, SCENARIO_NAME FROM CORE.DIM_SCENARIO WHERE STATUS <> 'discarded';

-- Series -> SKU x customer through the format mix. Shares sum to 1 per
-- (customer, category, month), so this reconciles to series units exactly.
CREATE OR REPLACE VIEW V_SKU_DEMAND AS
SELECT ds.PLAN_SOURCE, s.PRODUCT_ID || '|' || mix.FORMAT_ID AS SKU_ID,
       s.PRODUCT_ID, mix.FORMAT_ID, s.CUSTOMER_ID, s.CATEGORY_ID,
       pw.WEEK_ID, pw.WEEK_NO, pw.CALENDAR_MONTH,
       SUM(ds.UNITS * mix.SHARE) AS DEMAND_UNITS
FROM APP.V_SUPPLY_DEMAND_SOURCE ds
JOIN CORE.DIM_SERIES s       ON s.SERIES_ID = ds.SERIES_ID
JOIN APP.V_PLAN_WEEK pw      ON pw.WEEK_ID = ds.WEEK_ID
JOIN CORE.CUSTOMER_FORMAT_MIX mix
  ON mix.CUSTOMER_ID = s.CUSTOMER_ID AND mix.CATEGORY_ID = s.CATEGORY_ID
 AND mix.CALENDAR_MONTH = pw.CALENDAR_MONTH
GROUP BY ALL;

-- Opening stock at each customer affiliate, by SKU: the last closing balance
-- in history, split by the format mix of that month.
CREATE OR REPLACE VIEW V_SKU_OPENING_STOCK AS
SELECT s.PRODUCT_ID || '|' || mix.FORMAT_ID AS SKU_ID, s.CUSTOMER_ID,
       SUM(i.CLOSING_UNITS * mix.SHARE) AS OPENING_UNITS
FROM CORE.FACT_INVENTORY_WEEKLY i
JOIN CORE.DIM_SERIES s ON s.SERIES_ID = i.SERIES_ID
JOIN CORE.DIM_WEEK w   ON w.WEEK_ID = i.WEEK_ID
JOIN CORE.CUSTOMER_FORMAT_MIX mix
  ON mix.CUSTOMER_ID = s.CUSTOMER_ID AND mix.CATEGORY_ID = s.CATEGORY_ID
 AND mix.CALENDAR_MONTH = w.CALENDAR_MONTH
WHERE i.WEEK_ID = (SELECT HISTORY_END_WEEK FROM APP.V_CONTEXT)
GROUP BY 1, 2;

-- Stock already on the water. The demo has no in-transit table, so the
-- pipeline is modelled as standard MRP scheduled receipts: for each lane's
-- lead-time weeks, arrivals at the trailing 13-week sell-in rate (orders
-- released before week 1 at the then-normal pace). Without this every
-- customer's first 1-9 weeks of demand reads as past-due, which is an
-- artefact of the model starting cold, not a supply problem.
CREATE OR REPLACE VIEW V_SKU_PIPELINE AS
WITH rate AS (
  SELECT sh.SERIES_ID, SUM(sh.UNITS) / 13 AS WEEKLY_RATE
  FROM CORE.FACT_SHIPMENTS_WEEKLY sh
  JOIN APP.V_WEEK_INDEX wi ON wi.WEEK_ID = sh.WEEK_ID AND wi.WEEKS_AGO BETWEEN 1 AND 13
  GROUP BY 1
)
-- The rate is applied through the FORWARD week's format mix, so winter kits
-- in transit ahead of the season are counted (the historical months may
-- have had no kit share at all).
SELECT s.PRODUCT_ID || '|' || mix.FORMAT_ID AS SKU_ID, s.CUSTOMER_ID, pw.WEEK_NO,
       SUM(r.WEEKLY_RATE * mix.SHARE) AS SCHEDULED_UNITS
FROM rate r
JOIN CORE.DIM_SERIES s ON s.SERIES_ID = r.SERIES_ID
CROSS JOIN APP.V_PLAN_WEEK pw
JOIN CORE.CUSTOMER_FORMAT_MIX mix
  ON mix.CUSTOMER_ID = s.CUSTOMER_ID AND mix.CATEGORY_ID = s.CATEGORY_ID
 AND mix.CALENDAR_MONTH = pw.CALENDAR_MONTH
JOIN CORE.SKU_CUSTOMER_SOURCE sms
  ON sms.SKU_ID = s.PRODUCT_ID || '|' || mix.FORMAT_ID AND sms.CUSTOMER_ID = s.CUSTOMER_ID
JOIN CORE.DIM_LANE l ON l.SITE_ID = sms.SITE_ID AND l.CUSTOMER_ID = s.CUSTOMER_ID
WHERE pw.WEEK_NO <= l.TRANSIT_WEEKS + l.CLEARANCE_WEEKS
GROUP BY 1, 2, 3;

-- Component availability as a fill ratio per part family and calendar year
-- (APP.V_LIQUID_FILL_RATIO) is defined in 08-allocation.sql from the yearly
-- supplier allocations of MCUs, SiC modules and rare-earth magnets. It is
-- driven from the plan, so it moves with it. Part families that draw on no
-- allocated component have no row and are not capped.

-- Net requirement at the customer node, lot-for-lot with safety stock.
--   CUM_DEMAND(t) = sum of demand through t
--   CUM_SCHED(t)  = pipeline arrivals through t (weeks 1..lead only)
--   SS(t)         = SAFETY_WEEKS x forward average weekly demand
--   CUM_RECEIPT(t)= max(0, max over s<=t of
--                         CUM_DEMAND(s) + SS(s) - OPENING - CUM_SCHED(s))
-- A running MAX makes cumulative receipts non-decreasing, i.e. you never
-- "un-receive" stock when demand dips, which is what makes this exact
-- rather than an approximation. Receipts = first difference of that.
CREATE OR REPLACE VIEW V_NET_REQUIREMENT AS
WITH base AS (
  SELECT d.*, COALESCE(o.OPENING_UNITS, 0) AS OPENING_UNITS,
         bp.SAFETY_WEEKS, bp.PRIORITY_TIER,
         COALESCE(pl.SCHEDULED_UNITS, 0) AS SCHEDULED_RECEIPT_UNITS,
         sl.TRANSIT_WEEKS + sl.CLEARANCE_WEEKS AS LEAD_WEEKS,
         SUM(d.DEMAND_UNITS) OVER (PARTITION BY d.PLAN_SOURCE, d.SKU_ID, d.CUSTOMER_ID
                                   ORDER BY d.WEEK_NO) AS CUM_DEMAND,
         AVG(d.DEMAND_UNITS) OVER (PARTITION BY d.PLAN_SOURCE, d.SKU_ID, d.CUSTOMER_ID
                                   ORDER BY d.WEEK_NO
                                   ROWS BETWEEN CURRENT ROW AND 12 FOLLOWING) AS FWD_AVG
  FROM APP.V_SKU_DEMAND d
  LEFT JOIN APP.V_SKU_OPENING_STOCK o ON o.SKU_ID = d.SKU_ID AND o.CUSTOMER_ID = d.CUSTOMER_ID
  LEFT JOIN APP.V_SKU_PIPELINE pl
    ON pl.SKU_ID = d.SKU_ID AND pl.CUSTOMER_ID = d.CUSTOMER_ID AND pl.WEEK_NO = d.WEEK_NO
  JOIN CORE.SKU_CUSTOMER_SOURCE sms ON sms.SKU_ID = d.SKU_ID AND sms.CUSTOMER_ID = d.CUSTOMER_ID
  JOIN CORE.DIM_LANE sl ON sl.SITE_ID = sms.SITE_ID AND sl.CUSTOMER_ID = d.CUSTOMER_ID
  JOIN CORE.DIM_PRODUCT_PRIORITY bp ON bp.PRODUCT_ID = d.PRODUCT_ID
),
sched AS (
  SELECT b.*, SUM(b.SCHEDULED_RECEIPT_UNITS) OVER (
           PARTITION BY b.PLAN_SOURCE, b.SKU_ID, b.CUSTOMER_ID ORDER BY b.WEEK_NO) AS CUM_SCHED
  FROM base b
),
need AS (
  -- Safety stock is phased in over the lead time: an order cannot land
  -- sooner, so demanding the full buffer in week 1 only manufactures a
  -- past-due artefact. Standard 'rebuild after the frozen zone' policy.
  SELECT b.*,
         b.SAFETY_WEEKS * b.FWD_AVG * LEAST(1, b.WEEK_NO / (b.LEAD_WEEKS + 1)) AS SAFETY_STOCK_UNITS,
         GREATEST(0, MAX(b.CUM_DEMAND
                         + b.SAFETY_WEEKS * b.FWD_AVG * LEAST(1, b.WEEK_NO / (b.LEAD_WEEKS + 1))
                         - b.OPENING_UNITS - b.CUM_SCHED)
               OVER (PARTITION BY b.PLAN_SOURCE, b.SKU_ID, b.CUSTOMER_ID ORDER BY b.WEEK_NO
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS CUM_RECEIPT
  FROM sched b
)
SELECT n.PLAN_SOURCE, n.SKU_ID, n.PRODUCT_ID, n.FORMAT_ID, n.CUSTOMER_ID, n.CATEGORY_ID,
       n.WEEK_ID, n.WEEK_NO, n.CALENDAR_MONTH, n.PRIORITY_TIER,
       n.DEMAND_UNITS, n.OPENING_UNITS, n.SAFETY_STOCK_UNITS, n.SCHEDULED_RECEIPT_UNITS,
       n.CUM_RECEIPT - COALESCE(LAG(n.CUM_RECEIPT) OVER (
           PARTITION BY n.PLAN_SOURCE, n.SKU_ID, n.CUSTOMER_ID ORDER BY n.WEEK_NO), 0)
         AS NET_RECEIPT_UNITS,
       n.OPENING_UNITS + n.CUM_SCHED + n.CUM_RECEIPT - n.CUM_DEMAND AS PROJECTED_BALANCE_UNITS
FROM need n;

-- Planned orders, offset back from receipt at the customer to production at
-- the site by transit + clearance. A release that would fall before week 1
-- is PAST DUE: it is pulled into week 1 and flagged, because the plan
-- already needs stock it is too late to make on time.
CREATE OR REPLACE VIEW V_PLANNED_ORDERS AS
SELECT r.PLAN_SOURCE, r.SKU_ID, r.PRODUCT_ID, r.FORMAT_ID, r.CUSTOMER_ID, r.CATEGORY_ID,
       r.PRIORITY_TIER, sms.SITE_ID, sms.LINE_ID,
       r.WEEK_ID AS RECEIPT_WEEK_ID, r.WEEK_NO AS RECEIPT_WEEK_NO,
       l.TRANSIT_WEEKS + l.CLEARANCE_WEEKS AS LEAD_WEEKS,
       GREATEST(1, r.WEEK_NO - l.TRANSIT_WEEKS - l.CLEARANCE_WEEKS) AS RELEASE_WEEK_NO,
       r.WEEK_NO - l.TRANSIT_WEEKS - l.CLEARANCE_WEEKS < 1 AS IS_PAST_DUE,
       r.CALENDAR_MONTH AS RECEIPT_MONTH,
       r.NET_RECEIPT_UNITS AS ORDER_UNITS
FROM APP.V_NET_REQUIREMENT r
JOIN CORE.SKU_CUSTOMER_SOURCE sms ON sms.SKU_ID = r.SKU_ID AND sms.CUSTOMER_ID = r.CUSTOMER_ID
JOIN CORE.DIM_LANE l           ON l.SITE_ID = sms.SITE_ID AND l.CUSTOMER_ID = r.CUSTOMER_ID
WHERE r.NET_RECEIPT_UNITS > 0;

-- Unconstrained load on each line by production week, against capacity.
CREATE OR REPLACE VIEW V_LINE_LOAD AS
SELECT src.PLAN_SOURCE, ln.LINE_ID, ln.SITE_ID, ln.LINE_NAME, pw.WEEK_ID, pw.WEEK_NO,
       ln.CAPACITY_UNITS_WEEK,
       COALESCE(SUM(po.ORDER_UNITS), 0) AS LOAD_UNITS,
       COALESCE(SUM(po.ORDER_UNITS), 0) / NULLIF(ln.CAPACITY_UNITS_WEEK, 0) AS UTILISATION,
       COALESCE(SUM(IFF(po.IS_PAST_DUE, po.ORDER_UNITS, 0)), 0) AS PAST_DUE_UNITS
FROM CORE.DIM_LINE ln
CROSS JOIN APP.V_PLAN_WEEK pw
CROSS JOIN APP.V_PLAN_SOURCE src
LEFT JOIN APP.V_PLANNED_ORDERS po
  ON po.LINE_ID = ln.LINE_ID AND po.RELEASE_WEEK_NO = pw.WEEK_NO
 AND po.PLAN_SOURCE = src.PLAN_SOURCE
GROUP BY src.PLAN_SOURCE, ln.LINE_ID, ln.SITE_ID, ln.LINE_NAME,
         pw.WEEK_ID, pw.WEEK_NO, ln.CAPACITY_UNITS_WEEK;

-- Migration for databases built before 18 carried the base rate (idempotent).
ALTER TABLE CORE.DIM_DRY_GOOD ADD COLUMN IF NOT EXISTS BASE_SUPPLY_UNITS_WEEK NUMBER(18,0);
UPDATE CORE.DIM_DRY_GOOD SET BASE_SUPPLY_UNITS_WEEK = BASE_NEED_2025 WHERE BASE_SUPPLY_UNITS_WEEK IS NULL;

-- ---------------------------------------------------------------------
-- Planned-order cache. V_PLANNED_ORDERS is exact but costs 2-3 s on an
-- X-Small, and the supply page and the solve both need it. The cache holds
-- one plan source's orders together with the plan version they were built
-- from (the same HASH_AGG the solve records), so a read is current by
-- construction: APP.SP_REFRESH_ORDER_CACHE rebuilds a source only when its
-- version has moved, and the app checks the version before every read.
-- No job, schedule or lag; an edit is picked up by the next read.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_PLAN_VERSION AS
SELECT PLAN_SOURCE, TO_VARCHAR(HASH_AGG(SERIES_ID, WEEK_ID, UNITS)) AS PLAN_VERSION
FROM APP.V_SUPPLY_DEMAND_SOURCE
GROUP BY PLAN_SOURCE;

CREATE TABLE IF NOT EXISTS CORE.SUPPLY_ORDER_CACHE AS
SELECT * FROM APP.V_PLANNED_ORDERS WHERE FALSE;
CREATE TABLE IF NOT EXISTS CORE.SUPPLY_ORDER_CACHE_VERSION (
  PLAN_SOURCE   VARCHAR(60) NOT NULL,
  PLAN_VERSION  VARCHAR(40) NOT NULL,
  BUILT_AT      TIMESTAMP_LTZ NOT NULL
);
-- Re-running this file can change the netting itself (network, BOM, lanes),
-- which the plan version does not see, so start the cache empty.
TRUNCATE TABLE CORE.SUPPLY_ORDER_CACHE;
TRUNCATE TABLE CORE.SUPPLY_ORDER_CACHE_VERSION;

CREATE OR REPLACE PROCEDURE VECTRON_DEMAND.APP.SP_REFRESH_ORDER_CACHE(SRC VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  current_version VARCHAR;
  cached_version VARCHAR;
BEGIN
  SELECT MAX(PLAN_VERSION) INTO :current_version
    FROM VECTRON_DEMAND.APP.V_PLAN_VERSION WHERE PLAN_SOURCE = :SRC;
  SELECT MAX(PLAN_VERSION) INTO :cached_version
    FROM VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE_VERSION WHERE PLAN_SOURCE = :SRC;
  IF (current_version IS NOT NULL AND current_version = cached_version) THEN
    RETURN current_version;
  END IF;
  BEGIN TRANSACTION;
  DELETE FROM VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE WHERE PLAN_SOURCE = :SRC;
  DELETE FROM VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE_VERSION WHERE PLAN_SOURCE = :SRC;
  INSERT INTO VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE
    SELECT * FROM VECTRON_DEMAND.APP.V_PLANNED_ORDERS WHERE PLAN_SOURCE = :SRC;
  -- The version is re-read inside the transaction with the orders, so the
  -- pair cannot describe two different plans.
  INSERT INTO VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE_VERSION
    SELECT PLAN_SOURCE, PLAN_VERSION, CURRENT_TIMESTAMP()
    FROM VECTRON_DEMAND.APP.V_PLAN_VERSION WHERE PLAN_SOURCE = :SRC;
  COMMIT;
  SELECT MAX(PLAN_VERSION) INTO :current_version
    FROM VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE_VERSION WHERE PLAN_SOURCE = :SRC;
  RETURN current_version;
END;
$$;

-- Dry-goods need by production week (own sites only; co-packers buy their
-- own). Kit packaging resolves through the season table for the receipt month.
-- Reads the order cache: call APP.SP_REFRESH_ORDER_CACHE(source) first.
CREATE OR REPLACE VIEW V_DRY_GOODS_NEED AS
SELECT po.PLAN_SOURCE,
       IFF(b.ITEM_ID = 'GIFT_CARTON', g.CARTON_ID, b.ITEM_ID) AS ITEM_ID,
       po.RELEASE_WEEK_NO AS WEEK_NO,
       SUM(po.ORDER_UNITS * b.QTY_PER_CASE) AS NEED_UNITS
FROM CORE.SUPPLY_ORDER_CACHE po
JOIN CORE.BOM_SKU b ON b.SKU_ID = po.SKU_ID AND b.ITEM_ID <> 'LIQUID_LPA'
JOIN CORE.CUSTOMER_GIFT_SEASON g
  ON g.CUSTOMER_ID = po.CUSTOMER_ID AND g.CALENDAR_MONTH = po.RECEIPT_MONTH
WHERE po.SITE_ID <> 'SITE-OCP'
GROUP BY 1, 2, 3;

-- Deliveries per item and week, honouring the supplier lead time: within
-- LEAD_WEEKS only what is already on order at the base rate arrives; the
-- supplier's headroom (SUPPLY_UNITS_WEEK) is available from the week after.
-- The solve (scripts/supply_solve.py) uses the same rule.
CREATE OR REPLACE VIEW V_DRY_GOODS_DELIVERY AS
SELECT dg.ITEM_ID, pw.WEEK_NO,
       IFF(pw.WEEK_NO <= dg.LEAD_WEEKS, dg.BASE_SUPPLY_UNITS_WEEK, dg.SUPPLY_UNITS_WEEK)
         AS DELIVERY_UNITS
FROM CORE.DIM_DRY_GOOD dg
CROSS JOIN APP.V_PLAN_WEEK pw;

-- Coverage: cumulative need vs opening stock + supplier deliveries. The
-- first week cumulative need overtakes cumulative availability is the week
-- that item stops the plan, if nothing changes. Only sources present in the
-- order cache appear.
CREATE OR REPLACE VIEW V_DRY_GOODS_COVERAGE AS
WITH grid AS (
  SELECT src.PLAN_SOURCE, dg.ITEM_ID, dg.ITEM_NAME, dg.ITEM_TYPE, dg.LEAD_WEEKS,
         dg.SUPPLY_UNITS_WEEK, dg.BASE_SUPPLY_UNITS_WEEK, dg.OPENING_UNITS,
         pw.WEEK_NO, pw.WEEK_ID, dl.DELIVERY_UNITS,
         COALESCE(n.NEED_UNITS, 0) AS NEED_UNITS
  FROM CORE.DIM_DRY_GOOD dg
  CROSS JOIN APP.V_PLAN_WEEK pw
  CROSS JOIN CORE.SUPPLY_ORDER_CACHE_VERSION src
  JOIN APP.V_DRY_GOODS_DELIVERY dl ON dl.ITEM_ID = dg.ITEM_ID AND dl.WEEK_NO = pw.WEEK_NO
  LEFT JOIN APP.V_DRY_GOODS_NEED n
    ON n.PLAN_SOURCE = src.PLAN_SOURCE AND n.ITEM_ID = dg.ITEM_ID AND n.WEEK_NO = pw.WEEK_NO
)
SELECT g.*,
       SUM(g.NEED_UNITS) OVER (PARTITION BY g.PLAN_SOURCE, g.ITEM_ID ORDER BY g.WEEK_NO) AS CUM_NEED,
       g.OPENING_UNITS + SUM(g.DELIVERY_UNITS) OVER (PARTITION BY g.PLAN_SOURCE, g.ITEM_ID
                                                     ORDER BY g.WEEK_NO) AS CUM_AVAILABLE,
       g.OPENING_UNITS
         + SUM(g.DELIVERY_UNITS - g.NEED_UNITS) OVER (PARTITION BY g.PLAN_SOURCE, g.ITEM_ID
                                                      ORDER BY g.WEEK_NO)
         AS PROJECTED_UNITS
FROM grid g;

-- Allocated components drawn by production week, per component family.
-- NEED_LPA (inherited name) is pieces of component.
CREATE OR REPLACE VIEW V_LIQUID_NEED AS
SELECT po.PLAN_SOURCE, ba.LIQUID_FAMILY, po.RELEASE_WEEK_NO AS WEEK_NO,
       SUM(po.ORDER_UNITS * ba.COMPONENT_QTY) AS NEED_LPA
FROM APP.V_PLANNED_ORDERS po
JOIN CORE.DIM_PRODUCT_AGE ba ON ba.PRODUCT_ID = po.PRODUCT_ID
GROUP BY 1, 2, 3;
