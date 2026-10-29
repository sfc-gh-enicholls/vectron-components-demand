-- =====================================================================
-- 17-horizon-extend.sql — extend the weekly calendar to 52 weeks forward
-- =====================================================================
-- Supply planning needs 52 weeks: ECU boards and kit packaging carry 14-16 week lead
-- times, which a 28-week horizon cannot net. 01-schema.sql now generates
-- the full calendar on a clean rebuild; this file brings an EXISTING
-- database up to the same end WITHOUT CREATE OR REPLACE, so nothing that
-- references DIM_WEEK is dropped or reinitialised.
--
-- Idempotent: inserts only weeks not already present. Same column
-- definitions as 01-schema.sql (kept identical on purpose).
-- Run order: after 16; then `python scripts/forecast.py --extend`.
-- =====================================================================
USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

INSERT INTO DIM_WEEK
WITH days AS (
  SELECT DATEADD(day, SEQ4(), DATE '2022-12-26') AS d
  FROM TABLE(GENERATOR(ROWCOUNT => 1800))
),
mondays AS (
  SELECT d AS week_start
  FROM days
  WHERE DAYOFWEEKISO(d) = 1
    AND d BETWEEN DATE '2023-01-02' AND DATE '2027-09-06'
)
SELECT
  TO_CHAR(YEAROFWEEKISO(week_start)) || '-W' ||
    LPAD(TO_CHAR(WEEKISO(week_start)), 2, '0'),
  week_start,
  DATEADD(day, 6, week_start),
  YEAROFWEEKISO(week_start),
  WEEKISO(week_start),
  -- Calendar fiscal year, matching 01-schema.sql.
  YEAR(week_start),
  'Q' || TO_CHAR(QUARTER(week_start)),
  MONTH(week_start),
  MONTH(week_start),
  MONTHNAME(week_start)
FROM mondays m
WHERE NOT EXISTS (
  SELECT 1 FROM DIM_WEEK w WHERE w.WEEK_START_DATE = m.week_start
);

COMMENT ON TABLE DIM_WEEK IS
  'ISO weekly calendar 2023-W01 to 2027-W36 with a calendar-year fiscal mapping';

-- Events whose date has just come inside the calendar get their week.
UPDATE DIM_EVENT e
SET WEEK_ID = w.WEEK_ID
FROM DIM_WEEK w
WHERE e.WEEK_ID IS NULL
  AND e.EVENT_DATE BETWEEN w.WEEK_START_DATE AND w.WEEK_END_DATE;
