"""Unit tests for the pure supply solve. Run: python3 -m unittest scripts/test_supply_solve.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from supply_solve import Order, solve  # noqa: E402


def order(key, priority, units, release=1, receipt=3, lead=2, line="L1",
          product="B", sku="B|F70", year=2026, bom=None):
    return Order(key, sku, product, "M", "S", line, priority, release, receipt,
                 lead, units, year, bom or {})


class SolveTests(unittest.TestCase):
    def run_one(self, orders, cap=100, lot=0, dry_supply=None, dry_open=None,
                fill=None, horizon=6):
        return solve(orders, {"L1": cap}, {"L1": 0.0}, {"L1": lot},
                     dry_supply or {}, dry_open or {}, fill or {}, horizon)

    def test_strategic_first_then_pro_rata(self):
        res, _, _ = self.run_one([order(1, 1, 80), order(2, 2, 60), order(3, 2, 20)], cap=100)
        # Week 1: strategic 80 in full; 20 left for tier 2, split 60:20 -> 15/5.
        self.assertAlmostEqual(res[1].on_time, 80)
        self.assertAlmostEqual(res[2].on_time, 15)
        self.assertAlmostEqual(res[3].on_time, 5)

    def test_carry_forward_arrives_late(self):
        res, rows, _ = self.run_one([order(1, 1, 250)], cap=100)
        r = res[1]
        self.assertAlmostEqual(r.produced, 250)
        self.assertAlmostEqual(r.on_time, 100)   # only week 1 meets receipt week 3
        self.assertAlmostEqual(r.late, 150)
        self.assertEqual(r.last_prod_week, 3)
        self.assertTrue(all(made <= cap + 1e-9 for (_, _, cap, _, made, _) in rows))

    def test_liquid_shortfall_is_lost_not_backordered(self):
        res, _, _ = self.run_one([order(1, 1, 100)], fill={("B", 2026): 0.6})
        self.assertAlmostEqual(res[1].liquid_short, 40)
        self.assertAlmostEqual(res[1].produced, 60)
        self.assertAlmostEqual(res[1].unmet, 0)
        self.assertEqual(res[1].binding, "liquid")

    def test_lot_excess_never_allocated_beyond_demand(self):
        res, rows, _ = self.run_one([order(1, 1, 130)], cap=1000, lot=100)
        self.assertAlmostEqual(res[1].produced, 130)
        self.assertAlmostEqual(rows[0][5], 70)          # 200 made in lots, 70 to stock

    def test_dry_goods_bind(self):
        o = order(1, 1, 100, bom={"GLS": 12})
        res, _, _ = self.run_one([o], cap=1000, dry_supply={"GLS": 0}, dry_open={"GLS": 600})
        self.assertAlmostEqual(res[1].produced, 50)     # 600 bottles / 12 per case
        self.assertTrue(res[1].binding.startswith("dry:"))

    def test_shared_dry_good_goes_to_strategic_across_lines(self):
        # Line A (visited first) carries a value product, line B a strategic one;
        # both need the same scarce carton. Strategic must be served first.
        value = order(1, 3, 100, line="A", sku="V|G", product="V", bom={"CTN": 1})
        strat = order(2, 1, 100, line="Z", sku="S|G", product="S", bom={"CTN": 1})
        res, _, _ = solve([value, strat], {"A": 1000, "Z": 1000}, {}, {},
                          {"CTN": 0}, {"CTN": 100}, {}, 1)
        self.assertAlmostEqual(res[2].produced, 100)
        self.assertAlmostEqual(res[1].produced, 0)

    def test_mass_balance(self):
        orders = [order(i, 1 + i % 3, 40 + 10 * i, release=1 + i % 4, receipt=4 + i % 4)
                  for i in range(1, 10)]
        res, _, _ = self.run_one(orders, cap=120, fill={("B", 2026): 0.9})
        for o in orders:
            r = res[o.key]
            self.assertAlmostEqual(r.requested, r.liquid_short + r.produced + r.unmet, places=6)
            self.assertAlmostEqual(r.produced, r.on_time + r.late, places=6)

    def test_dry_good_cannot_flex_inside_its_lead_time(self):
        # Base 10/wk already on order; the supplier can flex to 50/wk, but only
        # after its 2-week lead time. One unit of GLS per case, no opening stock.
        bom = {"GLS": 1.0}
        orders = [order(1, 1, 50, release=1, receipt=6, bom=bom)]
        res, _, items = solve(orders, {"L1": 1000}, {"L1": 0.0}, {"L1": 0},
                              {"GLS": 50}, {"GLS": 0}, {}, 6,
                              dry_base={"GLS": 10}, dry_lead={"GLS": 2})
        # Weeks 1-2 deliver 10 each; week 3 brings the flexed 50.
        self.assertAlmostEqual(res[1].produced, 50)
        self.assertEqual(res[1].last_prod_week, 3)
        flat, _, _ = solve(orders, {"L1": 1000}, {"L1": 0.0}, {"L1": 0},
                           {"GLS": 50}, {"GLS": 0}, {}, 6)
        self.assertEqual(flat[1].last_prod_week, 1)   # without lead time: week 1


if __name__ == "__main__":
    unittest.main()
