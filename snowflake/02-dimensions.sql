-- =====================================================================
-- Vectron Components — Demand Planning
-- 02: Dimensions
-- =====================================================================
--
-- Vectron Components GmbH is FICTIONAL: a Munich-headquartered Tier 1 in
-- brake systems, chassis, steering, powertrain and e-drive, ~EUR 8bn
-- revenue, 12 plants across DE / CZ / PL / MX. The OEM customer names are
-- real companies; every volume, share and date tied to them here is
-- ILLUSTRATIVE and synthetic.
--
-- Planning grain is part family x customer x channel:
--   * part family  - DIM_PRODUCT (the "what")
--   * customer     - an OEM group, or the independent aftermarket
--   * channel      - OE series production, OES service parts (sold to the
--                    OEM's parts organisation), IAM independent aftermarket
--
-- What is deliberately accurate is the SHAPE: e-drive concentrated on the
-- premium German OEMs, carbon-ceramic and air suspension only on premium
-- platforms, ICE powertrain in decline, wear parts (pads, discs, dampers)
-- dominating the aftermarket, and plant shutdown weeks that move every year
-- with the German state school-holiday calendar.
-- =====================================================================

USE DATABASE VECTRON_DEMAND;
USE SCHEMA CORE;

-- ---------------------------------------------------------------------
-- DIM_CATEGORY — product system
--   IS_WINTER_SKEW: aftermarket wear peaks in the winter half (brakes, chassis)
--   IS_EV_EXPOSED:  volume rides the battery-electric share of builds
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_CATEGORY (
  CATEGORY_ID    VARCHAR(20) PRIMARY KEY,
  CATEGORY_NAME  VARCHAR(50) NOT NULL,
  SYSTEM_GROUP   VARCHAR(20) NOT NULL,
  IS_WINTER_SKEW BOOLEAN     NOT NULL,
  IS_EV_EXPOSED  BOOLEAN     NOT NULL
);

INSERT INTO DIM_CATEGORY VALUES
  ('CAT-BRAKE',  'Brake systems',      'Chassis',    TRUE,  FALSE),
  ('CAT-CHASSIS','Chassis & suspension','Chassis',   TRUE,  FALSE),
  ('CAT-STEER',  'Steering',           'Chassis',    FALSE, FALSE),
  ('CAT-PT',     'ICE powertrain',     'Powertrain', FALSE, FALSE),
  ('CAT-EDRIVE', 'E-drive',            'Powertrain', FALSE, TRUE);

-- ---------------------------------------------------------------------
-- DIM_CUSTOMER — OEM groups plus the independent aftermarket
--
-- The aftermarket is a customer rather than a channel for the same reason
-- Meridian modelled travel retail as a market: it is a distinct business
-- with its own P&L, sold through distributors, driven by the car parc and
-- mileage rather than by new-vehicle builds.
--
-- DELIVERY_MODE: JIS (sequenced to the line), JIT (line-side call-off),
-- STOCK (warehouse replenishment).
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_CUSTOMER (
  CUSTOMER_ID    VARCHAR(20) PRIMARY KEY,
  CUSTOMER_NAME  VARCHAR(50) NOT NULL,
  REGION         VARCHAR(30) NOT NULL,
  CURRENCY       VARCHAR(3)  NOT NULL,
  IS_AFTERMARKET BOOLEAN     NOT NULL,
  DELIVERY_MODE  VARCHAR(10) NOT NULL
);

INSERT INTO DIM_CUSTOMER VALUES
  ('OEM-BMW',  'BMW Group',            'Germany',  'EUR', FALSE, 'JIS'),
  ('OEM-VW',   'Volkswagen',           'Germany',  'EUR', FALSE, 'JIS'),
  ('OEM-AUDI', 'Audi',                 'Germany',  'EUR', FALSE, 'JIS'),
  ('OEM-POR',  'Porsche',              'Germany',  'EUR', FALSE, 'JIS'),
  ('OEM-MB',   'Mercedes-Benz',        'Germany',  'EUR', FALSE, 'JIS'),
  ('OEM-STLA', 'Stellantis',           'Europe',   'EUR', FALSE, 'JIT'),
  ('OEM-REN',  'Renault Group',        'Europe',   'EUR', FALSE, 'JIT'),
  ('OEM-FORD', 'Ford (EU & Mexico)',   'Americas', 'USD', FALSE, 'JIT'),
  ('AM-IAM',   'Independent aftermarket','Global', 'EUR', TRUE,  'STOCK');

-- ---------------------------------------------------------------------
-- DIM_CHANNEL
--   OE   series parts called off against the OEM's production schedule
--   OES  original-equipment service parts sold to the OEM parts business
--   IAM  independent aftermarket, through distributors
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_CHANNEL (
  CHANNEL_ID        VARCHAR(20) PRIMARY KEY,
  CHANNEL_NAME      VARCHAR(40) NOT NULL,
  CHANNEL_GROUP     VARCHAR(20) NOT NULL,
  PRICE_SENSITIVITY VARCHAR(10) NOT NULL
);

INSERT INTO DIM_CHANNEL VALUES
  ('CH-OE',  'OE series production', 'Original equipment', 'Low'),
  ('CH-OES', 'OES service parts',    'Service',            'Medium'),
  ('CH-IAM', 'Independent aftermarket','Aftermarket',      'High');

-- ---------------------------------------------------------------------
-- DIM_PRODUCT — part families
--
-- ANNUAL_UNITS_GLOBAL is the CURRENT run rate in pieces per year across all
-- customers. UNIT_PRICE_EUR is the average realised piece price.
-- PRICE_TIER is engineering content, which is what drives contract price
-- behaviour: commodity parts face annual price-downs and resourcing, while
-- mechatronic systems are single-sourced for the platform life.
-- PART_WEIGHT_KG feeds freight and tariff calculations downstream.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_PRODUCT (
  PRODUCT_ID          VARCHAR(20)  PRIMARY KEY,
  PRODUCT_NAME        VARCHAR(60)  NOT NULL,
  PRODUCT_LINE        VARCHAR(40)  NOT NULL,
  CATEGORY_ID         VARCHAR(20)  NOT NULL,
  PRICE_TIER          VARCHAR(20)  NOT NULL,
  PART_WEIGHT_KG      NUMBER(6,1)  NOT NULL,
  UNIT_PRICE_EUR      NUMBER(10,2) NOT NULL,
  ANNUAL_UNITS_GLOBAL NUMBER(12,0) NOT NULL,
  LIFECYCLE_STATUS    VARCHAR(20)  NOT NULL,
  LAUNCH_WEEK_ID      VARCHAR(10),
  DELIST_WEEK_ID      VARCHAR(10),
  CONSTRAINT FK_PRODUCT_CAT FOREIGN KEY (CATEGORY_ID) REFERENCES DIM_CATEGORY(CATEGORY_ID)
);

INSERT INTO DIM_PRODUCT
  (PRODUCT_ID, PRODUCT_NAME, PRODUCT_LINE, CATEGORY_ID, PRICE_TIER, PART_WEIGHT_KG,
   UNIT_PRICE_EUR, ANNUAL_UNITS_GLOBAL, LIFECYCLE_STATUS, LAUNCH_WEEK_ID, DELIST_WEEK_ID)
VALUES
  -- Brake systems
  ('P-CALFX',  'Fixed brake caliper',          'Brake calipers',   'CAT-BRAKE',  'Engineered',  4.8,   95.00,  2500000, 'Mature',  NULL, NULL),
  ('P-CALFL',  'Floating brake caliper',       'Brake calipers',   'CAT-BRAKE',  'Standard',    3.1,   48.00,  5700000, 'Mature',  NULL, NULL),
  ('P-EPB',    'Electric parking brake caliper','Brake calipers',  'CAT-BRAKE',  'Mechatronic', 3.9,  160.00,  2300000, 'Mature',  NULL, NULL),
  ('P-DISCV',  'Ventilated brake disc',        'Brake discs',      'CAT-BRAKE',  'Commodity',   8.5,   22.00,  8400000, 'Mature',  NULL, NULL),
  ('P-DISCC',  'Carbon-ceramic brake disc',    'Brake discs',      'CAT-BRAKE',  'Engineered',  4.2,  950.00,    72000, 'Mature',  NULL, NULL),
  ('P-PAD',    'Brake pad set',                'Friction',         'CAT-BRAKE',  'Commodity',   1.1,   14.00, 13000000, 'Mature',  NULL, NULL),
  ('P-IBS',    'Integrated brake-by-wire unit','Brake control',    'CAT-BRAKE',  'Mechatronic', 4.6,  420.00,   960000, 'Growth',  '2024-W22', NULL),
  ('P-ABS',    'ESC hydraulic modulator',      'Brake control',    'CAT-BRAKE',  'Mechatronic', 2.4,  210.00,  1850000, 'Mature',  NULL, NULL),
  -- Chassis & suspension
  ('P-CTRL',   'Aluminium control arm',        'Suspension links', 'CAT-CHASSIS','Standard',    2.6,   38.00,  7200000, 'Mature',  NULL, NULL),
  ('P-KNUCK',  'Steering knuckle',             'Corner modules',   'CAT-CHASSIS','Standard',    3.4,   55.00,  3900000, 'Mature',  NULL, NULL),
  ('P-SUBF',   'Front subframe',               'Corner modules',   'CAT-CHASSIS','Engineered', 14.0,  180.00,  1300000, 'Mature',  NULL, NULL),
  ('P-STAB',   'Stabiliser link',              'Suspension links', 'CAT-CHASSIS','Commodity',   0.6,    9.00,  9000000, 'Mature',  NULL, NULL),
  ('P-DAMPA',  'Adaptive damper',              'Dampers',          'CAT-CHASSIS','Mechatronic', 3.8,  190.00,  1450000, 'Mature',  NULL, NULL),
  ('P-DAMP',   'Twin-tube damper',             'Dampers',          'CAT-CHASSIS','Standard',    2.9,   32.00,  6600000, 'Mature',  NULL, NULL),
  ('P-AIRS',   'Air suspension module',        'Dampers',          'CAT-CHASSIS','Mechatronic', 6.5,  610.00,   270000, 'Mature',  NULL, NULL),
  ('P-WHUB',   'Wheel hub bearing unit',       'Corner modules',   'CAT-CHASSIS','Standard',    2.2,   42.00,  5400000, 'Mature',  NULL, NULL),
  -- Steering
  ('P-EPSC',   'Column-assist EPS',            'Electric steering','CAT-STEER',  'Mechatronic', 7.9,  240.00,  1250000, 'Mature',  NULL, NULL),
  ('P-EPSR',   'Rack-assist EPS',              'Electric steering','CAT-STEER',  'Mechatronic',11.5,  380.00,  1550000, 'Mature',  NULL, NULL),
  ('P-TIER',   'Tie rod assembly',             'Steering links',   'CAT-STEER',  'Commodity',   0.9,   16.00,  6000000, 'Mature',  NULL, NULL),
  ('P-SBW',    'Steer-by-wire actuator',       'Electric steering','CAT-STEER',  'Mechatronic', 9.2,  900.00,    40000, 'Launch',  '2025-W36', NULL),
  -- ICE powertrain
  ('P-TH8',    '8-speed transmission housing', 'Transmission',     'CAT-PT',     'Engineered', 21.0,  310.00,  1150000, 'Decline', NULL, NULL),
  ('P-DCT',    'Dual-clutch module',           'Transmission',     'CAT-PT',     'Engineered', 12.0,  420.00,   650000, 'Decline', NULL, NULL),
  ('P-DMF',    'Dual-mass flywheel',           'Driveline',        'CAT-PT',     'Standard',   11.0,  160.00,  1950000, 'Decline', NULL, NULL),
  ('P-DMFD',   'Dual-mass flywheel (diesel, legacy)','Driveline',  'CAT-PT',     'Standard',   12.5,  150.00,   300000, 'Delisted',NULL, '2025-W40'),
  ('P-DIFF',   'Differential assembly',        'Driveline',        'CAT-PT',     'Engineered', 18.0,  280.00,  1200000, 'Mature',  NULL, NULL),
  ('P-HSHAFT', 'Half shaft with CV joints',    'Driveline',        'CAT-PT',     'Standard',    6.8,   65.00,  4200000, 'Mature',  NULL, NULL),
  ('P-ENGM',   'Hydraulic engine mount',       'Mounts',           'CAT-PT',     'Commodity',   1.4,   24.00,  5400000, 'Decline', NULL, NULL),
  -- E-drive
  ('P-EAXLE',  '3-in-1 e-axle (400V)',         'E-axles',          'CAT-EDRIVE', 'Mechatronic',78.0, 2100.00,   330000, 'Growth',  NULL, NULL),
  ('P-EAX2',   '800V e-axle (gen 2)',          'E-axles',          'CAT-EDRIVE', 'Mechatronic',71.0, 2400.00,   150000, 'Launch',  '2026-W14', NULL),
  ('P-RGB',    'E-axle reduction gearbox',     'E-drive components','CAT-EDRIVE','Engineered', 24.0,  520.00,   540000, 'Growth',  NULL, NULL),
  ('P-ROTOR',  'E-motor rotor shaft',          'E-drive components','CAT-EDRIVE','Engineered',  6.1,   85.00,   960000, 'Growth',  NULL, NULL),
  ('P-INVH',   'Inverter housing',             'E-drive components','CAT-EDRIVE','Standard',    3.3,   70.00,   840000, 'Growth',  NULL, NULL),
  ('P-BTRAY',  'Battery tray',                 'Battery structures','CAT-EDRIVE','Engineered', 38.0,  340.00,   480000, 'Growth',  NULL, NULL);

-- ---------------------------------------------------------------------
-- PRODUCT_CUSTOMER_MIX — which customer takes what share of each part
--
-- Built from two auditable tables rather than hand-typed per row:
--   CATEGORY_CUSTOMER_WEIGHT  the typical customer split for a system
--   PRODUCT_CUSTOMER_ADJ      per-part departures; MULTIPLIER 0 excludes
-- The result is renormalised so VOLUME_SHARE sums to exactly 1 per part.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE CATEGORY_CUSTOMER_WEIGHT (
  CATEGORY_ID VARCHAR(20) NOT NULL,
  CUSTOMER_ID VARCHAR(20) NOT NULL,
  WEIGHT      NUMBER(6,4) NOT NULL,
  PRIMARY KEY (CATEGORY_ID, CUSTOMER_ID)
);

INSERT INTO CATEGORY_CUSTOMER_WEIGHT VALUES
  ('CAT-BRAKE','OEM-BMW',0.18),('CAT-BRAKE','OEM-VW',0.17),('CAT-BRAKE','OEM-AUDI',0.10),
  ('CAT-BRAKE','OEM-POR',0.03),('CAT-BRAKE','OEM-MB',0.12),('CAT-BRAKE','OEM-STLA',0.16),
  ('CAT-BRAKE','OEM-REN',0.08),('CAT-BRAKE','OEM-FORD',0.06),('CAT-BRAKE','AM-IAM',0.10),
  ('CAT-CHASSIS','OEM-BMW',0.16),('CAT-CHASSIS','OEM-VW',0.18),('CAT-CHASSIS','OEM-AUDI',0.09),
  ('CAT-CHASSIS','OEM-POR',0.02),('CAT-CHASSIS','OEM-MB',0.10),('CAT-CHASSIS','OEM-STLA',0.18),
  ('CAT-CHASSIS','OEM-REN',0.10),('CAT-CHASSIS','OEM-FORD',0.07),('CAT-CHASSIS','AM-IAM',0.10),
  ('CAT-STEER','OEM-BMW',0.20),('CAT-STEER','OEM-VW',0.16),('CAT-STEER','OEM-AUDI',0.10),
  ('CAT-STEER','OEM-POR',0.03),('CAT-STEER','OEM-MB',0.14),('CAT-STEER','OEM-STLA',0.14),
  ('CAT-STEER','OEM-REN',0.09),('CAT-STEER','OEM-FORD',0.08),('CAT-STEER','AM-IAM',0.06),
  ('CAT-PT','OEM-BMW',0.22),('CAT-PT','OEM-VW',0.14),('CAT-PT','OEM-AUDI',0.10),
  ('CAT-PT','OEM-POR',0.04),('CAT-PT','OEM-MB',0.12),('CAT-PT','OEM-STLA',0.20),
  ('CAT-PT','OEM-REN',0.04),('CAT-PT','OEM-FORD',0.10),('CAT-PT','AM-IAM',0.04),
  ('CAT-EDRIVE','OEM-BMW',0.26),('CAT-EDRIVE','OEM-VW',0.22),('CAT-EDRIVE','OEM-AUDI',0.14),
  ('CAT-EDRIVE','OEM-POR',0.08),('CAT-EDRIVE','OEM-MB',0.16),('CAT-EDRIVE','OEM-STLA',0.08),
  ('CAT-EDRIVE','OEM-REN',0.04),('CAT-EDRIVE','OEM-FORD',0.02);

CREATE OR REPLACE TABLE PRODUCT_CUSTOMER_ADJ (
  PRODUCT_ID  VARCHAR(20) NOT NULL,
  CUSTOMER_ID VARCHAR(20) NOT NULL,
  MULTIPLIER  NUMBER(6,3) NOT NULL,
  RATIONALE   VARCHAR(200),
  PRIMARY KEY (PRODUCT_ID, CUSTOMER_ID)
);

INSERT INTO PRODUCT_CUSTOMER_ADJ VALUES
  -- Wear parts dominate the independent aftermarket
  ('P-PAD','AM-IAM',3.0,'Friction is the largest aftermarket line'),
  ('P-DISCV','AM-IAM',2.5,'Discs replaced every second pad change'),
  ('P-DAMP','AM-IAM',2.2,'Dampers are a core aftermarket wear part'),
  ('P-CTRL','AM-IAM',1.8,NULL),('P-STAB','AM-IAM',2.2,NULL),
  ('P-TIER','AM-IAM',2.2,NULL),('P-WHUB','AM-IAM',2.0,NULL),('P-CALFL','AM-IAM',1.6,NULL),
  -- Systems that never reach the independent aftermarket
  ('P-IBS','AM-IAM',0,'Coded to the vehicle; OES only'),
  ('P-ABS','AM-IAM',0.3,NULL),
  ('P-DAMPA','AM-IAM',0.2,NULL),('P-SUBF','AM-IAM',0,'Crash repair only, through OES'),
  ('P-EPSC','AM-IAM',0.3,NULL),('P-EPSR','AM-IAM',0.3,NULL),('P-SBW','AM-IAM',0,NULL),
  ('P-TH8','AM-IAM',0,NULL),('P-DCT','AM-IAM',0.5,NULL),('P-DIFF','AM-IAM',0,NULL),
  -- Premium-only content
  ('P-DISCC','OEM-VW',0,'Premium performance only'),('P-DISCC','OEM-STLA',0,NULL),
  ('P-DISCC','OEM-REN',0,NULL),('P-DISCC','OEM-FORD',0,NULL),('P-DISCC','AM-IAM',0,NULL),
  ('P-DISCC','OEM-POR',8.0,'Porsche is the anchor customer'),
  ('P-AIRS','OEM-VW',0,'Premium platforms only'),('P-AIRS','OEM-STLA',0,NULL),
  ('P-AIRS','OEM-REN',0,NULL),('P-AIRS','OEM-FORD',0,NULL),('P-AIRS','AM-IAM',0,NULL),
  ('P-AIRS','OEM-MB',2.0,NULL),
  ('P-SBW','OEM-VW',0,'Launch customers only'),('P-SBW','OEM-AUDI',0,NULL),
  ('P-SBW','OEM-POR',0,NULL),('P-SBW','OEM-STLA',0,NULL),('P-SBW','OEM-REN',0,NULL),
  ('P-SBW','OEM-FORD',0,NULL),
  ('P-EAX2','OEM-BMW',0,'Launched on the 800V premium platform shared by Porsche and Audi'),
  ('P-EAX2','OEM-VW',0,NULL),('P-EAX2','OEM-MB',0,NULL),('P-EAX2','OEM-STLA',0,NULL),
  ('P-EAX2','OEM-REN',0,NULL),('P-EAX2','OEM-FORD',0,NULL),('P-EAX2','OEM-POR',3.0,NULL),
  ('P-DCT','OEM-MB',0,'Not on the MB architecture'),('P-DCT','OEM-BMW',0.3,NULL),
  ('P-DMFD','OEM-POR',0,NULL),('P-DMFD','OEM-STLA',3.0,'Diesel legacy volume is Stellantis-led');

CREATE OR REPLACE TABLE PRODUCT_CUSTOMER_MIX AS
WITH raw AS (
  SELECT p.PRODUCT_ID, w.CUSTOMER_ID, w.WEIGHT * COALESCE(a.MULTIPLIER, 1) AS W
  FROM DIM_PRODUCT p
  JOIN CATEGORY_CUSTOMER_WEIGHT w ON w.CATEGORY_ID = p.CATEGORY_ID
  LEFT JOIN PRODUCT_CUSTOMER_ADJ a ON a.PRODUCT_ID = p.PRODUCT_ID AND a.CUSTOMER_ID = w.CUSTOMER_ID
)
SELECT PRODUCT_ID, CUSTOMER_ID,
       CAST(W / SUM(W) OVER (PARTITION BY PRODUCT_ID) AS NUMBER(10,8)) AS VOLUME_SHARE
FROM raw WHERE W > 0;

ALTER TABLE PRODUCT_CUSTOMER_MIX ADD PRIMARY KEY (PRODUCT_ID, CUSTOMER_ID);

-- ---------------------------------------------------------------------
-- CHANNEL_MIX — channel split by customer. OEMs buy series parts and a
-- service-parts tail; the aftermarket buys through one channel only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE CHANNEL_MIX (
  CUSTOMER_ID VARCHAR(20) NOT NULL,
  CHANNEL_ID  VARCHAR(20) NOT NULL,
  SHARE       NUMBER(6,4) NOT NULL,
  PRIMARY KEY (CUSTOMER_ID, CHANNEL_ID)
);

INSERT INTO CHANNEL_MIX (CUSTOMER_ID, CHANNEL_ID, SHARE) VALUES
  ('OEM-BMW','CH-OE',0.9000),('OEM-BMW','CH-OES',0.1000),
  ('OEM-VW','CH-OE',0.9100),('OEM-VW','CH-OES',0.0900),
  ('OEM-AUDI','CH-OE',0.9000),('OEM-AUDI','CH-OES',0.1000),
  ('OEM-POR','CH-OE',0.8800),('OEM-POR','CH-OES',0.1200),
  ('OEM-MB','CH-OE',0.9000),('OEM-MB','CH-OES',0.1000),
  ('OEM-STLA','CH-OE',0.9200),('OEM-STLA','CH-OES',0.0800),
  ('OEM-REN','CH-OE',0.9200),('OEM-REN','CH-OES',0.0800),
  ('OEM-FORD','CH-OE',0.9300),('OEM-FORD','CH-OES',0.0700),
  ('AM-IAM','CH-IAM',1.0000);

-- ---------------------------------------------------------------------
-- DIM_EVENT — the OEM plant calendar
--
-- This is the table that justifies weekly grain. German OEM summer
-- shutdowns follow the school holidays of the plant's federal state, which
-- move every year: Bavaria (BMW, Audi) starts in late July or early August,
-- Lower Saxony (VW) from late June, Baden-Wuerttemberg (Mercedes, Porsche)
-- in late July. A three-week shutdown that starts 29 July one year and
-- 4 August the next lands in a different calendar month, so a monthly
-- year-on-year read reports a collapse in one month and a surge in the next
-- when only the calendar moved. DATES ARE ILLUSTRATIVE.
--
-- EVENT_TYPE drives the shape the generator and the model share:
--   SHUTDOWN    DURATION_WEEKS near-zero, a ramp-up week after, and a
--               pre-build in the two weeks before (OEMs bank stock ahead)
--   CHANGEOVER  a one-week dip for a model-year or line changeover
--   MACRO       a step change from the event week onwards
-- UPLIFT_FACTOR is the generator's ground truth; the forecast never reads it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_EVENT (
  EVENT_ID        VARCHAR(30)  PRIMARY KEY,
  EVENT_NAME      VARCHAR(60)  NOT NULL,
  EVENT_TYPE      VARCHAR(20)  NOT NULL,
  EVENT_DATE      DATE         NOT NULL,
  WEEK_ID         VARCHAR(10),
  CUSTOMER_SCOPE  VARCHAR(200) NOT NULL,
  LEAD_WEEKS      NUMBER(3,0)  NOT NULL,
  UPLIFT_FACTOR   NUMBER(5,2)  NOT NULL,
  DURATION_WEEKS  NUMBER(3,0)  NOT NULL DEFAULT 1,
  DESCRIPTION     VARCHAR(300)
);

