-- =====================================================================
-- Vectron Components — Demand Planning
-- 08: Constrained components — yearly supplier allocations
-- =====================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- A Tier 1's binding long-lead constraint is rarely its own plant. It is a
-- handful of bought components on allocation: microcontrollers for every
-- mechatronic unit, silicon-carbide power modules for 800V e-axles, and
-- rare-earth magnets for e-motor rotors. Suppliers commit a YEARLY
-- allocation months ahead; a demand plan that grows past it cannot ship,
-- however much line capacity there is. Since 2021 this is the question every
-- Tier 1 S&OP asks first.
--
-- HOW IT FEEDS SUPPLY
-- -------------------
-- The constrained solve (scripts/supply_solve.py) caps each part family by a
-- FILL RATIO per calendar year: the share of the year's requirement that the
-- allocation covers. The solve and the supply page read that through an
-- interface first built for another constraint, so the names are inherited:
--   CORE.DIM_LIQUID_FAMILY    -> one row per constrained COMPONENT FAMILY
--   CORE.DIM_PRODUCT_AGE      -> which part families draw on which family
--                                (MIN_AGE_YEARS = 0; AGE_STATEMENT holds the
--                                pieces of component per part)
--   APP.V_LIQUID_FILL_RATIO   -> allocation / requirement, capped at 1
-- Part families that draw on no constrained family have no row and are not
-- capped.
--
-- The requirement is DRIVEN FROM THE PLAN (FACT_DEMAND_PLAN for forward
-- weeks, shipments for history), so an approved upside moves the fill ratio
-- the next time the view is read. Allocations are ILLUSTRATIVE.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

CREATE OR REPLACE TABLE DIM_LIQUID_FAMILY (
  LIQUID_FAMILY            VARCHAR(30)  PRIMARY KEY,
  FAMILY_LABEL             VARCHAR(80)  NOT NULL,
  CATEGORY_NAME            VARCHAR(60)  NOT NULL,   -- supplier base, for display
  ANGELS_SHARE_PCT         NUMBER(6,4)  NOT NULL,   -- yield loss at Vectron
  NEWMAKE_COST_EUR_PER_LPA NUMBER(10,2) NOT NULL,   -- unit cost of the component
  ANNUAL_CARRY_EUR_PER_LPA NUMBER(10,2) NOT NULL,   -- spot premium per piece if short
  SUBSTITUTION_NOTE        VARCHAR(300)
);
INSERT INTO DIM_LIQUID_FAMILY VALUES
  ('MCU',    'Automotive microcontrollers', 'Semiconductors (Tier 2)', 0.010, 6.50, 38.00,
   'Qualified per ECU design: a different MCU means a re-validation, so no substitution inside the year.'),
  ('SIC',    'SiC power modules (800V)',    'Power semiconductors (Tier 2)', 0.020, 310.00, 420.00,
   'Single-sourced on the gen-2 e-axle. 400V e-axles use silicon IGBTs and do not draw on this pool.'),
  ('NDFEB',  'NdFeB rotor magnets',         'Rare-earth magnets (Tier 3)', 0.015, 42.00, 55.00,
   'Rare-earth supply is concentrated; grain-boundary-diffused grades reduce dysprosium but are qualified per motor.');

