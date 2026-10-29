-- =====================================================================
-- 18-supply-network.sql — supply network master data (MRP-lite)
-- =====================================================================
-- Everything here is ILLUSTRATIVE. Plant names are Vectron's fictional
-- network; capacities, lead times and component availability are demo
-- assumptions scaled from 2025 shipments. Each table carries IS_ILLUSTRATIVE
-- so the app can say so.
--
-- Design:
--   * Demand is planned at SERIES (part family x customer x channel) in
--     pieces. Supply runs at SKU (part family x delivery variant) x customer.
--     CUSTOMER_FORMAT_MIX is the bridge: shares per customer x category x
--     calendar month that sum to exactly 1, so SKU units reconcile to series
--     units by construction.
--   * The delivery VARIANT is the real constraint: a just-in-sequence rack
--     for BMW runs on a sequenced cell, a JIT box on a different line, and
--     service and aftermarket packs on a third. A demand shift between
--     customers is therefore a load shift between specific lines.
--   * The independent aftermarket buys winter service kits (pads, discs,
--     links) ahead of the season: a seasonal variant with long-lead kit
--     packaging, the item most likely to bind in Q4.
--   * Capacity is DERIVED ONCE from 2025 shipments x a fixed headroom per
--     line and stored as numbers. It never reads the live plan, so a plan
--     change moves load against a fixed capacity rather than rescaling it.
--   * Commodity aftermarket parts come from contract manufacturers
--     (SITE-OCP): a lead time and no Vectron line constraint.
--   * The yearly component ALLOCATION constraint (MCUs, SiC, magnets) lives
--     in 08-allocation.sql; the components here are weekly-flex bought parts.
--
-- Column names (BOTTLE_LITRES, QTY_PER_CASE, GIFT_*, CARTON_ID) are
-- inherited from the original schema the netting views and solver read.
-- BOTTLE_LITRES is 9 for every variant so the inherited `9 / BOTTLE_LITRES`
-- factor is exactly one component per piece.
-- Run after 17. Static: safe to re-run (no live data stored here).
-- =====================================================================
USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- Delivery variants.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_PACK_FORMAT (
  FORMAT_ID      VARCHAR(10) PRIMARY KEY,
  FORMAT_NAME    VARCHAR(30) NOT NULL,
  BOTTLE_LITRES  NUMBER(5,3) NOT NULL,
  IS_GIFT        BOOLEAN     NOT NULL,
  SORT_ORDER     NUMBER(2,0) NOT NULL
);
INSERT INTO DIM_PACK_FORMAT VALUES
  ('FJIS', 'JIS rack',          9.000, FALSE, 1),
  ('FJIT', 'JIT box',           9.000, FALSE, 2),
  ('FSVC', 'Service pack',      9.000, FALSE, 3),
  ('FAM',  'Aftermarket box',   9.000, FALSE, 4),
  ('FKIT', 'Winter service kit', 9.000, TRUE, 5);

-- ---------------------------------------------------------------------
-- Customer x category x month variant mix. OEMs take their series variant
-- plus service packs for their OES business; the aftermarket takes boxed
-- parts, with a winter-kit share carved out in autumn.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE CUSTOMER_FORMAT_BASE (
  CUSTOMER_ID VARCHAR(10), FORMAT_ID VARCHAR(10), SHARE NUMBER(6,4)
);
INSERT INTO CUSTOMER_FORMAT_BASE VALUES
  ('OEM-BMW','FJIS',0.86),('OEM-BMW','FSVC',0.14),
  ('OEM-VW','FJIS',0.86),('OEM-VW','FSVC',0.14),
  ('OEM-AUDI','FJIS',0.86),('OEM-AUDI','FSVC',0.14),
  ('OEM-POR','FJIS',0.86),('OEM-POR','FSVC',0.14),
  ('OEM-MB','FJIS',0.86),('OEM-MB','FSVC',0.14),
  ('OEM-STLA','FJIT',0.86),('OEM-STLA','FSVC',0.14),
  ('OEM-REN','FJIT',0.86),('OEM-REN','FSVC',0.14),
  ('OEM-FORD','FJIT',0.86),('OEM-FORD','FSVC',0.14),
  ('AM-IAM','FAM',1.00);