INSERT INTO DIM_EVENT
  (EVENT_ID, EVENT_NAME, EVENT_TYPE, EVENT_DATE, WEEK_ID, CUSTOMER_SCOPE, LEAD_WEEKS, UPLIFT_FACTOR, DURATION_WEEKS, DESCRIPTION)
VALUES
  -- Summer shutdowns: Bavaria
  ('EVT-SBY-2023','Summer shutdown Bavaria 2023','SHUTDOWN','2023-07-31',NULL,'OEM-BMW,OEM-AUDI',2,0.12,3,'Dingolfing, Munich, Ingolstadt.'),
  ('EVT-SBY-2024','Summer shutdown Bavaria 2024','SHUTDOWN','2024-07-29',NULL,'OEM-BMW,OEM-AUDI',2,0.12,3,NULL),
  ('EVT-SBY-2025','Summer shutdown Bavaria 2025','SHUTDOWN','2025-08-04',NULL,'OEM-BMW,OEM-AUDI',2,0.12,3,'Starts a week later than 2024: the July/August split flips.'),
  ('EVT-SBY-2026','Summer shutdown Bavaria 2026','SHUTDOWN','2026-08-03',NULL,'OEM-BMW,OEM-AUDI',2,0.12,3,NULL),
  ('EVT-SBY-2027','Summer shutdown Bavaria 2027','SHUTDOWN','2027-08-02',NULL,'OEM-BMW,OEM-AUDI',2,0.12,3,NULL),
  -- Summer shutdowns: Lower Saxony
  ('EVT-SNI-2023','Summer shutdown Lower Saxony 2023','SHUTDOWN','2023-07-10',NULL,'OEM-VW',2,0.10,3,'Wolfsburg, Emden, Zwickau grouped.'),
  ('EVT-SNI-2024','Summer shutdown Lower Saxony 2024','SHUTDOWN','2024-06-24',NULL,'OEM-VW',2,0.10,3,'Earliest shutdown in the window: falls across June and July.'),
  ('EVT-SNI-2025','Summer shutdown Lower Saxony 2025','SHUTDOWN','2025-07-07',NULL,'OEM-VW',2,0.10,3,NULL),
  ('EVT-SNI-2026','Summer shutdown Lower Saxony 2026','SHUTDOWN','2026-07-06',NULL,'OEM-VW',2,0.10,3,NULL),
  ('EVT-SNI-2027','Summer shutdown Lower Saxony 2027','SHUTDOWN','2027-07-12',NULL,'OEM-VW',2,0.10,3,NULL),
  -- Summer shutdowns: Baden-Wuerttemberg
  ('EVT-SBW-2023','Summer shutdown Baden-Wuerttemberg 2023','SHUTDOWN','2023-07-31',NULL,'OEM-MB,OEM-POR',2,0.14,3,'Sindelfingen, Zuffenhausen.'),
  ('EVT-SBW-2024','Summer shutdown Baden-Wuerttemberg 2024','SHUTDOWN','2024-07-29',NULL,'OEM-MB,OEM-POR',2,0.14,3,NULL),
  ('EVT-SBW-2025','Summer shutdown Baden-Wuerttemberg 2025','SHUTDOWN','2025-08-04',NULL,'OEM-MB,OEM-POR',2,0.14,3,NULL),
  ('EVT-SBW-2026','Summer shutdown Baden-Wuerttemberg 2026','SHUTDOWN','2026-07-27',NULL,'OEM-MB,OEM-POR',2,0.14,3,'A week earlier than 2025.'),
  ('EVT-SBW-2027','Summer shutdown Baden-Wuerttemberg 2027','SHUTDOWN','2027-08-02',NULL,'OEM-MB,OEM-POR',2,0.14,3,NULL),
  -- Summer shutdowns: France / Stellantis and Renault plants
  ('EVT-SFR-2023','Summer shutdown France 2023','SHUTDOWN','2023-07-31',NULL,'OEM-STLA,OEM-REN',2,0.15,3,NULL),
  ('EVT-SFR-2024','Summer shutdown France 2024','SHUTDOWN','2024-08-05',NULL,'OEM-STLA,OEM-REN',2,0.15,3,NULL),
  ('EVT-SFR-2025','Summer shutdown France 2025','SHUTDOWN','2025-07-28',NULL,'OEM-STLA,OEM-REN',2,0.15,3,NULL),
  ('EVT-SFR-2026','Summer shutdown France 2026','SHUTDOWN','2026-08-03',NULL,'OEM-STLA,OEM-REN',2,0.15,3,NULL),
  ('EVT-SFR-2027','Summer shutdown France 2027','SHUTDOWN','2027-08-02',NULL,'OEM-STLA,OEM-REN',2,0.15,3,NULL),
  -- Ford: shorter July shutdown
  ('EVT-SFD-2023','Summer shutdown Ford 2023','SHUTDOWN','2023-07-03',NULL,'OEM-FORD',1,0.20,2,NULL),
  ('EVT-SFD-2024','Summer shutdown Ford 2024','SHUTDOWN','2024-07-01',NULL,'OEM-FORD',1,0.20,2,NULL),
  ('EVT-SFD-2025','Summer shutdown Ford 2025','SHUTDOWN','2025-06-30',NULL,'OEM-FORD',1,0.20,2,NULL),
  ('EVT-SFD-2026','Summer shutdown Ford 2026','SHUTDOWN','2026-07-06',NULL,'OEM-FORD',1,0.20,2,NULL),
  ('EVT-SFD-2027','Summer shutdown Ford 2027','SHUTDOWN','2027-07-05',NULL,'OEM-FORD',1,0.20,2,NULL),
  -- Christmas shutdowns, all OEM plants
  ('EVT-XMS-2023','Christmas shutdown 2023','SHUTDOWN','2023-12-25',NULL,'OEM-BMW,OEM-VW,OEM-AUDI,OEM-POR,OEM-MB,OEM-STLA,OEM-REN,OEM-FORD',1,0.08,2,NULL),
  ('EVT-XMS-2024','Christmas shutdown 2024','SHUTDOWN','2024-12-23',NULL,'OEM-BMW,OEM-VW,OEM-AUDI,OEM-POR,OEM-MB,OEM-STLA,OEM-REN,OEM-FORD',1,0.08,2,NULL),
  ('EVT-XMS-2025','Christmas shutdown 2025','SHUTDOWN','2025-12-22',NULL,'OEM-BMW,OEM-VW,OEM-AUDI,OEM-POR,OEM-MB,OEM-STLA,OEM-REN,OEM-FORD',1,0.08,2,NULL),
  ('EVT-XMS-2026','Christmas shutdown 2026','SHUTDOWN','2026-12-21',NULL,'OEM-BMW,OEM-VW,OEM-AUDI,OEM-POR,OEM-MB,OEM-STLA,OEM-REN,OEM-FORD',1,0.08,2,NULL),
  -- Model-year / line changeovers
  ('EVT-CHG-BMW-2024','Line changeover BMW 2024','CHANGEOVER','2024-03-11',NULL,'OEM-BMW',0,0.55,1,'Dingolfing line retooling.'),
  ('EVT-CHG-VW-2025','Line changeover VW 2025','CHANGEOVER','2025-09-08',NULL,'OEM-VW',0,0.50,1,'Model-year changeover.'),
  ('EVT-CHG-MB-2026','Line changeover MB 2026','CHANGEOVER','2026-03-02',NULL,'OEM-MB',0,0.55,1,NULL),
  ('EVT-CHG-STLA-2027','Line changeover Stellantis 2027','CHANGEOVER','2027-01-11',NULL,'OEM-STLA',0,0.55,1,NULL),
  -- Structural shifts
  ('EVT-STLA-CUT','Stellantis European production cuts','MACRO','2024-10-07',NULL,'OEM-STLA',0,0.90,1,'Sustained reduction in European build schedules.'),
  ('EVT-TARIFF-MX','US tariff on Mexican vehicle imports','MACRO','2025-03-03',NULL,'OEM-FORD',0,0.93,1,'Mexico-built volume for the US market cut back.'),
  ('EVT-RECOVERY','Semiconductor supply recovery','MACRO','2023-04-03',NULL,'OEM-BMW,OEM-VW,OEM-AUDI,OEM-POR,OEM-MB,OEM-STLA,OEM-REN,OEM-FORD',0,1.06,1,'Builds return to schedule after the chip shortage.');

