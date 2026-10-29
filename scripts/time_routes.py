"""Time the app routes end to end. Usage: python3 scripts/time_routes.py [runs]"""
import sys
import time
import urllib.request

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
BASE = "http://localhost:3003/api/"
SCN = "63d3096f-235d-4be0-b85d-f13fe04053d4"
ROUTES = [
    "plan-grid?rollup=quarter",
    f"plan-grid?rollup=quarter&scenarioId={SCN}",
    "plan-grid?mode=stream&rollup=quarter&stream=sales",
    "supply",
    f"supply?source={SCN}",
    f"scenarios/{SCN}",
]
for route in ROUTES:
    times = []
    for _ in range(RUNS):
        t = time.time()
        with urllib.request.urlopen(BASE + route, timeout=180) as r:
            r.read()
            status = r.status
        times.append(time.time() - t)
    print(f"{route[:60]:60s} {status} " + " ".join(f"{x:5.2f}" for x in times))