-- Seasonal kit share by customer and calendar month (kit categories only).
CREATE OR REPLACE TABLE CUSTOMER_GIFT_SEASON (
  CUSTOMER_ID VARCHAR(10), CALENDAR_MONTH NUMBER(2,0), GIFT_SHARE NUMBER(6,4),
  CARTON_ID VARCHAR(20)
);
INSERT INTO CUSTOMER_GIFT_SEASON
SELECT m.CUSTOMER_ID, mo.n,
       CASE WHEN m.CUSTOMER_ID = 'AM-IAM' AND mo.n IN (10, 11) THEN 0.22
            WHEN m.CUSTOMER_ID = 'AM-IAM' AND mo.n = 9         THEN 0.08
            ELSE 0 END,
       'KIT-WINTER'
FROM DIM_CUSTOMER m
CROSS JOIN (SELECT SEQ4() + 1 AS n FROM TABLE(GENERATOR(ROWCOUNT => 12))) mo;

CREATE OR REPLACE TABLE GIFT_CATEGORY (CATEGORY_ID VARCHAR(20) PRIMARY KEY);
INSERT INTO GIFT_CATEGORY VALUES ('CAT-BRAKE'), ('CAT-CHASSIS');

CREATE OR REPLACE TABLE CUSTOMER_FORMAT_MIX AS
SELECT b.CUSTOMER_ID, c.CATEGORY_ID, g.CALENDAR_MONTH, b.FORMAT_ID,
       b.SHARE * (1 - IFF(gc.CATEGORY_ID IS NOT NULL, g.GIFT_SHARE, 0)) AS SHARE,
       TRUE AS IS_ILLUSTRATIVE
FROM CUSTOMER_FORMAT_BASE b
CROSS JOIN DIM_CATEGORY c
JOIN CUSTOMER_GIFT_SEASON g ON g.CUSTOMER_ID = b.CUSTOMER_ID
LEFT JOIN GIFT_CATEGORY gc ON gc.CATEGORY_ID = c.CATEGORY_ID
UNION ALL
SELECT g.CUSTOMER_ID, gc.CATEGORY_ID, g.CALENDAR_MONTH, 'FKIT', g.GIFT_SHARE, TRUE
FROM CUSTOMER_GIFT_SEASON g
CROSS JOIN GIFT_CATEGORY gc
WHERE g.GIFT_SHARE > 0;

-- ---------------------------------------------------------------------
-- Plants, lines, sourcing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_SUPPLY_SITE (
  SITE_ID VARCHAR(10) PRIMARY KEY, SITE_NAME VARCHAR(60) NOT NULL,
  COUNTRY VARCHAR(30) NOT NULL, SITE_TYPE VARCHAR(20) NOT NULL,
  IS_CAPACITY_CONSTRAINED BOOLEAN NOT NULL, IS_ILLUSTRATIVE BOOLEAN NOT NULL
);
INSERT INTO DIM_SUPPLY_SITE VALUES
  ('SITE-REG','Vectron Regensburg (brakes, steering)', 'Germany',  'OWN_PLANT', TRUE,  TRUE),
  ('SITE-PLZ','Vectron Plzeň (chassis)',               'Czechia',  'OWN_PLANT', TRUE,  TRUE),
  ('SITE-WRO','Vectron Wrocław (driveline)',           'Poland',   'OWN_PLANT', TRUE,  TRUE),
  ('SITE-DEB','Vectron Debrecen (e-drive)',            'Hungary',  'OWN_PLANT', TRUE,  TRUE),
  ('SITE-SLP','Vectron San Luis Potosí',               'Mexico',   'OWN_PLANT', TRUE,  TRUE),
  ('SITE-OCP','Contract manufacturers',                'Various',  'CO_PACKER', FALSE, TRUE);

