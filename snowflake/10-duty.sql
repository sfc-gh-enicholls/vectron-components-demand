-- =====================================================================
-- Vectron Components — Demand Planning
-- 10: Delivered-cost and tariff lens — ex-works to the OEM's line
-- =====================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Everything upstream reasons about Vectron's ex-works part price. What the
-- customer actually pays to get a part to its line, or onto a garage shelf,
-- adds logistics, a material surcharge, any cross-border tariff and, in the
-- aftermarket, distributor margin and VAT. That matters to demand planning
-- in two ways:
--   * A tariff is a DEMAND event. US Section 232 duties on vehicles and
--     parts hit Ford's Mexican flows into the US; an OEM that pays more for
--     a part, or sells fewer cars into a tariffed market, calls off less.
--   * Pass-through is non-linear. The same tariff rate moves delivered cost
--     far more on a heavy, cheap part (a brake disc) than on a mechatronic
--     unit, where ex-works value dominates.
--
-- COLUMN NAMES ARE INHERITED, MEANINGS ARE NOT
-- --------------------------------------------
-- The value page, the measures library and the tariff scenarios read the
-- column names below. They are kept so those keep working; what each one
-- MEANS for Vectron is defined here and nowhere else:
--   FREIGHT_EUR_PER_CASE   logistics per piece: weight-based freight plus a
--                          sequencing fee for just-in-sequence customers
--   IMPORT_TARIFF_PCT      cross-border tariff on CIF. Zero intra-EU and on
--                          USMCA-compliant flows today; the scenario moves it
--   LPA_PER_CASE           kilograms per piece (the surcharge base)
--   EXCISE_EUR_PER_LPA     raw-material surcharge, EUR per kg, by category
--   AD_VALOREM_PCT         customs brokerage and compliance on duty-paid cost
--   TRADE_MARGIN_PCT       distributor margin. Aftermarket only: OEMs buy
--                          direct
--   VAT_PCT                VAT on the garage price. Aftermarket only: an OEM
--                          recovers VAT, so it is not a cost to it
--   SHELF_EUR_CASE         delivered cost per piece (to the line, or to the
--                          garage for aftermarket)
--   SHELF_EUR_BOTTLE       the same, per piece (one piece per unit)
-- Every rate is ILLUSTRATIVE, not a statement of any tariff schedule or
-- contract.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

CREATE OR REPLACE TABLE DIM_DUTY AS
SELECT
  m.CUSTOMER_ID,
  c.CATEGORY_ID,
  IFF(m.IS_AFTERMARKET, 'aftermarket', 'oem')            AS DUTY_BASIS,
  -- Material surcharge, EUR per kg: aluminium-heavy chassis and copper- and
  -- aluminium-heavy e-drive carry most.
  CASE c.CATEGORY_ID
    WHEN 'CAT-BRAKE'   THEN 0.35
    WHEN 'CAT-CHASSIS' THEN 0.45
    WHEN 'CAT-STEER'   THEN 0.30
    WHEN 'CAT-PT'      THEN 0.40
    WHEN 'CAT-EDRIVE'  THEN 0.60
    ELSE 0.40
  END                                                    AS EXCISE_EUR_PER_LPA,
  CASE WHEN m.CUSTOMER_ID = 'OEM-FORD' THEN 0.015
       WHEN m.IS_AFTERMARKET          THEN 0.010
       ELSE 0.000 END                                    AS AD_VALOREM_PCT,
  -- Baseline: intra-EU and USMCA-compliant flows enter at zero. The
  -- aftermarket average reflects a small share of exports outside the EU.
  CASE WHEN m.IS_AFTERMARKET THEN 0.030 ELSE 0.000 END   AS IMPORT_TARIFF_PCT,
  -- Freight per piece is weight-driven (applied in the view); this is the
  -- fixed sequencing and handling fee per piece.
  CASE m.DELIVERY_MODE WHEN 'JIS' THEN 1.80 WHEN 'JIT' THEN 0.90 ELSE 0.60 END
                                                         AS FREIGHT_EUR_PER_CASE,
  -- EUR per kg of freight, by lane.
  CASE m.REGION
    WHEN 'Germany'  THEN 0.10
    WHEN 'Europe'   THEN 0.16
    WHEN 'Americas' THEN 0.34
    ELSE 0.22
  END                                                    AS FREIGHT_EUR_PER_KG,
  IFF(m.IS_AFTERMARKET, 0.350, 0.000)                    AS TRADE_MARGIN_PCT,
  IFF(m.IS_AFTERMARKET, 0.190, 0.000)                    AS VAT_PCT
FROM DIM_CUSTOMER m
CROSS JOIN DIM_CATEGORY c;

