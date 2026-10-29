-- =====================================================================
-- Vectron Components — Demand Planning
-- 01: Database, schemas, and the weekly calendar
-- =====================================================================
--
-- Volume unit throughout is the piece (one finished part as called off by
-- the OEM). Revenue is net sales value in EUR at the agreed piece price.
--
-- Fiscal year = calendar year, as is usual for a German Tier 1.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS VECTRON_DEMAND
  COMMENT = 'Vectron Components demand planning — weekly-grain demo dataset (synthetic)';

CREATE SCHEMA IF NOT EXISTS VECTRON_DEMAND.CORE
  COMMENT = 'Dimensions and weekly fact tables';

CREATE SCHEMA IF NOT EXISTS VECTRON_DEMAND.ML
  COMMENT = 'Forecast models and lag-versioned forecast output';

CREATE SCHEMA IF NOT EXISTS VECTRON_DEMAND.APP
  COMMENT = 'Views consumed by the application layer';

CREATE SCHEMA IF NOT EXISTS VECTRON_DEMAND.EXT_IHS
  COMMENT = 'ILLUSTRATIVE light-vehicle production data shaped like an IHS / S&P Global Mobility feed. Synthetic; replace with a real share by repointing V_LV_PRODUCTION.';

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_WEEK — ISO weeks from 2023-W01 to 2027-W36 (52 weeks forward of
-- HISTORY_END 2026-W37; extended from 2027-W13 for supply lead times)
--
-- Generated rather than seeded so the ISO year/week arithmetic is
-- Snowflake's rather than mine. ISO weeks start Monday; note that
-- ISO_YEAR can differ from the calendar year of WEEK_START_DATE at
-- year boundaries, which is exactly why we key on WEEK_ID.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_WEEK AS
WITH days AS (
  SELECT DATEADD(day, SEQ4(), DATE '2022-12-26') AS d
  FROM TABLE(GENERATOR(ROWCOUNT => 1700))
),
mondays AS (
  SELECT d AS week_start
  FROM days
  WHERE DAYOFWEEKISO(d) = 1
    AND d BETWEEN DATE '2023-01-02' AND DATE '2027-09-06'
)
SELECT
  TO_CHAR(YEAROFWEEKISO(week_start)) || '-W' ||
    LPAD(TO_CHAR(WEEKISO(week_start)), 2, '0')          AS WEEK_ID,
  week_start                                            AS WEEK_START_DATE,
  DATEADD(day, 6, week_start)                           AS WEEK_END_DATE,
  YEAROFWEEKISO(week_start)                             AS ISO_YEAR,
  WEEKISO(week_start)                                   AS ISO_WEEK,
  -- Calendar fiscal year.
  YEAR(week_start)                                      AS FISCAL_YEAR,
  'Q' || TO_CHAR(QUARTER(week_start))                   AS FISCAL_QUARTER,
  MONTH(week_start)                                     AS FISCAL_PERIOD,
  MONTH(week_start)                                     AS CALENDAR_MONTH,
  MONTHNAME(week_start)                                 AS CALENDAR_MONTH_NAME
FROM mondays
ORDER BY week_start;

ALTER TABLE DIM_WEEK ADD PRIMARY KEY (WEEK_ID);

COMMENT ON TABLE DIM_WEEK IS
  'ISO weekly calendar 2023-W01 to 2027-W36, calendar fiscal year';