-- Which plant supplies a category to a customer. Ford's brake and chassis
-- parts are built in Mexico; commodity aftermarket parts come from contract
-- manufacturers; everything else follows category.
CREATE OR REPLACE TABLE SKU_SOURCING_RULE (
  CATEGORY_ID VARCHAR(20), CUSTOMER_ID VARCHAR(10), PRICE_TIER VARCHAR(20),
  SITE_ID VARCHAR(10), RULE_PRIORITY NUMBER(2,0)
);
INSERT INTO SKU_SOURCING_RULE VALUES
  ('CAT-BRAKE',   'OEM-FORD', NULL,        'SITE-SLP', 1),
  ('CAT-CHASSIS', 'OEM-FORD', NULL,        'SITE-SLP', 1),
  ('CAT-BRAKE',   'AM-IAM',   'Commodity', 'SITE-OCP', 1),
  ('CAT-CHASSIS', 'AM-IAM',   'Commodity', 'SITE-OCP', 1),
  ('CAT-BRAKE',   NULL,       NULL,        'SITE-REG', 9),
  ('CAT-STEER',   NULL,       NULL,        'SITE-REG', 9),
  ('CAT-CHASSIS', NULL,       NULL,        'SITE-PLZ', 9),
  ('CAT-PT',      NULL,       NULL,        'SITE-WRO', 9),
  ('CAT-EDRIVE',  NULL,       NULL,        'SITE-DEB', 9);