-- Pieces of each component per part. AGE_STATEMENT carries the count as text
-- for display; COMPONENT_QTY carries it as a number.
CREATE OR REPLACE TABLE DIM_PRODUCT_AGE (
  PRODUCT_ID     VARCHAR(20) NOT NULL,
  LIQUID_FAMILY  VARCHAR(30) NOT NULL,
  AGE_STATEMENT  VARCHAR(20) NOT NULL,
  MIN_AGE_YEARS  NUMBER(3,0) NOT NULL,
  AGE_BASIS      VARCHAR(200),
  COMPONENT_QTY  NUMBER(6,2) NOT NULL,
  PRIMARY KEY (PRODUCT_ID, LIQUID_FAMILY)
);
INSERT INTO DIM_PRODUCT_AGE
SELECT PRODUCT_ID, 'MCU', '2 per part', 0, 'Main and safety MCU (ASIL D lockstep pair).', 2
FROM DIM_PRODUCT WHERE PRICE_TIER = 'Mechatronic' AND PRODUCT_ID NOT IN ('P-EAX2', 'P-EAXLE')
UNION ALL
SELECT PRODUCT_ID, 'MCU', '1 per part', 0, 'Inverter controller.', 1
FROM DIM_PRODUCT WHERE PRODUCT_ID IN ('P-EAX2', 'P-EAXLE')
UNION ALL
SELECT 'P-EAX2', 'SIC', '1 per part', 0, 'One six-pack SiC module per 800V inverter.', 1
UNION ALL
SELECT PRODUCT_ID, 'NDFEB', '1 set per part', 0, 'One rotor magnet set per e-motor.', 1
FROM DIM_PRODUCT WHERE PRODUCT_ID IN ('P-EAX2', 'P-EAXLE', 'P-ROTOR');

-- Yearly allocation per component family. Set against the 2025 requirement
-- with a growth assumption agreed with each supplier; 2027 is where the plan
-- overtakes it. ILLUSTRATIVE.
CREATE OR REPLACE TABLE COMPONENT_ALLOCATION (
  LIQUID_FAMILY       VARCHAR(30) NOT NULL,
  CALENDAR_YEAR       NUMBER(4,0) NOT NULL,
  -- Either relative to the 2025 weekly requirement, or an absolute weekly
  -- allocation for a family with no 2025 history (SiC: the gen-2 e-axle
  -- launched in 2026).
  ALLOCATION_VS_2025  NUMBER(6,3),
  ALLOCATION_PER_WEEK NUMBER(12,0),
  PRIMARY KEY (LIQUID_FAMILY, CALENDAR_YEAR)
);
INSERT INTO COMPONENT_ALLOCATION VALUES
  ('MCU',   2025, 1.08, NULL), ('MCU',   2026, 1.10, NULL), ('MCU',   2027, 1.06, NULL),
  ('SIC',   2025, NULL,    0), ('SIC',   2026, NULL, 2000), ('SIC',   2027, NULL, 2400),
  ('NDFEB', 2025, 1.05, NULL), ('NDFEB', 2026, 1.12, NULL), ('NDFEB', 2027, 1.10, NULL);

USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_COMPONENT_BALANCE — requirement against allocation, per family and year,
-- as WEEKLY RUN-RATES. Weekly, because the plan horizon ends part-way through
-- 2027: a yearly total would understate that year and flatter the balance.
-- Requirement = pieces of part x component per part / (1 - yield loss).
-- History weeks use shipments; forward weeks use the committed plan.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_COMPONENT_BALANCE AS
WITH vol AS (
  SELECT s.PRODUCT_ID, w.ISO_YEAR AS CALENDAR_YEAR, w.WEEK_ID,
         SUM(COALESCE(sh.UNITS, d.PLAN_UNITS)) AS UNITS
  FROM CORE.DIM_SERIES s
  JOIN CORE.DIM_WEEK w ON TRUE
  LEFT JOIN CORE.FACT_SHIPMENTS_WEEKLY sh ON sh.SERIES_ID = s.SERIES_ID AND sh.WEEK_ID = w.WEEK_ID
  LEFT JOIN CORE.FACT_DEMAND_PLAN d
         ON d.SERIES_ID = s.SERIES_ID AND d.WEEK_ID = w.WEEK_ID
        AND w.WEEK_ID > (SELECT HISTORY_END_WEEK FROM V_CONTEXT)
  WHERE w.ISO_YEAR BETWEEN 2025 AND 2027
  GROUP BY 1, 2, 3
  HAVING SUM(COALESCE(sh.UNITS, d.PLAN_UNITS)) IS NOT NULL
),
weeks AS (SELECT CALENDAR_YEAR, COUNT(DISTINCT WEEK_ID) AS N_WEEKS FROM vol GROUP BY 1),
req AS (
  SELECT pa.LIQUID_FAMILY, v.CALENDAR_YEAR,
         SUM(v.UNITS * pa.COMPONENT_QTY) / (1 - MAX(f.ANGELS_SHARE_PCT)) / MAX(wk.N_WEEKS) AS REQUIRED
  FROM vol v
  JOIN weeks wk ON wk.CALENDAR_YEAR = v.CALENDAR_YEAR
  JOIN CORE.DIM_PRODUCT_AGE pa ON pa.PRODUCT_ID = v.PRODUCT_ID
  JOIN CORE.DIM_LIQUID_FAMILY f ON f.LIQUID_FAMILY = pa.LIQUID_FAMILY
  GROUP BY 1, 2
),
base AS (SELECT LIQUID_FAMILY, REQUIRED AS REQUIRED_2025 FROM req WHERE CALENDAR_YEAR = 2025),
alloc AS (
  SELECT r.LIQUID_FAMILY, r.CALENDAR_YEAR, r.REQUIRED,
         COALESCE(a.ALLOCATION_PER_WEEK, b.REQUIRED_2025 * a.ALLOCATION_VS_2025, 0) AS ALLOCATED
  FROM req r
  LEFT JOIN base b ON b.LIQUID_FAMILY = r.LIQUID_FAMILY
  JOIN CORE.COMPONENT_ALLOCATION a
    ON a.LIQUID_FAMILY = r.LIQUID_FAMILY AND a.CALENDAR_YEAR = r.CALENDAR_YEAR
)
SELECT r.LIQUID_FAMILY, f.FAMILY_LABEL, r.CALENDAR_YEAR,
       r.REQUIRED                AS REQUIRED_PIECES_WEEK,
       r.ALLOCATED               AS ALLOCATED_PIECES_WEEK,
       r.ALLOCATED - r.REQUIRED  AS HEADROOM_PIECES_WEEK,
       IFF(r.REQUIRED > 0, LEAST(1, r.ALLOCATED / r.REQUIRED), 1) AS FILL_RATIO,
       TRUE AS IS_ILLUSTRATIVE
FROM alloc r
JOIN CORE.DIM_LIQUID_FAMILY f ON f.LIQUID_FAMILY = r.LIQUID_FAMILY;

-- The interface the supply solve reads. A part drawing on several families
-- is capped by the tightest one, so this keeps the minimum per part-year.
CREATE OR REPLACE VIEW V_LIQUID_FILL_RATIO AS
SELECT pa.PRODUCT_ID, cb.LIQUID_FAMILY, cb.CALENDAR_YEAR, pa.MIN_AGE_YEARS, cb.FILL_RATIO
FROM CORE.DIM_PRODUCT_AGE pa
JOIN V_COMPONENT_BALANCE cb ON cb.LIQUID_FAMILY = pa.LIQUID_FAMILY
QUALIFY ROW_NUMBER() OVER (PARTITION BY pa.PRODUCT_ID, cb.CALENDAR_YEAR ORDER BY cb.FILL_RATIO, cb.LIQUID_FAMILY) = 1;

CREATE OR REPLACE VIEW V_INTEGRITY_ALLOCATION AS
SELECT 'alloc_fill_ratio_range' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM V_COMPONENT_BALANCE WHERE FILL_RATIO < 0 OR FILL_RATIO > 1
UNION ALL
SELECT 'alloc_family_has_parts', COUNT(*)
FROM CORE.DIM_LIQUID_FAMILY f
WHERE NOT EXISTS (SELECT 1 FROM CORE.DIM_PRODUCT_AGE p WHERE p.LIQUID_FAMILY = f.LIQUID_FAMILY)
UNION ALL
SELECT 'alloc_years_complete', COUNT(*)
FROM CORE.DIM_LIQUID_FAMILY f
CROSS JOIN (SELECT 2025 AS Y UNION ALL SELECT 2026 UNION ALL SELECT 2027) y
WHERE NOT EXISTS (SELECT 1 FROM CORE.COMPONENT_ALLOCATION a
                  WHERE a.LIQUID_FAMILY = f.LIQUID_FAMILY AND a.CALENDAR_YEAR = y.Y);