-- =====================================================================
-- APP views
-- =====================================================================
USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- V_LANDED_COST — ex-works to delivered, per series. Tariff on CIF; the
-- surcharge is per kg; brokerage on duty-paid; margin and VAT on top, in
-- that order, so the build-up reconstructs delivered cost exactly.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_LANDED_COST AS
WITH b AS (
  SELECT
    s.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.PRODUCT_LINE,
    s.CATEGORY_NAME, s.CATEGORY_ID, s.CUSTOMER_NAME, s.CUSTOMER_ID,
    s.CHANNEL_NAME, s.PRICE_TIER, s.REGION, s.IS_AFTERMARKET,
    s.UNIT_PRICE_EUR,
    br.PART_WEIGHT_KG,
    br.PART_WEIGHT_KG                                    AS LPA_PER_CASE,
    d.EXCISE_EUR_PER_LPA, d.AD_VALOREM_PCT, d.IMPORT_TARIFF_PCT,
    d.FREIGHT_EUR_PER_CASE + br.PART_WEIGHT_KG * d.FREIGHT_EUR_PER_KG
                                                         AS FREIGHT_EUR_PER_CASE,
    d.TRADE_MARGIN_PCT, d.VAT_PCT, d.DUTY_BASIS
  FROM V_SERIES s
  JOIN CORE.DIM_PRODUCT br ON br.PRODUCT_ID = s.PRODUCT_ID
  JOIN CORE.DIM_DUTY d
    ON d.CUSTOMER_ID = s.CUSTOMER_ID AND d.CATEGORY_ID = s.CATEGORY_ID
),
built AS (
  SELECT
    b.*,
    b.UNIT_PRICE_EUR + b.FREIGHT_EUR_PER_CASE                        AS CIF_EUR_CASE,
    (b.UNIT_PRICE_EUR + b.FREIGHT_EUR_PER_CASE) * b.IMPORT_TARIFF_PCT AS TARIFF_EUR_CASE,
    b.LPA_PER_CASE * b.EXCISE_EUR_PER_LPA                            AS EXCISE_EUR_CASE
  FROM b
),
valorem AS (
  SELECT
    built.*,
    built.CIF_EUR_CASE + built.TARIFF_EUR_CASE + built.EXCISE_EUR_CASE AS DUTY_PAID_EUR_CASE,
    (built.CIF_EUR_CASE + built.TARIFF_EUR_CASE + built.EXCISE_EUR_CASE)
      * built.AD_VALOREM_PCT                                         AS AD_VALOREM_EUR_CASE
  FROM built
),
shelf AS (
  SELECT
    valorem.*,
    valorem.DUTY_PAID_EUR_CASE + valorem.AD_VALOREM_EUR_CASE         AS LANDED_EUR_CASE,
    (valorem.DUTY_PAID_EUR_CASE + valorem.AD_VALOREM_EUR_CASE)
      * valorem.TRADE_MARGIN_PCT                                     AS TRADE_MARGIN_EUR_CASE
  FROM valorem
)
SELECT
  sh.SERIES_ID, sh.SERIES_LABEL, sh.PRODUCT_NAME, sh.PRODUCT_LINE,
  sh.CATEGORY_NAME, sh.CUSTOMER_NAME, sh.CUSTOMER_ID, sh.CHANNEL_NAME,
  sh.PRICE_TIER, sh.REGION, sh.IS_AFTERMARKET, sh.DUTY_BASIS,
  sh.PART_WEIGHT_KG, sh.LPA_PER_CASE,
  sh.UNIT_PRICE_EUR, sh.FREIGHT_EUR_PER_CASE, sh.CIF_EUR_CASE,
  sh.IMPORT_TARIFF_PCT, sh.TARIFF_EUR_CASE,
  sh.EXCISE_EUR_PER_LPA, sh.EXCISE_EUR_CASE,
  sh.AD_VALOREM_PCT, sh.AD_VALOREM_EUR_CASE,
  -- Duty-paid cost before brokerage, margin and VAT. Every layer above it is
  -- multiplicative, so delivered cost moves by exactly delta_duty_paid /
  -- duty_paid: the tariff scenarios derive their impact from this column.
  sh.DUTY_PAID_EUR_CASE,
  sh.LANDED_EUR_CASE,
  sh.TRADE_MARGIN_PCT, sh.TRADE_MARGIN_EUR_CASE,
  sh.VAT_PCT,
  sh.LANDED_EUR_CASE + sh.TRADE_MARGIN_EUR_CASE                      AS PRE_TAX_SHELF_EUR_CASE,
  (sh.LANDED_EUR_CASE + sh.TRADE_MARGIN_EUR_CASE) * sh.VAT_PCT       AS VAT_EUR_CASE,
  (sh.LANDED_EUR_CASE + sh.TRADE_MARGIN_EUR_CASE) * (1 + sh.VAT_PCT) AS SHELF_EUR_CASE,
  (sh.LANDED_EUR_CASE + sh.TRADE_MARGIN_EUR_CASE) * (1 + sh.VAT_PCT) AS SHELF_EUR_BOTTLE,
  -- Share of delivered cost that is not Vectron's ex-works price: logistics,
  -- surcharge, tariff, brokerage, margin, VAT.
  1 - sh.UNIT_PRICE_EUR
      / NULLIF((sh.LANDED_EUR_CASE + sh.TRADE_MARGIN_EUR_CASE) * (1 + sh.VAT_PCT), 0)
                                                                     AS TAX_SHARE_OF_SHELF,
  sh.UNIT_PRICE_EUR
    / NULLIF((sh.LANDED_EUR_CASE + sh.TRADE_MARGIN_EUR_CASE) * (1 + sh.VAT_PCT), 0)
                                                                     AS EXW_SHARE_OF_SHELF
