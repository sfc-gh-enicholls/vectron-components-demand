# Vectron Components — Demand Planning (automotive Tier 1 demo)

**Live demo (read-only copy, recorded data):**
https://sfc-gh-enicholls.github.io/vectron-demand-demo/

A weekly-grain demand planning app for **Vectron Components GmbH**, a fictional
Munich-based automotive Tier 1 (~€8bn, brake systems, chassis, steering, ICE
powertrain and e-drive) supplying BMW, Volkswagen, Audi, Porsche, Mercedes-Benz,
Stellantis, Renault and Ford, plus the independent aftermarket. Built on
Snowflake: every figure is computed live from views over synthetic data in the
`VECTRON_DEMAND` database. It is a discrete-manufacturing fork of the Meridian
Spirits demand app.

Planning grain is **part family × OEM customer × channel** (OE series
production, OES service parts, independent aftermarket), by ISO week. Plants
(Regensburg, Plzeň, Wrocław, Debrecen, San Luis Potosí) are a sourcing
attribute.

## The two centrepieces

**OEM call-off volatility.** Each OEM sends a 12-week EDI delivery schedule
every week. Firm weeks (0–2) are reliable at 2.1% WAPE; the trade zone (3–8)
runs 8.1% with a +2.9% over-call; the forecast zone (9–12) 17.2% and +7.0%.
Inside the trade zone the OEM's own schedule beats Vectron's statistical model
(8.1% v 10.2%), and correcting each OEM's schedule for its own trailing bias,
with no look-ahead, brings it to 7.6%. The story is "learn each OEM's bias",
not "ignore the OEM". A monthly read of a plant shutdown that moves a week
between years reports BMW August down 49.6% year on year; aligned to the
shutdown week, the two years overlay.

**Service parts on Croston.** Spare and aftermarket demand for low runners is
intermittent. Series are classified by ADI and CV² (Syntetos–Boylan) and the
intermittent ones forecast with Croston and SBA, scored on MASE. SBA's median
MASE is 1.18 against 1.63 for the statistical model, winning on 11 of 12 scored
series; the statistical model over-forecasts these parts by 92%, which is the
inventory problem.

## Outside-in demand from light-vehicle production

A synthetic stand-in for an S&P Global Mobility (IHS) light-vehicle production
forecast (13 monthly vintages to 2032) drives vehicles × pieces per vehicle ×
a calibrated installation rate. On history it tracks realised pull at 4.5%
monthly WAPE. Over Oct 2026–Jul 2027 Vectron's plan sits **€222m above** what
the vehicle market implies while volume is within 0.7%: the gap is e-drive
(+8.5%, €236m), where successive vintages have cut 2027 BEV builds by 17.3%.
`APP.V_LV_PRODUCTION` is the single view to repoint at a licensed share.

## The rest of the planning cycle

- Cockpit, demand sensing, baseline with exact additive driver decomposition,
  demand review, consensus plan (key accounts, programme management, finance
  target, planner) with accuracy and forecast value added.
- An agent that proposes plan changes, each carrying four computed signals
  (pull velocity, de-biased OEM call-off, vehicle market, plant calendar) and
  flagged as contested when they disagree.
- Scenarios, approvals with simulated personas, cycles, SDP-style plan grid and
  formulas, hierarchies.
- Volume to value: OEM annual price-downs (−€132m) offset by a mix shift into
  mechatronic and e-drive content (+€176m); delivered cost and tariff exposure.
- Supply: plants, delivery variants (JIS, JIT, service, aftermarket, winter
  kits), bought components and yearly allocations of microcontrollers, SiC
  power modules and rare-earth magnets; a constrained solve ships 95.9% of
  78.4m pieces on time with 192k lost to allocation. Tariff scenarios: a US 25%
  duty on Mexican-built parts, an aluminium surcharge spike, USMCA localisation.

## Running it

Requires Node 20+, Python 3.11+ and a Snowflake connection.

```bash
npm install
cp .env.example .env.local   # or set SNOWFLAKE_* yourself; see src/lib/snowflake.ts
npm run dev                  # http://localhost:3101
```

Build the database in this order (`scripts/run_sql.py NN` for SQL files):
`01 02 03 04` → `generate_facts.py` → `forecast.py` → `05 06` → `consensus.py` →
`calloffs.py` → `07` → `ihs.py` → `07b` → `croston.py` → `07c` →
`08-allocation 09 10` → `agent.py` → `11` → `12 13 14 15` → `17 18 19 20` →
`deploy_supply_solve.py --run` → `16` → `21 22` →
`CALL APP.SP_REFRESH_SUPPLY_SIGNAL()` → `tariff_scenarios.py`.
`APP.V_INTEGRITY_ALL` should then return 75 checks with zero violations.

All data, companies' behaviour, rates and figures are synthetic and
illustrative. No named OEM's real schedules or volumes are represented.
