-- =====================================================================
-- Vectron Components — Demand Planning
-- 16: Hierarchies as the dimensions
-- =====================================================================
--
-- Each planning dimension (product, customer, channel, time) is held as one or
-- more parent-child trees over the same leaves. A plan lives at the leaf
-- (series = product × customer × channel, by week) and rolls up through whichever
-- tree the planner picks, so "by category" and "by product family" are two views
-- of one set of numbers, never two sets of numbers.
--
-- THREE TABLES
-- ------------
--   DIM_HIERARCHY        one row per tree, with the dimension it belongs to and
--                        which tree is the default.
--   DIM_HIERARCHY_LEVEL  the ordered levels of each tree. LEVEL_COLUMN names the
--                        APP.V_SERIES column (or DIM_WEEK column for time) the
--                        level is drawn from; the app drills in this order.
--   DIM_HIERARCHY_NODE   every node: root, intermediate levels and leaves, with
--                        its parent. Leaves carry the member id (product, customer,
--                        channel, week) so a tree can be joined to the facts.
--
-- DEFAULTS REPRODUCE THE ORIGINAL STRUCTURE
-- -----------------------------------------
-- Before this script the app had one fixed path: category → product, with customer
-- and channel as flat lists. The default trees are exactly that, so every
-- screen shows the same numbers until a planner picks an alternate roll-up.
--
-- Nodes are derived from the dimension tables, not typed in, so a new product,
-- customer or channel lands in every tree when this script is re-run. The
-- integrity checks at the bottom prove each tree is single-rooted, acyclic,
-- covers every member exactly once, and rolls up to the same plan total.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- APP.V_SERIES (04-app-views.sql) carries CHANNEL_GROUP, ROUTE_TO_CUSTOMER
-- and DELIVERY_MODE for the alternate trees. It is defined there only: a
-- second copy here drifted once and overwrote the Tier 1 labels.

-- ---------------------------------------------------------------------
-- Register of trees and their levels.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_HIERARCHY (
  HIERARCHY_ID   VARCHAR NOT NULL PRIMARY KEY,
  DIMENSION      VARCHAR NOT NULL,   -- PRODUCT | CUSTOMER | CHANNEL | TIME
  HIERARCHY_NAME VARCHAR NOT NULL,
  DESCRIPTION    VARCHAR,
  IS_DEFAULT     BOOLEAN NOT NULL,
  SORT_ORDER     NUMBER  NOT NULL,
  ROOT_LABEL     VARCHAR NOT NULL
);

INSERT INTO DIM_HIERARCHY VALUES
  ('PRODUCT_CATEGORY', 'PRODUCT', 'By category',       'Category, then product. The original portfolio structure.', TRUE,  1, 'Total portfolio'),
  ('PRODUCT_FAMILY',   'PRODUCT', 'By product line',   'Product line (brake calipers, dampers, e-axles…), then part family.', FALSE, 2, 'Total portfolio'),
  ('PRODUCT_TIER',     'PRODUCT', 'By technology tier', 'Commodity, Standard, Engineered and Mechatronic, then part family.', FALSE, 3, 'Total portfolio'),
  ('CUSTOMER_LIST',      'CUSTOMER',  'Customer list',       'Customers as one flat list. The original structure.', TRUE,  1, 'All customers'),
  ('CUSTOMER_REGION',    'CUSTOMER',  'By region',         'Reporting region, then customer.', FALSE, 2, 'All customers'),
  ('CUSTOMER_ROUTE',     'CUSTOMER',  'By route to customer','OEM or aftermarket, then delivery mode (JIS, JIT, stock), then customer.', FALSE, 3, 'All customers'),
  ('CHANNEL_LIST',     'CHANNEL', 'Channel list',      'Channels as one flat list. The original structure.', TRUE,  1, 'All channels'),
  ('CHANNEL_GROUP',    'CHANNEL', 'By channel group',  'OE series or service and aftermarket, then channel.', FALSE, 2, 'All channels'),
  ('TIME_FISCAL',      'TIME',    'Fiscal calendar',   'Fiscal year (calendar year), quarter, period, week.', TRUE,  1, 'All weeks'),
  ('TIME_CALENDAR',    'TIME',    'Calendar',          'Calendar year and month of each week''s Monday, then ISO week.', FALSE, 2, 'All weeks');

