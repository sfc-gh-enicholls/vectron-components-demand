-- =====================================================================
-- Vectron Components — Demand Planning
-- 05: Scenarios and the proposing agent
-- =====================================================================
--
-- This file is deliberately SEPARATE from 03-series-and-facts.sql. That file
-- uses CREATE OR REPLACE on every fact table, so re-running it wipes the
-- generated data. Scenario and agent state must survive a data rebuild, so it
-- lives here and 03 is never edited to accommodate it.
--
-- DESIGN NOTE — where scenario edits are stored
-- --------------------------------------------
-- Edits are held at SERIES x WEEK grain (the leaf) even when a planner edits a
-- whole category. That makes the effective plan under a scenario a plain LEFT
-- JOIN rather than a recursive rollup, and it means a scenario cannot drift out
-- of agreement with its own children.
--
-- The parent node and disaggregation method are recorded alongside, so
-- provenance survives: a -244k row on Royal Stag can still be traced back to a
-- -5% edit on Indian Whisky spread by statistical share.
--
-- DESIGN NOTE — JSON columns
-- --------------------------
-- DIAGNOSIS and EVIDENCE are VARCHAR holding JSON text, not VARIANT. These
-- tables are populated by COPY INTO from staged CSV, and loading VARIANT that
-- way needs a staging table plus PARSE_JSON. The application parses these two
-- fields; nothing queries inside them in SQL, so VARIANT would buy nothing.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_SCENARIO — a named, versioned branch of the committed plan.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DIM_SCENARIO (
  SCENARIO_ID        VARCHAR(40)  PRIMARY KEY,
  SCENARIO_NAME      VARCHAR(120) NOT NULL,
  DESCRIPTION        VARCHAR(600),
  -- draft: freely editable. promoted: written into FACT_DEMAND_PLAN.
  -- discarded: kept for audit but excluded from the working list.
  STATUS             VARCHAR(20)  NOT NULL DEFAULT 'draft',
  -- The plan vintage this branched from, so a stale scenario is detectable.
  BASE_PLAN_WEEK     VARCHAR(10)  NOT NULL,
  PARENT_SCENARIO_ID VARCHAR(40),
  CREATED_BY         VARCHAR(80)  NOT NULL,
  CREATED_AT         TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  UPDATED_AT         TIMESTAMP_NTZ,
  PROMOTED_AT        TIMESTAMP_NTZ,
  PROMOTED_BY        VARCHAR(80)
);