FROM shelf sh;

-- ---------------------------------------------------------------------
-- V_DUTY_EXPOSURE — what is at risk, by customer and category, weighted by
-- the forward plan (exposure is a forward question).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_DUTY_EXPOSURE AS
WITH plan AS (
  SELECT d.SERIES_ID, SUM(d.PLAN_UNITS) AS PLAN_UNITS
  FROM CORE.FACT_DEMAND_PLAN d
  GROUP BY 1
)
SELECT
  lc.CUSTOMER_ID, lc.CUSTOMER_NAME, lc.REGION, lc.CATEGORY_NAME, lc.IS_AFTERMARKET,
  SUM(COALESCE(p.PLAN_UNITS, 0))                              AS PLAN_UNITS,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.UNIT_PRICE_EUR)          AS PLAN_EXW_EUR,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.SHELF_EUR_CASE)          AS PLAN_SHELF_EUR,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.TARIFF_EUR_CASE)         AS PLAN_TARIFF_EUR,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.EXCISE_EUR_CASE)         AS PLAN_EXCISE_EUR,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.IMPORT_TARIFF_PCT)
    / NULLIF(SUM(COALESCE(p.PLAN_UNITS, 0)), 0)               AS AVG_TARIFF_PCT,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.TAX_SHARE_OF_SHELF)
    / NULLIF(SUM(COALESCE(p.PLAN_UNITS, 0)), 0)               AS AVG_TAX_SHARE,
  SUM(COALESCE(p.PLAN_UNITS, 0) * lc.EXW_SHARE_OF_SHELF)
    / NULLIF(SUM(COALESCE(p.PLAN_UNITS, 0)), 0)               AS AVG_EXW_SHARE
FROM V_LANDED_COST lc
LEFT JOIN plan p ON p.SERIES_ID = lc.SERIES_ID
GROUP BY 1, 2, 3, 4, 5;

-- ---------------------------------------------------------------------
-- V_INTEGRITY_DUTY
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_INTEGRITY_DUTY AS
SELECT 'landed_cost_buildup' AS CHECK_NAME, COUNT(*) AS VIOLATIONS
FROM V_LANDED_COST
WHERE ABS((UNIT_PRICE_EUR + FREIGHT_EUR_PER_CASE + TARIFF_EUR_CASE
           + EXCISE_EUR_CASE + AD_VALOREM_EUR_CASE + TRADE_MARGIN_EUR_CASE
           + VAT_EUR_CASE) - SHELF_EUR_CASE) > 0.01
UNION ALL
SELECT 'delivered_above_exw', COUNT(*)
FROM V_LANDED_COST
WHERE SHELF_EUR_CASE < UNIT_PRICE_EUR
UNION ALL
SELECT 'duty_coverage', COUNT(*)
FROM V_SERIES s
LEFT JOIN CORE.DIM_DUTY d
  ON d.CUSTOMER_ID = s.CUSTOMER_ID AND d.CATEGORY_ID = s.CATEGORY_ID
WHERE d.CUSTOMER_ID IS NULL
UNION ALL
-- OEMs buy direct and recover VAT: margin or VAT on an OEM row is an error.
SELECT 'oem_no_margin_or_vat', COUNT(*)
FROM V_LANDED_COST
WHERE NOT IS_AFTERMARKET
  AND (TRADE_MARGIN_EUR_CASE > 0.001 OR VAT_EUR_CASE > 0.001)
UNION ALL
SELECT 'duty_rates_non_negative', COUNT(*)
FROM CORE.DIM_DUTY
WHERE EXCISE_EUR_PER_LPA < 0 OR AD_VALOREM_PCT < 0 OR IMPORT_TARIFF_PCT < 0
   OR FREIGHT_EUR_PER_CASE < 0 OR FREIGHT_EUR_PER_KG < 0
   OR TRADE_MARGIN_PCT < 0 OR VAT_PCT < 0;

-- V_INTEGRITY_ALL — MATURATION is replaced in stage 7; until then it is
-- left out so the composite stays valid.
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
SELECT CHECK_NAME, VIOLATIONS FROM V_INTEGRITY_DUTY;