CREATE OR REPLACE TABLE DIM_HIERARCHY_LEVEL (
  HIERARCHY_ID VARCHAR NOT NULL,
  LEVEL_NO     NUMBER  NOT NULL,      -- 1 = just below the root
  LEVEL_COLUMN VARCHAR NOT NULL,      -- column on APP.V_SERIES (DIM_WEEK for time)
  LEVEL_LABEL  VARCHAR NOT NULL,
  ALL_LABEL    VARCHAR NOT NULL,      -- "no selection at this level"
  IS_LEAF      BOOLEAN NOT NULL,
  PRIMARY KEY (HIERARCHY_ID, LEVEL_NO)
);

INSERT INTO DIM_HIERARCHY_LEVEL VALUES
  ('PRODUCT_CATEGORY', 1, 'CATEGORY_NAME',   'Category',        'Total portfolio',   FALSE),
  ('PRODUCT_CATEGORY', 2, 'PRODUCT_NAME',      'Part family',       'All part families',        TRUE),
  ('PRODUCT_FAMILY',   1, 'PRODUCT_LINE',    'Product line',    'All product lines', FALSE),
  ('PRODUCT_FAMILY',   2, 'PRODUCT_NAME',      'Part family',       'All part families',        TRUE),
  ('PRODUCT_TIER',     1, 'PRICE_TIER',      'Technology tier', 'All technology tiers',   FALSE),
  ('PRODUCT_TIER',     2, 'PRODUCT_NAME',      'Part family',       'All part families',        TRUE),
  ('CUSTOMER_LIST',      1, 'CUSTOMER_NAME',     'Customer',          'All customers',       TRUE),
  ('CUSTOMER_REGION',    1, 'REGION',          'Region',          'All regions',       FALSE),
  ('CUSTOMER_REGION',    2, 'CUSTOMER_NAME',     'Customer',          'All customers',       TRUE),
  ('CUSTOMER_ROUTE',     1, 'ROUTE_TO_CUSTOMER', 'Route to customer', 'All routes',        FALSE),
  ('CUSTOMER_ROUTE',     2, 'DELIVERY_MODE',      'Delivery mode',   'All delivery modes',  FALSE),
  ('CUSTOMER_ROUTE',     3, 'CUSTOMER_NAME',     'Customer',          'All customers',       TRUE),
  ('CHANNEL_LIST',     1, 'CHANNEL_NAME',    'Channel',         'All channels',      TRUE),
  ('CHANNEL_GROUP',    1, 'CHANNEL_GROUP',   'Channel group',   'All channel groups', FALSE),
  ('CHANNEL_GROUP',    2, 'CHANNEL_NAME',    'Channel',         'All channels',      TRUE),
  ('TIME_FISCAL',      1, 'FISCAL_YEAR',     'Fiscal year',     'All years',         FALSE),
  ('TIME_FISCAL',      2, 'FISCAL_QUARTER',  'Quarter',         'All quarters',      FALSE),
  ('TIME_FISCAL',      3, 'FISCAL_PERIOD',   'Period',          'All periods',       FALSE),
  ('TIME_FISCAL',      4, 'WEEK_ID',         'Week',            'All weeks',         TRUE),
  ('TIME_CALENDAR',    1, 'WEEK_START_DATE', 'Year',            'All years',         FALSE),
  ('TIME_CALENDAR',    2, 'WEEK_START_DATE', 'Month',           'All months',        FALSE),
  ('TIME_CALENDAR',    3, 'WEEK_ID',         'Week',            'All weeks',         TRUE);

-- ---------------------------------------------------------------------
-- Nodes. Node ids are the hierarchy id plus the labelled path, so they are
-- stable across re-runs and readable in a query result.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_HIERARCHY_NODE (
  HIERARCHY_ID   VARCHAR NOT NULL,
  NODE_ID        VARCHAR NOT NULL,
  PARENT_NODE_ID VARCHAR,
  LEVEL_NO       NUMBER  NOT NULL,    -- 0 = root
  NODE_LABEL     VARCHAR NOT NULL,
  MEMBER_ID      VARCHAR,             -- leaf only: PRODUCT_ID / CUSTOMER_ID / CHANNEL_ID / WEEK_ID
  PRIMARY KEY (HIERARCHY_ID, NODE_ID)
);

-- Roots
INSERT INTO DIM_HIERARCHY_NODE
SELECT HIERARCHY_ID, HIERARCHY_ID, NULL, 0, ROOT_LABEL, NULL FROM DIM_HIERARCHY;