-- ---------------------------------------------------------------------
-- FACT_SCENARIO_EDIT — the contents of a scenario.
--
-- One row per (scenario, series, week): the LATEST value wins, so editing the
-- same cell twice replaces rather than accumulates. A scenario is a set of
-- overrides on the plan, and this is that set.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_SCENARIO_EDIT (
  SCENARIO_ID     VARCHAR(40)  NOT NULL,
  SERIES_ID       VARCHAR(80)  NOT NULL,
  WEEK_ID         VARCHAR(10)  NOT NULL,
  -- The committed plan value at the moment of the edit, retained so the
  -- scenario still shows what it changed even after the plan moves on.
  BASE_UNITS      NUMBER(14,2) NOT NULL,
  EDIT_UNITS      NUMBER(14,2) NOT NULL,
  DELTA_UNITS     NUMBER(14,2) NOT NULL,
  ORIGIN          VARCHAR(20)  NOT NULL,   -- planner | agent
  SOURCE_PROPOSAL_ID VARCHAR(40),
  REASON_CODE     VARCHAR(30),
  NOTE            VARCHAR(600),
  -- Groups every leaf row produced by one parent-level action.
  EDIT_GROUP_ID   VARCHAR(40)  NOT NULL,
  PARENT_LEVEL    VARCHAR(40),             -- e.g. CATEGORY_NAME
  PARENT_KEY      VARCHAR(120),            -- e.g. Indian Whisky
  DISAGG_METHOD   VARCHAR(30)  NOT NULL,   -- statistical | current_plan | direct
  EDITED_BY       VARCHAR(80)  NOT NULL,
  EDITED_AT       TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (SCENARIO_ID, SERIES_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- FACT_AGENT_RUN — one row per agent execution.
--
-- RUN_TYPE distinguishes 'live' (proposals against the forward plan) from
-- 'backrun' (the engine re-run at a historical origin so the scorecard has
-- outturn to judge). The UI must label backrun content as seeded.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_AGENT_RUN (
  RUN_ID           VARCHAR(40)  PRIMARY KEY,
  RUN_TYPE         VARCHAR(20)  NOT NULL,   -- live | backrun
  AS_OF_WEEK       VARCHAR(10)  NOT NULL,
  TRIGGERED_BY     VARCHAR(80)  NOT NULL,
  STARTED_AT       TIMESTAMP_NTZ NOT NULL,
  COMPLETED_AT     TIMESTAMP_NTZ,
  STATUS           VARCHAR(20)  NOT NULL,   -- running | completed | failed
  PROPOSAL_COUNT   NUMBER(8,0)  NOT NULL DEFAULT 0,
  -- Narrative provenance, so the fallback rate is visible rather than hidden.
  NARRATIVE_MODE   VARCHAR(20)  NOT NULL,   -- cortex | template
  MODEL_NAME       VARCHAR(60),
  CORTEX_CALLS     NUMBER(8,0)  NOT NULL DEFAULT 0,
  CORTEX_FALLBACKS NUMBER(8,0)  NOT NULL DEFAULT 0,
  ERROR            VARCHAR(2000)
);

-- ---------------------------------------------------------------------
-- FACT_AGENT_PROPOSAL — a recommended action.
--
-- CURRENT_UNITS / PROPOSED_UNITS are totals over the week range; the per-week
-- detail lives in FACT_AGENT_PROPOSAL_WEEK because a re-phasing proposal moves
-- volume BETWEEN weeks and a single total would hide that entirely.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_AGENT_PROPOSAL (
  PROPOSAL_ID       VARCHAR(40)  PRIMARY KEY,
  RUN_ID            VARCHAR(40)  NOT NULL,
  AS_OF_WEEK        VARCHAR(10)  NOT NULL,
  PROPOSAL_TYPE     VARCHAR(40)  NOT NULL,
  SERIES_ID         VARCHAR(80),
  NODE_LEVEL        VARCHAR(40),
  NODE_KEY          VARCHAR(120),
  WEEK_FROM         VARCHAR(10)  NOT NULL,
  WEEK_TO           VARCHAR(10)  NOT NULL,
  CURRENT_UNITS     NUMBER(14,2) NOT NULL,
  PROPOSED_UNITS    NUMBER(14,2) NOT NULL,
  DELTA_UNITS       NUMBER(14,2) NOT NULL,
  DELTA_VALUE_EUR   NUMBER(16,2) NOT NULL,
  -- Computed from a documented formula in the engine. NEVER model-generated.
  CONFIDENCE        NUMBER(4,3)  NOT NULL,
  REASON_CODE       VARCHAR(30),
  TRIGGER_SUMMARY   VARCHAR(600) NOT NULL,
  DIAGNOSIS         VARCHAR(4000),          -- JSON: driver contributions
  EVIDENCE          VARCHAR(4000),          -- JSON: citation array
  RATIONALE         VARCHAR(2000),
  RATIONALE_SOURCE  VARCHAR(20)  NOT NULL,  -- cortex | template
  STATUS            VARCHAR(20)  NOT NULL DEFAULT 'proposed',
  CREATED_AT        TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  EXPIRES_AT        TIMESTAMP_NTZ
);

CREATE TABLE IF NOT EXISTS FACT_AGENT_PROPOSAL_WEEK (
  PROPOSAL_ID    VARCHAR(40)  NOT NULL,
  WEEK_ID        VARCHAR(10)  NOT NULL,
  CURRENT_UNITS  NUMBER(14,2) NOT NULL,
  PROPOSED_UNITS NUMBER(14,2) NOT NULL,
  PRIMARY KEY (PROPOSAL_ID, WEEK_ID)
);

-- ---------------------------------------------------------------------
-- FACT_AGENT_DECISION — what the human did about it.
--
-- SCENARIO_ID NULL means the accepted proposal was applied straight to the
-- committed plan; otherwise it landed in that scenario.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS FACT_AGENT_DECISION (
  DECISION_ID   VARCHAR(40)  PRIMARY KEY,
  PROPOSAL_ID   VARCHAR(40)  NOT NULL,
  DECISION      VARCHAR(20)  NOT NULL,  -- accept | edit_accept | reject | defer
  DECIDED_BY    VARCHAR(80)  NOT NULL,
  DECIDED_AT    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  -- What was actually applied, which differs from PROPOSED_UNITS on edit_accept.
  APPLIED_UNITS NUMBER(14,2),
  SCENARIO_ID   VARCHAR(40),
  NOTE          VARCHAR(600)
);

-- =====================================================================
-- APP views
-- =====================================================================
USE SCHEMA APP;

-- ---------------------------------------------------------------------
-- The effective forward plan under a scenario. COALESCE is the whole trick:
-- an unedited series-week falls through to the committed plan.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_SCENARIO_PLAN AS
SELECT
  sc.SCENARIO_ID,
  sc.SCENARIO_NAME,
  p.SERIES_ID,
  p.WEEK_ID,
  p.LAG_WEEKS,
  p.PLAN_UNITS                                   AS BASE_PLAN_UNITS,
  COALESCE(e.EDIT_UNITS, p.PLAN_UNITS)           AS SCENARIO_UNITS,
  COALESCE(e.EDIT_UNITS, p.PLAN_UNITS) - p.PLAN_UNITS AS DELTA_UNITS,
  (COALESCE(e.EDIT_UNITS, p.PLAN_UNITS) - p.PLAN_UNITS) * p.UNIT_PRICE_EUR
                                                 AS DELTA_VALUE_EUR,
  COALESCE(e.EDIT_UNITS, p.PLAN_UNITS) * p.UNIT_PRICE_EUR
                                                 AS SCENARIO_VALUE_EUR,
  p.UNIT_PRICE_EUR,
  e.ORIGIN,
  e.REASON_CODE,
  e.SOURCE_PROPOSAL_ID,
  e.PARENT_LEVEL,
  e.PARENT_KEY,
  e.DISAGG_METHOD,
  e.EDITED_BY,
  e.SERIES_ID IS NOT NULL                        AS IS_EDITED
FROM CORE.DIM_SCENARIO sc
CROSS JOIN V_PLAN_FORWARD p
LEFT JOIN CORE.FACT_SCENARIO_EDIT e
       ON e.SCENARIO_ID = sc.SCENARIO_ID
      AND e.SERIES_ID = p.SERIES_ID
      AND e.WEEK_ID = p.WEEK_ID
WHERE sc.STATUS <> 'discarded';

-- ---------------------------------------------------------------------
-- One row per scenario: how big is it, how much did it move, and how much of
-- that came from the agent rather than a human.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_SCENARIO_SUMMARY AS
SELECT
  sc.SCENARIO_ID, sc.SCENARIO_NAME, sc.DESCRIPTION, sc.STATUS,
  sc.BASE_PLAN_WEEK, sc.CREATED_BY, sc.CREATED_AT, sc.UPDATED_AT,
  sc.PROMOTED_AT, sc.PROMOTED_BY, sc.PARENT_SCENARIO_ID,
  COUNT(e.SERIES_ID)                                        AS EDIT_COUNT,
  COUNT(DISTINCT e.SERIES_ID)                               AS SERIES_EDITED,
  COUNT(DISTINCT e.EDIT_GROUP_ID)                           AS EDIT_GROUPS,
  SUM(CASE WHEN e.ORIGIN = 'agent' THEN 1 ELSE 0 END)       AS AGENT_EDITS,
  COALESCE(SUM(e.DELTA_UNITS), 0)                           AS DELTA_UNITS,
  COALESCE(SUM(e.DELTA_UNITS * s.UNIT_PRICE_EUR), 0)    AS DELTA_VALUE_EUR
FROM CORE.DIM_SCENARIO sc
LEFT JOIN CORE.FACT_SCENARIO_EDIT e ON e.SCENARIO_ID = sc.SCENARIO_ID
LEFT JOIN V_SERIES s                ON s.SERIES_ID = e.SERIES_ID
GROUP BY 1,2,3,4,5,6,7,8,9,10,11;

-- ---------------------------------------------------------------------
-- The proposal queue. Ranked by value at stake rather than by deviation, so a
-- large percentage move on a tail series does not outrank a smaller one on a
-- product that matters.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_AGENT_QUEUE AS
SELECT
  p.PROPOSAL_ID, p.RUN_ID, p.AS_OF_WEEK, p.PROPOSAL_TYPE, p.STATUS,
  p.SERIES_ID, p.NODE_LEVEL, p.NODE_KEY,
  p.WEEK_FROM, p.WEEK_TO,
  p.CURRENT_UNITS, p.PROPOSED_UNITS, p.DELTA_UNITS, p.DELTA_VALUE_EUR,
  p.CONFIDENCE, p.REASON_CODE, r2.REASON_LABEL,
  p.TRIGGER_SUMMARY, p.DIAGNOSIS, p.EVIDENCE,
  p.RATIONALE, p.RATIONALE_SOURCE, p.CREATED_AT,
  run.RUN_TYPE, run.NARRATIVE_MODE, run.MODEL_NAME,
  s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME,
  s.CATEGORY_NAME, s.SEGMENT_ABC, s.SEGMENT_XYZ, s.BASE_ANNUAL_VALUE_EUR,
  CASE
    WHEN ABS(p.DELTA_VALUE_EUR) >= 1000000 AND p.CONFIDENCE >= 0.75 THEN 'Critical'
    WHEN ABS(p.DELTA_VALUE_EUR) >= 500000  AND p.CONFIDENCE >= 0.60 THEN 'High'
    WHEN ABS(p.DELTA_VALUE_EUR) >= 100000                            THEN 'Medium'
    ELSE 'Low'
  END AS PRIORITY
FROM CORE.FACT_AGENT_PROPOSAL p
JOIN CORE.FACT_AGENT_RUN run ON run.RUN_ID = p.RUN_ID
LEFT JOIN V_SERIES s            ON s.SERIES_ID = p.SERIES_ID
LEFT JOIN CORE.DIM_REASON_CODE r2 ON r2.REASON_CODE = p.REASON_CODE;

-- ---------------------------------------------------------------------
-- Did the agent actually help?
--
-- Only ACCEPTED proposals whose target weeks now have actuals can be scored.
-- Live proposals target the forward horizon and so have no outturn yet, which
-- is exactly why the engine also back-runs at historical origins.
--
-- ERR_BEFORE uses the plan as it stood when the proposal was made; ERR_AFTER
-- uses what the agent suggested. A positive UNITS_SAVED means it helped.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_AGENT_SCORECARD AS
WITH scored AS (
  SELECT
    p.PROPOSAL_ID, p.PROPOSAL_TYPE, p.AS_OF_WEEK, p.CONFIDENCE,
    p.SERIES_ID, run.RUN_TYPE, d.DECISION,
    SUM(ABS(w.CURRENT_UNITS  - a.UNITS)) AS ERR_BEFORE,
    SUM(ABS(w.PROPOSED_UNITS - a.UNITS)) AS ERR_AFTER,
    SUM(a.UNITS)                         AS ACTUAL_UNITS,
    COUNT(*)                                AS WEEKS_SCORED
  FROM CORE.FACT_AGENT_PROPOSAL p
  JOIN CORE.FACT_AGENT_RUN run ON run.RUN_ID = p.RUN_ID
  JOIN CORE.FACT_AGENT_PROPOSAL_WEEK w ON w.PROPOSAL_ID = p.PROPOSAL_ID
  JOIN CORE.FACT_AGENT_DECISION d      ON d.PROPOSAL_ID = p.PROPOSAL_ID
  JOIN CORE.FACT_POS_WEEKLY a
    ON a.SERIES_ID = p.SERIES_ID AND a.WEEK_ID = w.WEEK_ID
  WHERE d.DECISION IN ('accept', 'edit_accept')
  GROUP BY 1,2,3,4,5,6,7
)
SELECT
  sc.*,
  sc.ERR_BEFORE - sc.ERR_AFTER                                  AS UNITS_SAVED,
  CASE WHEN sc.ERR_AFTER < sc.ERR_BEFORE THEN TRUE ELSE FALSE END AS IMPROVED,
  sc.ERR_BEFORE / NULLIF(sc.ACTUAL_UNITS, 0)                    AS WAPE_BEFORE,
  sc.ERR_AFTER  / NULLIF(sc.ACTUAL_UNITS, 0)                    AS WAPE_AFTER,
  s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.SEGMENT_ABC,
  s.UNIT_PRICE_EUR,
  (sc.ERR_BEFORE - sc.ERR_AFTER) * s.UNIT_PRICE_EUR         AS VALUE_SAVED_EUR
FROM scored sc
LEFT JOIN V_SERIES s ON s.SERIES_ID = sc.SERIES_ID;

-- ---------------------------------------------------------------------
-- Integrity, extended.
--
-- The new assertion is that a scenario's leaf edits must reconcile to the
-- delta they claim, and that no edit references a series-week outside the
-- forward plan. Both are silent-corruption failure modes.
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
WHERE f.SERIES_ID IS NULL
UNION ALL
-- An edit whose stored delta disagrees with its own before/after values.
SELECT 'scenario_edit_delta', COUNT(*)
FROM CORE.FACT_SCENARIO_EDIT
WHERE ABS((EDIT_UNITS - BASE_UNITS) - DELTA_UNITS) > 0.02
UNION ALL
-- An edit pointing at a series-week that is not in the forward plan.
SELECT 'scenario_edit_orphan', COUNT(*)
FROM CORE.FACT_SCENARIO_EDIT e
LEFT JOIN CORE.FACT_DEMAND_PLAN d
  ON d.SERIES_ID = e.SERIES_ID AND d.WEEK_ID = e.WEEK_ID
WHERE d.SERIES_ID IS NULL
UNION ALL
-- A proposal whose week detail does not sum to its stated totals.
SELECT 'proposal_week_totals', COUNT(*)
FROM (
  SELECT p.PROPOSAL_ID,
         p.CURRENT_UNITS  AS HDR_CUR,
         p.PROPOSED_UNITS AS HDR_PROP,
         SUM(w.CURRENT_UNITS)  AS WK_CUR,
         SUM(w.PROPOSED_UNITS) AS WK_PROP
  FROM CORE.FACT_AGENT_PROPOSAL p
  JOIN CORE.FACT_AGENT_PROPOSAL_WEEK w ON w.PROPOSAL_ID = p.PROPOSAL_ID
  GROUP BY 1,2,3
)
WHERE ABS(HDR_CUR - WK_CUR) > 0.05 OR ABS(HDR_PROP - WK_PROP) > 0.05
UNION ALL
-- A decision referencing a proposal that does not exist.
SELECT 'decision_orphan', COUNT(*)
FROM CORE.FACT_AGENT_DECISION d
LEFT JOIN CORE.FACT_AGENT_PROPOSAL p ON p.PROPOSAL_ID = d.PROPOSAL_ID
WHERE p.PROPOSAL_ID IS NULL;
