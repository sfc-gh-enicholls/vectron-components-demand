"""Record the app's API responses for the static (GitHub Pages) copy.

Visits every page on a running dev server with live Snowflake data and saves each
GET /api/* JSON response to scripts/static/snapshot/, keyed by path plus sorted
query string. The static build's fetch shim (static-api.js) serves these files.

Usage, from the app root with `npm run dev` running:
    python3 scripts/static/record-snapshot.py [http://localhost:3003]
"""
import hashlib
import json
import pathlib
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3003"
OUT = pathlib.Path(__file__).resolve().parent / "snapshot"
# The copy is public: real Snowflake user names in audit fields become a demo label.
USER_FIELDS = {"createdBy", "editedBy", "updatedBy", "submittedBy", "approvedBy", "decidedBy",
               "requestedBy", "reviewedBy", "CREATED_BY", "EDITED_BY", "UPDATED_BY",
               "SUBMITTED_BY", "APPROVED_BY", "DECIDED_BY", "REQUESTED_BY", "REVIEWED_BY"}
DEMO_USER = "DEMO_PLANNER"
ROUTES = ["/", "/sensing", "/plan", "/hierarchy", "/review", "/baseline", "/accuracy",
          "/calloffs", "/ihs", "/service", "/value", "/npd", "/scenarios", "/supply", "/approvals",
          "/agent", "/formulas"]


def key_of(url: str) -> str:
    """Same rule as static-api.js: path plus query params sorted by name then value."""
    parts = urlsplit(url)
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return parts.path + ("?" + query if query else "")


def scrub(value):
    """Replace user names in audit fields, recursively."""
    if isinstance(value, dict):
        return {k: (DEMO_USER if k in USER_FIELDS and isinstance(v, str) and v else scrub(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    index: dict[str, str] = {}

    def on_response(response):
        request = response.request
        if request.method != "GET" or "/api/" not in response.url or response.status != 200:
            return
        try:
            body = response.json()
        except Exception:
            return
        key = key_of(response.url)
        name = hashlib.sha1(key.encode()).hexdigest()[:16] + ".json"
        (OUT / name).write_text(json.dumps(scrub(body), separators=(",", ":")))
        index[key] = name

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.on("response", on_response)
        for route in ROUTES:
            page.goto(BASE + route, wait_until="networkidle", timeout=240000)
            page.wait_for_timeout(2500)
            if route == "/review":
                # Series detail loads on click, so fetch every worklist row the page lists.
                page.evaluate("""async () => {
                  const d = await (await fetch('/api/review')).json();
                  for (const e of d.worklist.slice(0, 80)) {
                    await fetch('/api/review?series=' + encodeURIComponent(e.SERIES_ID));
                  }
                }""")
                page.wait_for_timeout(1000)
            print(f"{route:12} {len(index)} responses so far")
        browser.close()

    (OUT / "index.json").write_text(json.dumps(dict(sorted(index.items())), indent=1))
    size = sum(f.stat().st_size for f in OUT.glob("*.json"))
    print(f"Saved {len(index)} responses, {size / 1e6:.1f} MB, to {OUT}")


if __name__ == "__main__":
    main()