-- Product: one parent level, then product.
INSERT INTO DIM_HIERARCHY_NODE
SELECT DISTINCT h.ID, h.ID || '/' || h.L1, h.ID, 1, h.L1, NULL
FROM (
  SELECT 'PRODUCT_CATEGORY' AS ID, c.CATEGORY_NAME AS L1 FROM DIM_PRODUCT b JOIN DIM_CATEGORY c ON c.CATEGORY_ID = b.CATEGORY_ID
  UNION ALL SELECT 'PRODUCT_FAMILY', PRODUCT_LINE FROM DIM_PRODUCT
  UNION ALL SELECT 'PRODUCT_TIER', PRICE_TIER FROM DIM_PRODUCT
) h;

INSERT INTO DIM_HIERARCHY_NODE
SELECT h.ID, h.ID || '/' || h.L1 || '/' || h.PRODUCT_NAME, h.ID || '/' || h.L1, 2, h.PRODUCT_NAME, h.PRODUCT_ID
FROM (
  SELECT 'PRODUCT_CATEGORY' AS ID, c.CATEGORY_NAME AS L1, b.PRODUCT_NAME, b.PRODUCT_ID FROM DIM_PRODUCT b JOIN DIM_CATEGORY c ON c.CATEGORY_ID = b.CATEGORY_ID
  UNION ALL SELECT 'PRODUCT_FAMILY', PRODUCT_LINE, PRODUCT_NAME, PRODUCT_ID FROM DIM_PRODUCT
  UNION ALL SELECT 'PRODUCT_TIER', PRICE_TIER, PRODUCT_NAME, PRODUCT_ID FROM DIM_PRODUCT
) h;

-- Customer: flat list, by region, and by route → delivery mode.
INSERT INTO DIM_HIERARCHY_NODE
SELECT 'CUSTOMER_LIST', 'CUSTOMER_LIST/' || CUSTOMER_NAME, 'CUSTOMER_LIST', 1, CUSTOMER_NAME, CUSTOMER_ID FROM DIM_CUSTOMER;

INSERT INTO DIM_HIERARCHY_NODE
SELECT DISTINCT 'CUSTOMER_REGION', 'CUSTOMER_REGION/' || REGION, 'CUSTOMER_REGION', 1, REGION, NULL FROM DIM_CUSTOMER;
INSERT INTO DIM_HIERARCHY_NODE
SELECT 'CUSTOMER_REGION', 'CUSTOMER_REGION/' || REGION || '/' || CUSTOMER_NAME, 'CUSTOMER_REGION/' || REGION, 2, CUSTOMER_NAME, CUSTOMER_ID FROM DIM_CUSTOMER;

INSERT INTO DIM_HIERARCHY_NODE
WITH m AS (
  SELECT CUSTOMER_ID, CUSTOMER_NAME,
         IFF(IS_AFTERMARKET, 'Aftermarket', 'OEM') AS ROUTE,
         CASE DELIVERY_MODE WHEN 'JIS' THEN 'Just-in-sequence'
                            WHEN 'JIT' THEN 'Just-in-time'
                            ELSE 'Warehouse stock' END AS HEMI
  FROM DIM_CUSTOMER
)
SELECT DISTINCT 'CUSTOMER_ROUTE', 'CUSTOMER_ROUTE/' || ROUTE, 'CUSTOMER_ROUTE', 1, ROUTE, NULL FROM m
UNION ALL
SELECT DISTINCT 'CUSTOMER_ROUTE', 'CUSTOMER_ROUTE/' || ROUTE || '/' || HEMI, 'CUSTOMER_ROUTE/' || ROUTE, 2, HEMI, NULL FROM m
UNION ALL
SELECT 'CUSTOMER_ROUTE', 'CUSTOMER_ROUTE/' || ROUTE || '/' || HEMI || '/' || CUSTOMER_NAME, 'CUSTOMER_ROUTE/' || ROUTE || '/' || HEMI, 3, CUSTOMER_NAME, CUSTOMER_ID FROM m;

-- Channel: flat list and by channel group.
INSERT INTO DIM_HIERARCHY_NODE
SELECT 'CHANNEL_LIST', 'CHANNEL_LIST/' || CHANNEL_NAME, 'CHANNEL_LIST', 1, CHANNEL_NAME, CHANNEL_ID FROM DIM_CHANNEL
UNION ALL
SELECT DISTINCT 'CHANNEL_GROUP', 'CHANNEL_GROUP/' || CHANNEL_GROUP, 'CHANNEL_GROUP', 1, CHANNEL_GROUP, NULL FROM DIM_CHANNEL
UNION ALL
SELECT 'CHANNEL_GROUP', 'CHANNEL_GROUP/' || CHANNEL_GROUP || '/' || CHANNEL_NAME, 'CHANNEL_GROUP/' || CHANNEL_GROUP, 2, CHANNEL_NAME, CHANNEL_ID FROM DIM_CHANNEL;