UPDATE DIM_EVENT e
SET WEEK_ID = w.WEEK_ID
FROM DIM_WEEK w
WHERE e.EVENT_DATE BETWEEN w.WEEK_START_DATE AND w.WEEK_END_DATE;

-- ---------------------------------------------------------------------
-- DIM_REASON_CODE — override justification. IDs are kept stable because
-- the forecast and consensus scripts key on them; labels are Tier 1.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE DIM_REASON_CODE (
  REASON_CODE VARCHAR(30) PRIMARY KEY,
  REASON_LABEL VARCHAR(80) NOT NULL,
  REASON_GROUP VARCHAR(30) NOT NULL,
  REQUIRES_NOTE BOOLEAN NOT NULL
);

INSERT INTO DIM_REASON_CODE VALUES
  ('CUST_INTEL',   'OEM schedule intelligence',          'Commercial',  TRUE),
  ('PROMO_PLAN',   'Firm EDI release not in model',      'Commercial',  FALSE),
  ('LISTING_WIN',  'New nomination or share-of-business gain', 'Commercial', TRUE),
  ('LISTING_LOSS', 'Resourced away or share-of-business loss', 'Commercial', TRUE),
  ('EVENT_PHASE',  'Shutdown or changeover phasing',     'Demand',      FALSE),
  ('MODEL_MISS',   'Model misread history',              'Demand',      TRUE),
  ('SUPPLY_CAP',   'Supply constraint',                  'Supply',      TRUE),
  ('PRICE_CHANGE', 'Price-down or surcharge not in model','Commercial', FALSE),
  ('NPD_RAMP',     'SOP ramp judgement',                 'Demand',      TRUE),
  ('CANNIBAL',     'Part supersession',                  'Demand',      TRUE),
  ('COMPETITOR',   'Competitor resourcing activity',     'Commercial',  TRUE),
  ('ONE_OFF',      'One-off, do not repeat',             'Demand',      TRUE);