-- 14 lines. A (site, variant) pair has exactly one line. HEADROOM is
-- capacity over the 2025 average weekly load: < ~1.15 is deliberately tight
-- (Plzeň's aftermarket and kit line). Debrecen's e-axle line was expanded
-- for the gen-2 launch, so its headroom over 2025 load is large; the launch
-- ramp still peaks above it.
CREATE OR REPLACE TABLE DIM_LINE_SEED (
  LINE_ID VARCHAR(12), SITE_ID VARCHAR(10), LINE_NAME VARCHAR(40),
  FORMATS VARCHAR(40), HEADROOM NUMBER(5,3), LOT_SIZE_UNITS NUMBER(8,0),
  CHANGEOVER_LOSS NUMBER(5,3)
);
INSERT INTO DIM_LINE_SEED VALUES
  ('REG-L1','SITE-REG','Regensburg sequenced cell (JIS)',   'FJIS',      1.22, 500, 0.04),
  ('REG-L2','SITE-REG','Regensburg JIT and service line',   'FJIT,FSVC', 1.30, 500, 0.05),
  ('REG-L3','SITE-REG','Regensburg aftermarket and kits',   'FAM,FKIT',  1.25, 250, 0.07),
  ('PLZ-L1','SITE-PLZ','Plzeň sequenced cell (JIS)',        'FJIS',      1.20, 500, 0.04),
  ('PLZ-L2','SITE-PLZ','Plzeň JIT and service line',        'FJIT,FSVC', 1.30, 500, 0.05),
  ('PLZ-L3','SITE-PLZ','Plzeň aftermarket and kits',        'FAM,FKIT',  1.15, 250, 0.07),
  ('WRO-L1','SITE-WRO','Wrocław series line',               'FJIS,FJIT', 1.35, 500, 0.05),
  ('WRO-L2','SITE-WRO','Wrocław service and aftermarket',   'FSVC,FAM',  1.40, 250, 0.06),
  ('DEB-L1','SITE-DEB','Debrecen e-axle assembly',          'FJIS,FJIT', 1.60, 100, 0.06),
  ('DEB-L2','SITE-DEB','Debrecen service and aftermarket',  'FSVC,FAM',  1.40, 100, 0.06),
  ('SLP-L1','SITE-SLP','San Luis Potosí JIT line',          'FJIT',      1.20, 500, 0.04),
  ('SLP-L2','SITE-SLP','San Luis Potosí service line',      'FSVC',      1.40, 250, 0.05),
  ('SLP-L3','SITE-SLP','San Luis Potosí sequenced cell',    'FJIS',      1.30, 250, 0.05),
  -- Ford takes no aftermarket variants; the line exists so every SKU routes.
  ('SLP-L4','SITE-SLP','San Luis Potosí aftermarket pack',  'FAM,FKIT',  1.40, 250, 0.05);

CREATE OR REPLACE TABLE LINE_FORMAT AS
SELECT l.LINE_ID, l.SITE_ID, TRIM(f.VALUE::VARCHAR) AS FORMAT_ID
FROM DIM_LINE_SEED l, LATERAL FLATTEN(INPUT => SPLIT(l.FORMATS, ',')) f;

-- ---------------------------------------------------------------------
-- Lanes: plant -> customer. Weeks in transit plus customs clearance.
-- San Luis Potosí serves Ford only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_LANE AS
WITH region_lead AS (
  SELECT * FROM VALUES
    ('OEM-BMW',1,0),('OEM-VW',1,0),('OEM-AUDI',1,0),('OEM-POR',1,0),('OEM-MB',1,0),
    ('OEM-STLA',1,0),('OEM-REN',1,0),('OEM-FORD',5,1),('AM-IAM',2,0)
    AS t(CUSTOMER_ID, TRANSIT_WEEKS, CLEARANCE_WEEKS)
)
SELECT s.SITE_ID, r.CUSTOMER_ID,
       CASE WHEN s.SITE_ID = 'SITE-SLP' THEN 1
            WHEN s.SITE_ID = 'SITE-OCP' THEN r.TRANSIT_WEEKS + 2   -- incl. consolidation
            ELSE r.TRANSIT_WEEKS END AS TRANSIT_WEEKS,
       IFF(s.SITE_ID = 'SITE-SLP', 0, r.CLEARANCE_WEEKS) AS CLEARANCE_WEEKS,
       TRUE AS IS_ILLUSTRATIVE
FROM DIM_SUPPLY_SITE s
CROSS JOIN region_lead r
WHERE s.SITE_ID <> 'SITE-SLP' OR r.CUSTOMER_ID = 'OEM-FORD';

-- ---------------------------------------------------------------------
-- Allocation priority when constrained: line-stop-critical parts first
-- (single-sourced mechatronic and engineered content on a running OEM line),
-- then pro-rata within a tier.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_PRODUCT_PRIORITY AS
SELECT PRODUCT_ID,
       CASE WHEN PRICE_TIER = 'Mechatronic' OR LIFECYCLE_STATUS = 'Launch' THEN 1
            WHEN PRICE_TIER = 'Engineered' THEN 2 ELSE 3 END AS PRIORITY_TIER,
       CASE WHEN PRICE_TIER = 'Mechatronic' OR LIFECYCLE_STATUS = 'Launch' THEN 'Line-stop critical'
            WHEN PRICE_TIER = 'Engineered' THEN 'Core' ELSE 'Commodity' END AS PRIORITY_LABEL,
       -- Weeks of safety stock held at the hub ahead of the customer.
       CASE WHEN PRICE_TIER = 'Mechatronic' OR LIFECYCLE_STATUS = 'Launch' THEN 2
            WHEN PRICE_TIER = 'Engineered' THEN 2 ELSE 1 END AS SAFETY_WEEKS
FROM DIM_PRODUCT;

-- ---------------------------------------------------------------------
-- SKU: part family x variant, with its supplying plant per customer and line.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_SKU AS
SELECT b.PRODUCT_ID || '|' || f.FORMAT_ID AS SKU_ID, b.PRODUCT_ID, f.FORMAT_ID,
       b.PRODUCT_NAME || ' (' || f.FORMAT_NAME || ')' AS SKU_NAME,
       b.CATEGORY_ID, b.PRICE_TIER, b.PART_WEIGHT_KG
FROM DIM_PRODUCT b CROSS JOIN DIM_PACK_FORMAT f
WHERE f.FORMAT_ID <> 'FKIT'
   OR b.CATEGORY_ID IN (SELECT CATEGORY_ID FROM GIFT_CATEGORY);

CREATE OR REPLACE TABLE SKU_CUSTOMER_SOURCE AS
SELECT k.SKU_ID, m.CUSTOMER_ID, r.SITE_ID, lf.LINE_ID
FROM DIM_SKU k
CROSS JOIN DIM_CUSTOMER m
JOIN SKU_SOURCING_RULE r
  ON r.CATEGORY_ID = k.CATEGORY_ID
 AND (r.CUSTOMER_ID IS NULL OR r.CUSTOMER_ID = m.CUSTOMER_ID)
 AND (r.PRICE_TIER IS NULL OR r.PRICE_TIER = k.PRICE_TIER)
LEFT JOIN LINE_FORMAT lf ON lf.SITE_ID = r.SITE_ID AND lf.FORMAT_ID = k.FORMAT_ID
QUALIFY ROW_NUMBER() OVER (PARTITION BY k.SKU_ID, m.CUSTOMER_ID ORDER BY r.RULE_PRIORITY) = 1;

-- ---------------------------------------------------------------------
-- Line capacity, derived once from 2025 shipments routed through the bridge.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_LINE AS
WITH ship25 AS (
  SELECT s.PRODUCT_ID, s.CUSTOMER_ID, s.CATEGORY_ID, w.CALENDAR_MONTH, sh.WEEK_ID, sh.UNITS
  FROM FACT_SHIPMENTS_WEEKLY sh
  JOIN DIM_SERIES s ON s.SERIES_ID = sh.SERIES_ID
  JOIN DIM_WEEK w   ON w.WEEK_ID = sh.WEEK_ID
  WHERE w.ISO_YEAR = 2025
),
load25 AS (
  -- Average over the weeks the line actually RUNS: kit lines only run in
  -- season, so a 52-week average would size them at a fraction of load.
  SELECT sms.LINE_ID,
         SUM(x.UNITS * mix.SHARE) / NULLIF(COUNT(DISTINCT x.WEEK_ID), 0) AS AVG_WEEKLY_UNITS
  FROM ship25 x
  JOIN CUSTOMER_FORMAT_MIX mix
    ON mix.CUSTOMER_ID = x.CUSTOMER_ID AND mix.CATEGORY_ID = x.CATEGORY_ID
   AND mix.CALENDAR_MONTH = x.CALENDAR_MONTH
  JOIN SKU_CUSTOMER_SOURCE sms
    ON sms.SKU_ID = x.PRODUCT_ID || '|' || mix.FORMAT_ID AND sms.CUSTOMER_ID = x.CUSTOMER_ID
  WHERE sms.LINE_ID IS NOT NULL AND mix.SHARE > 0
  GROUP BY 1
)
SELECT l.LINE_ID, l.SITE_ID, l.LINE_NAME, l.FORMATS,
       GREATEST(l.LOT_SIZE_UNITS,
                CEIL(COALESCE(ld.AVG_WEEKLY_UNITS, 0) * l.HEADROOM / l.LOT_SIZE_UNITS)
                  * l.LOT_SIZE_UNITS) AS CAPACITY_UNITS_WEEK,
       ROUND(COALESCE(ld.AVG_WEEKLY_UNITS, 0), 0) AS BASE_LOAD_2025,
       l.HEADROOM, l.LOT_SIZE_UNITS, l.CHANGEOVER_LOSS,
       TRUE AS IS_ILLUSTRATIVE
FROM DIM_LINE_SEED l
LEFT JOIN load25 ld ON ld.LINE_ID = l.LINE_ID;

-- ---------------------------------------------------------------------
-- Bought components with weekly supplier flex. Availability is derived
-- once from the 2025 average need x a supplier headroom, like line capacity.
-- ECU boards have the longest lead and least headroom; winter-kit packaging
-- is bought for the season and binds in the autumn peak.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_DRY_GOOD_SEED (
  ITEM_ID VARCHAR(20), ITEM_NAME VARCHAR(40), ITEM_TYPE VARCHAR(20),
  LEAD_WEEKS NUMBER(3,0), MOQ_UNITS NUMBER(10,0), SUPPLIER_HEADROOM NUMBER(5,3),
  OPENING_WEEKS_COVER NUMBER(4,1)
);
INSERT INTO DIM_DRY_GOOD_SEED VALUES
  ('CAST-AL',    'Aluminium castings',          'CASTING',     10, 5000,  1.15, 4),
  ('FORG-ST',    'Steel forgings',              'FORGING',      8, 10000, 1.25, 4),
  ('ECU-PCBA',   'ECU board assemblies',        'ELECTRONICS', 16, 2000,  1.06, 3),
  ('BRG',        'Bearings and seals',          'BEARING',      6, 20000, 1.30, 4),
  ('PKG-RACK',   'Returnable JIS racks',        'PACKAGING',    4, 500,   1.40, 3),
  ('PKG-BOX',    'Cartons and labels',          'PACKAGING',    2, 20000, 1.40, 3),
  ('KIT-WINTER', 'Winter-kit packaging',        'GIFT_CARTON', 14, 5000,  1.05, 2);

-- BOM per SKU (per piece). The kit packaging item resolves through
-- CUSTOMER_GIFT_SEASON in the netting views, as the seasonal item always has.
CREATE OR REPLACE TABLE BOM_SKU AS
SELECT k.SKU_ID, 'LIQUID_LPA' AS ITEM_ID, k.PART_WEIGHT_KG AS QTY_PER_CASE FROM DIM_SKU k  -- raw material kg (reporting only)
UNION ALL
SELECT k.SKU_ID, IFF(k.CATEGORY_ID IN ('CAT-CHASSIS', 'CAT-EDRIVE', 'CAT-STEER'), 'CAST-AL', 'FORG-ST'), 1
FROM DIM_SKU k
UNION ALL
SELECT k.SKU_ID, 'ECU-PCBA', 1 FROM DIM_SKU k WHERE k.PRICE_TIER = 'Mechatronic'
UNION ALL
SELECT k.SKU_ID, 'BRG', 2 FROM DIM_SKU k
WHERE k.PRODUCT_ID IN ('P-WHUB', 'P-HSHAFT', 'P-DIFF', 'P-EAXLE', 'P-EAX2', 'P-RGB', 'P-DAMP', 'P-DAMPA')
UNION ALL
SELECT k.SKU_ID, IFF(k.FORMAT_ID = 'FJIS', 'PKG-RACK', 'PKG-BOX'), 1 FROM DIM_SKU k
UNION ALL
SELECT k.SKU_ID, 'GIFT_CARTON', 1
FROM DIM_SKU k JOIN DIM_PACK_FORMAT f ON f.FORMAT_ID = k.FORMAT_ID
WHERE f.IS_GIFT;

CREATE OR REPLACE TABLE DIM_DRY_GOOD AS
WITH need25 AS (
  SELECT COALESCE(IFF(b.ITEM_ID = 'GIFT_CARTON', g.CARTON_ID, NULL), b.ITEM_ID) AS ITEM_ID,
         SUM(sh.UNITS * mix.SHARE * b.QTY_PER_CASE) / 52 AS AVG_WEEKLY_UNITS
  FROM FACT_SHIPMENTS_WEEKLY sh
  JOIN DIM_SERIES s ON s.SERIES_ID = sh.SERIES_ID
  JOIN DIM_WEEK w   ON w.WEEK_ID = sh.WEEK_ID AND w.ISO_YEAR = 2025
  JOIN CUSTOMER_FORMAT_MIX mix
    ON mix.CUSTOMER_ID = s.CUSTOMER_ID AND mix.CATEGORY_ID = s.CATEGORY_ID
   AND mix.CALENDAR_MONTH = w.CALENDAR_MONTH
  JOIN SKU_CUSTOMER_SOURCE sms
    ON sms.SKU_ID = s.PRODUCT_ID || '|' || mix.FORMAT_ID AND sms.CUSTOMER_ID = s.CUSTOMER_ID
  JOIN BOM_SKU b ON b.SKU_ID = sms.SKU_ID AND b.ITEM_ID <> 'LIQUID_LPA'
  JOIN CUSTOMER_GIFT_SEASON g
    ON g.CUSTOMER_ID = s.CUSTOMER_ID AND g.CALENDAR_MONTH = w.CALENDAR_MONTH
  WHERE sms.SITE_ID <> 'SITE-OCP'          -- contract manufacturers buy their own
  GROUP BY 1
)
SELECT d.ITEM_ID, d.ITEM_NAME, d.ITEM_TYPE, d.LEAD_WEEKS, d.MOQ_UNITS,
       CEIL(COALESCE(n.AVG_WEEKLY_UNITS, 0) * d.SUPPLIER_HEADROOM) AS SUPPLY_UNITS_WEEK,
       ROUND(COALESCE(n.AVG_WEEKLY_UNITS, 0), 0) AS BASE_SUPPLY_UNITS_WEEK,
       CEIL(COALESCE(n.AVG_WEEKLY_UNITS, 0) * d.OPENING_WEEKS_COVER) AS OPENING_UNITS,
       ROUND(COALESCE(n.AVG_WEEKLY_UNITS, 0), 0) AS BASE_NEED_2025,
       TRUE AS IS_ILLUSTRATIVE
FROM DIM_DRY_GOOD_SEED d
LEFT JOIN need25 n ON n.ITEM_ID = d.ITEM_ID;