-- Time: fiscal year → quarter → period → week, and calendar year → month → week.
INSERT INTO DIM_HIERARCHY_NODE
WITH w AS (
  SELECT WEEK_ID,
         'FY' || RIGHT(FISCAL_YEAR::VARCHAR, 2)                         AS FY,
         'FY' || RIGHT(FISCAL_YEAR::VARCHAR, 2) || ' ' || FISCAL_QUARTER AS FQ,
         'FY' || RIGHT(FISCAL_YEAR::VARCHAR, 2) || ' P' || LPAD(FISCAL_PERIOD::VARCHAR, 2, '0') AS FP,
         -- Year and month of the week's Monday: ISO year would put 2026-W01
         -- (starting 29 December 2025) in "2026-12".
         TO_CHAR(WEEK_START_DATE, 'YYYY')    AS CY,
         TO_CHAR(WEEK_START_DATE, 'YYYY-MM') AS CM
  FROM DIM_WEEK
)
SELECT DISTINCT 'TIME_FISCAL', 'TIME_FISCAL/' || FY, 'TIME_FISCAL', 1, FY, NULL FROM w
UNION ALL SELECT DISTINCT 'TIME_FISCAL', 'TIME_FISCAL/' || FQ, 'TIME_FISCAL/' || FY, 2, FQ, NULL FROM w
UNION ALL SELECT DISTINCT 'TIME_FISCAL', 'TIME_FISCAL/' || FP, 'TIME_FISCAL/' || FQ, 3, FP, NULL FROM w
UNION ALL SELECT 'TIME_FISCAL', 'TIME_FISCAL/' || FP || '/' || WEEK_ID, 'TIME_FISCAL/' || FP, 4, WEEK_ID, WEEK_ID FROM w
UNION ALL SELECT DISTINCT 'TIME_CALENDAR', 'TIME_CALENDAR/' || CY, 'TIME_CALENDAR', 1, CY, NULL FROM w
UNION ALL SELECT DISTINCT 'TIME_CALENDAR', 'TIME_CALENDAR/' || CM, 'TIME_CALENDAR/' || CY, 2, CM, NULL FROM w
UNION ALL SELECT 'TIME_CALENDAR', 'TIME_CALENDAR/' || CM || '/' || WEEK_ID, 'TIME_CALENDAR/' || CM, 3, WEEK_ID, WEEK_ID FROM w;

-- ---------------------------------------------------------------------
-- What the app reads.
-- ---------------------------------------------------------------------
USE SCHEMA APP;

CREATE OR REPLACE VIEW V_HIERARCHY AS
SELECT h.HIERARCHY_ID, h.DIMENSION, h.HIERARCHY_NAME, h.DESCRIPTION, h.IS_DEFAULT,
       h.SORT_ORDER, h.ROOT_LABEL,
       l.LEVEL_NO, l.LEVEL_COLUMN, l.LEVEL_LABEL, l.ALL_LABEL, l.IS_LEAF,
       (SELECT COUNT(*) FROM CORE.DIM_HIERARCHY_NODE n
         WHERE n.HIERARCHY_ID = h.HIERARCHY_ID AND n.LEVEL_NO = l.LEVEL_NO) AS NODE_COUNT
FROM CORE.DIM_HIERARCHY h
JOIN CORE.DIM_HIERARCHY_LEVEL l ON l.HIERARCHY_ID = h.HIERARCHY_ID;

-- Every series against its leaf in every product, customer and channel tree.
CREATE OR REPLACE VIEW V_SERIES_NODE AS
SELECT s.SERIES_ID, n.HIERARCHY_ID, n.NODE_ID AS LEAF_NODE_ID, n.PARENT_NODE_ID
FROM APP.V_SERIES s
JOIN CORE.DIM_HIERARCHY h ON h.DIMENSION IN ('PRODUCT', 'CUSTOMER', 'CHANNEL')
JOIN CORE.DIM_HIERARCHY_NODE n
  ON n.HIERARCHY_ID = h.HIERARCHY_ID
 AND n.MEMBER_ID = CASE h.DIMENSION WHEN 'PRODUCT' THEN s.PRODUCT_ID
                                    WHEN 'CUSTOMER'  THEN s.CUSTOMER_ID
                                    ELSE s.CHANNEL_ID END;

-- ---------------------------------------------------------------------
-- Integrity: every check reads 0 when the trees are sound.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_HIERARCHIES AS
-- Exactly one root per tree.
SELECT 'hier_single_root' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM (SELECT h.HIERARCHY_ID, COUNT(n.NODE_ID) AS ROOTS
      FROM CORE.DIM_HIERARCHY h
      LEFT JOIN CORE.DIM_HIERARCHY_NODE n ON n.HIERARCHY_ID = h.HIERARCHY_ID AND n.PARENT_NODE_ID IS NULL
      GROUP BY 1)