-- ---------------------------------------------------------------------
-- NPD_ANALOGUE — which existing part a launch is forecast from, and what
-- it supersedes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE NPD_ANALOGUE (
  NEW_PRODUCT_ID      VARCHAR(20) NOT NULL,
  ANALOGUE_PRODUCT_ID VARCHAR(20) NOT NULL,
  SIMILARITY_SCORE    NUMBER(4,3) NOT NULL,
  CANNIBALISATION_PCT NUMBER(5,4) NOT NULL,
  RATIONALE           VARCHAR(300),
  PRIMARY KEY (NEW_PRODUCT_ID, ANALOGUE_PRODUCT_ID)
);

INSERT INTO NPD_ANALOGUE VALUES
  ('P-EAX2','P-EAXLE', 0.880, 0.3500,
   'Same e-axle family on the next architecture; the 400V unit is superseded on the platforms that move to 800V.'),
  ('P-EAX2','P-RGB',   0.620, 0.0500,
   'Shares the reduction-gear ramp profile and test cadence.'),
  ('P-SBW','P-EPSR',   0.710, 0.1800,
   'Replaces rack EPS on the launch programmes; ramp follows an EPS SOP curve.'),
  ('P-IBS','P-ABS',    0.840, 0.3000,
   'Integrated brake-by-wire absorbs the separate ESC modulator where fitted.');

-- ---------------------------------------------------------------------
-- Integrity checks
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW V_DIM_INTEGRITY AS
SELECT 'PRODUCT_CUSTOMER_MIX' AS CHECK_NAME, PRODUCT_ID AS SUBJECT,
       ROUND(SUM(VOLUME_SHARE), 4) AS TOTAL_SHARE
FROM PRODUCT_CUSTOMER_MIX GROUP BY PRODUCT_ID
HAVING ROUND(SUM(VOLUME_SHARE), 4) <> 1.0
UNION ALL
SELECT 'CHANNEL_MIX', CUSTOMER_ID, ROUND(SUM(SHARE), 4)
FROM CHANNEL_MIX GROUP BY CUSTOMER_ID
HAVING ROUND(SUM(SHARE), 4) <> 1.0
UNION ALL
SELECT 'PRODUCT_WITHOUT_MIX', PRODUCT_ID, 0
FROM DIM_PRODUCT WHERE PRODUCT_ID NOT IN (SELECT PRODUCT_ID FROM PRODUCT_CUSTOMER_MIX)
UNION ALL
SELECT 'EVENT_WITHOUT_WEEK', EVENT_ID, 0
FROM DIM_EVENT WHERE WEEK_ID IS NULL;
