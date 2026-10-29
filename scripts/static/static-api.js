/*
 * Static (GitHub Pages) copy only. Replaces window.fetch for same-origin /api/*
 * calls with responses recorded from the live app (see record-snapshot.py), so
 * every page renders without a server or Snowflake. GETs return the recorded
 * response for the same path and query, else the closest recorded variant of
 * that path. Writes return 403: this copy is read-only.
 */
(function () {
  var script = document.currentScript;
  var base = (script && script.getAttribute("data-base")) || "";
  var original = window.fetch.bind(window);
  var READ_ONLY = "This is a read-only copy of the demo with recorded data, so changes can't be saved here.";
  var indexPromise = null;

  function index() {
    if (!indexPromise) {
      indexPromise = original(base + "/snapshot/index.json").then(function (r) { return r.json(); });
    }
    return indexPromise;
  }

  function reply(body, status) {
    return new Response(JSON.stringify(body), {
      status: status,
      headers: { "content-type": "application/json" },
    });
  }

  function pairs(search) {
    var out = [];
    new URLSearchParams(search).forEach(function (v, k) { out.push([k, v]); });
    out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
    return out;
  }

  function keyOf(path, list) {
    return list.length ? path + "?" + new URLSearchParams(list).toString() : path;
  }

  // Closest recorded variant: same path, most matching params, then fewest extras.
  function closest(keys, path, list) {
    var wanted = list.map(function (p) { return p[0] + "=" + p[1]; });
    var best = null, bestScore = -1, bestExtra = Infinity;
    keys.forEach(function (k) {
      var q = k.indexOf("?");
      if ((q < 0 ? k : k.slice(0, q)) !== path) return;
      var have = q < 0 ? [] : pairs(k.slice(q + 1)).map(function (p) { return p[0] + "=" + p[1]; });
      var score = have.filter(function (h) { return wanted.indexOf(h) > -1; }).length;
      var extra = have.length - score;
      if (score > bestScore || (score === bestScore && extra < bestExtra)) {
        best = k; bestScore = score; bestExtra = extra;
      }
    });
    return best;
  }

  window.fetch = function (input, init) {
    var raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    var url = new URL(raw, location.href);
    var path = url.pathname;
    if (base && path.indexOf(base + "/") === 0) path = path.slice(base.length);
    if (url.origin !== location.origin || path.indexOf("/api/") !== 0) return original(input, init);

    var method = ((init && init.method) || (typeof input === "object" && input.method) || "GET").toUpperCase();
    if (method !== "GET") return Promise.resolve(reply({ ok: false, error: READ_ONLY }, 403));

    var list = pairs(url.search);
    return index().then(function (files) {
      var keys = Object.keys(files);
      var key = files[keyOf(path, list)] ? keyOf(path, list) : closest(keys, path, list);
      if (!key) return reply({ error: "Not available in the read-only copy." }, 404);
      return original(base + "/snapshot/" + files[key]);
    });
  };
})();