WHERE ROOTS <> 1
UNION ALL
-- Every parent exists one level up. Parents strictly one level up rules out cycles.
SELECT 'hier_parent_step', COUNT(*)
FROM CORE.DIM_HIERARCHY_NODE c
LEFT JOIN CORE.DIM_HIERARCHY_NODE p
  ON p.HIERARCHY_ID = c.HIERARCHY_ID AND p.NODE_ID = c.PARENT_NODE_ID
WHERE c.PARENT_NODE_ID IS NOT NULL AND (p.NODE_ID IS NULL OR p.LEVEL_NO <> c.LEVEL_NO - 1)
UNION ALL
-- Leaves are exactly the nodes at the leaf level, and only they carry a member.
SELECT 'hier_leaf_level', COUNT(*)
FROM CORE.DIM_HIERARCHY_NODE n
JOIN CORE.DIM_HIERARCHY_LEVEL l ON l.HIERARCHY_ID = n.HIERARCHY_ID AND l.IS_LEAF
WHERE (n.LEVEL_NO = l.LEVEL_NO) <> (n.MEMBER_ID IS NOT NULL)
UNION ALL
-- Every member of the dimension sits under exactly one leaf of every tree.
SELECT 'hier_member_coverage', COUNT(*)
FROM (
  SELECT h.HIERARCHY_ID, d.MEMBER_ID, COUNT(n.NODE_ID) AS LEAVES
  FROM CORE.DIM_HIERARCHY h
  JOIN (SELECT 'PRODUCT' AS DIMENSION, PRODUCT_ID AS MEMBER_ID FROM CORE.DIM_PRODUCT
        UNION ALL SELECT 'CUSTOMER', CUSTOMER_ID FROM CORE.DIM_CUSTOMER
        UNION ALL SELECT 'CHANNEL', CHANNEL_ID FROM CORE.DIM_CHANNEL
        UNION ALL SELECT 'TIME', WEEK_ID FROM CORE.DIM_WEEK) d ON d.DIMENSION = h.DIMENSION
  LEFT JOIN CORE.DIM_HIERARCHY_NODE n ON n.HIERARCHY_ID = h.HIERARCHY_ID AND n.MEMBER_ID = d.MEMBER_ID
  GROUP BY 1, 2
)
WHERE LEAVES <> 1
UNION ALL
-- One default tree per dimension.
SELECT 'hier_one_default', COUNT(*)
FROM (SELECT DIMENSION, COUNT_IF(IS_DEFAULT) AS N FROM CORE.DIM_HIERARCHY GROUP BY 1)
WHERE N <> 1
UNION ALL
-- Level columns exist where the app reads them: V_SERIES for product, customer
-- and channel; DIM_WEEK for time.
SELECT 'hier_level_column', COUNT(*)
FROM CORE.DIM_HIERARCHY_LEVEL l
JOIN CORE.DIM_HIERARCHY h ON h.HIERARCHY_ID = l.HIERARCHY_ID
LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
  ON c.TABLE_SCHEMA = IFF(h.DIMENSION = 'TIME', 'CORE', 'APP')
 AND c.TABLE_NAME   = IFF(h.DIMENSION = 'TIME', 'DIM_WEEK', 'V_SERIES')
 AND c.COLUMN_NAME  = l.LEVEL_COLUMN
WHERE c.COLUMN_NAME IS NULL
UNION ALL
-- Every product, customer and channel tree rolls the plan up to the same total.
SELECT 'hier_rollup_total', COUNT(*)
FROM (
  SELECT sn.HIERARCHY_ID, SUM(d.PLAN_UNITS) AS TREE_TOTAL
  FROM APP.V_SERIES_NODE sn
  JOIN CORE.FACT_DEMAND_PLAN d ON d.SERIES_ID = sn.SERIES_ID
  GROUP BY 1
) t
CROSS JOIN (SELECT SUM(PLAN_UNITS) AS PLAN_TOTAL FROM CORE.FACT_DEMAND_PLAN) p
WHERE ABS(t.TREE_TOTAL - p.PLAN_TOTAL) > 0.01;

-- NOTE: 21-supply-integrity.sql redefines this view to add supply checks.
-- If you re-run this file, re-run 21 afterwards or supply drops out.
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
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_CYCLES
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_APPROVALS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_FORMULAS
UNION ALL
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_HIERARCHIES;
