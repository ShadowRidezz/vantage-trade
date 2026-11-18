"""Deterministic market-structure detection.

Every detection records `confirmed_at`: the close time of the candle at which it first became knowable.
Replay and backtests only use a detection after that time, so nothing here leaks future information.
Later outcomes (filled, swept, invalidated) are separate timestamps, also never used before they happen.

ICT concepts are subjective. These are the rules this engine uses (all thresholds live in DEFAULTS):

- Swing high / low (fractal): candle high is greater than the `swing_k` highs before it and >= the
  `swing_k` highs after it (mirror for lows). Confirmed `swing_k` candles later.
- Fair Value Gap: three candles where candle 3's low is above candle 1's high (bullish) or candle 3's
  high is below candle 1's low (bearish), and the gap is at least `fvg_min_atr` x ATR. Filled when price
  trades through the far edge. The three candles must be consecutive: a set that spans a break in the data
  (e.g. the CME daily halt or a weekend) is a session opening gap, not an FVG.
- Break of Structure (BOS): a candle closes beyond the most recent confirmed swing in the direction of
  the current trend. Change of Character (CHoCH): the same break against the current trend.
- Market Structure Shift (MSS): a CHoCH whose breaking candle body is at least `mss_body_atr` x ATR
  (a displacement candle).
- Order Block: on a bullish BOS/CHoCH/MSS, the last bearish candle at or before the swing low that started
  the breaking leg (mirror for bearish). Invalidated when a candle closes beyond its far edge.
- Liquidity (EQH/EQL): two confirmed swing highs (lows) within `eq_tol_atr` x ATR of each other.
  Swept when a later candle trades beyond them.
- Liquidity sweep: a candle trades beyond a confirmed swing high (low) but closes back inside it.
- Support / Resistance: swing prices clustered within `sr_tol_atr` x ATR with at least `sr_min_touches`
  touches. Role is support if the latest close is above the level, resistance if below.
- Supply / Demand: a base candle followed, within `sd_bars` candles, by a move of at least `sd_move_atr` x ATR.
- Important candle: a displacement candle (body >= `displacement_atr` x ATR and >= 60% of its range) or a
  volume spike (volume >= `vol_spike` x the average of the previous `vol_n` candles).
- Premium / Discount: the latest dealing range between the last confirmed swing high and swing low;
  above 50% is premium, below is discount.
- Optimal Trade Entry (OTE): the 62%-79% retracement of the latest leg in the direction of the trend.
"""
from __future__ import annotations

import time

DEFAULTS = dict(swing_k=3, atr_n=14, fvg_min_atr=0.1, eq_tol_atr=0.1, sr_tol_atr=0.25, sr_min_touches=2,
                mss_body_atr=1.2, sweep_lookback=60, ob_lookback=10, sd_move_atr=2.0, sd_bars=3,
                displacement_atr=1.5, vol_spike=2.5, vol_n=20)

LABELS = {
    "fvg": "Fair Value Gap", "order_block": "Order Block", "liquidity": "Liquidity", "sweep": "Liquidity Sweep",
    "bos": "Break of Structure", "choch": "Change of Character", "mss": "Market Structure Shift",
    "sr": "Support / Resistance", "supply_demand": "Supply / Demand", "important": "Important Candle",
    "swing": "Swing Point", "premium_discount": "Premium / Discount", "ote": "Optimal Trade Entry",
}


def fmt(p):
    return "{:,.2f}".format(p)


def validate(bars):
    """Return (clean bars, issues). Bad candles are dropped, never repaired."""
    issues, clean, last = [], [], None
    for b in bars:
        vals = [b.get(k) for k in ("open", "high", "low", "close")]
        if any(v is None or v != v or v <= 0 for v in vals):
            issues.append("Dropped candle at %s: missing or non-positive price" % b.get("time"))
            continue
        if b["high"] < max(b["open"], b["close"]) or b["low"] > min(b["open"], b["close"]):
            issues.append("Dropped candle at %s: high/low inconsistent with open/close" % b["time"])
            continue
        if last is not None and b["time"] <= last:
            issues.append("Dropped candle at %s: duplicate or out of order" % b["time"])
            continue
        clean.append(b)
        last = b["time"]
    return clean, issues


def atr(bars, n):
    out, prev, trs = [], None, []
    for i, b in enumerate(bars):
        tr = b["high"] - b["low"] if i == 0 else max(b["high"] - b["low"], abs(b["high"] - bars[i - 1]["close"]),
                                                     abs(b["low"] - bars[i - 1]["close"]))
        if i < n:
            trs.append(tr)
            prev = sum(trs) / len(trs)
        else:
            prev = (prev * (n - 1) + tr) / n
        out.append(prev)
    return out


def ema(values, n):
    k, out, prev = 2 / (n + 1), [], None
    for i, x in enumerate(values):
        if i < n - 1:
            out.append(None)
        elif prev is None:
            prev = sum(values[:n]) / n
            out.append(prev)
        else:
            prev = x * k + prev * (1 - k)
            out.append(prev)
    return out


def find_swings(bars, k):
    out = []
    for i in range(k, len(bars) - k):
        h, l = bars[i]["high"], bars[i]["low"]
        if all(h > bars[j]["high"] for j in range(i - k, i)) and all(h >= bars[j]["high"] for j in range(i + 1, i + k + 1)):
            out.append({"i": i, "ci": i + k, "side": "high", "price": h})
        if all(l < bars[j]["low"] for j in range(i - k, i)) and all(l <= bars[j]["low"] for j in range(i + 1, i + k + 1)):
            out.append({"i": i, "ci": i + k, "side": "low", "price": l})
    out.sort(key=lambda s: (s["ci"], s["i"]))
    return out


class Ctx:
    def __init__(self, bars, cfg, symbol, tf):
        self.b, self.cfg, self.symbol, self.tf = bars, cfg, symbol, tf
        self.t = [x["time"] for x in bars]
        self.atr = atr(bars, cfg["atr_n"])
        diffs = sorted(self.t[i + 1] - self.t[i] for i in range(len(self.t) - 1))
        self.step = diffs[len(diffs) // 2] if diffs else 0  # typical candle spacing
        self.dets, self.ids = [], set()

    def add(self, kind, direction, i0, i1, ci, top, bottom, reason, conditions, extra=None, candles=None):
        t1 = self.t[i1]
        d = {"id": "%s:%s:%s:%s:%s:%.4f" % (self.symbol, self.tf, kind, direction or "-", t1, (top + bottom) / 2),
             "kind": kind, "label": LABELS[kind], "dir": direction, "t0": self.t[i0], "t1": t1,
             "confirmed_at": self.t[ci], "top": top, "bottom": bottom,
             "candles": candles if candles is not None else [self.t[j] for j in range(i0, i1 + 1)],
             "reason": reason, "conditions": conditions}
        if d["id"] in self.ids:  # e.g. two breaks pointing at the same order-block candle: same zone, keep the first
            return None
        if extra:
            d.update(extra)
        self.ids.add(d["id"])
        self.dets.append(d)
        return d


def _first(rng, pred):
    for j in rng:
        if pred(j):
            return j
    return None


def detect_fvg(c):
    b, cfg, n = c.b, c.cfg, len(c.b)
    for i in range(2, n):
        if c.step and c.t[i] - c.t[i - 2] > 2.5 * c.step:  # spans a data break: session gap, not an FVG
            continue
        a, z, atr_i = b[i - 2], b[i], c.atr[i]
        for direction, gap, bottom, top in (("bull", z["low"] - a["high"], a["high"], z["low"]),
                                            ("bear", a["low"] - z["high"], z["high"], a["low"])):
            if gap <= 0:
                continue
            ok = gap >= cfg["fvg_min_atr"] * atr_i
            if not ok:
                continue
            if direction == "bull":
                touched = _first(range(i + 1, n), lambda j: b[j]["low"] <= top)
                filled = _first(range(touched or i + 1, n), lambda j: b[j]["low"] <= bottom) if touched is not None else None
                why = "Candle 3 low %s is above candle 1 high %s, leaving a %s-point gap (%.2f x ATR)." % (
                    fmt(z["low"]), fmt(a["high"]), fmt(gap), gap / atr_i)
            else:
                touched = _first(range(i + 1, n), lambda j: b[j]["high"] >= bottom)
                filled = _first(range(touched or i + 1, n), lambda j: b[j]["high"] >= top) if touched is not None else None
                why = "Candle 3 high %s is below candle 1 low %s, leaving a %s-point gap (%.2f x ATR)." % (
                    fmt(z["high"]), fmt(a["low"]), fmt(gap), gap / atr_i)
            c.add("fvg", direction, i - 2, i, i, top, bottom, why,
                  [{"name": "Three-candle gap exists", "met": True, "value": fmt(gap)},
                   {"name": "Gap >= %.2f x ATR" % cfg["fvg_min_atr"], "met": True, "value": "%.2f x ATR" % (gap / atr_i)}],
                  {"touched_at": c.t[touched] if touched is not None else None,
                   "filled_at": c.t[filled] if filled is not None else None})


def detect_structure(c, swings):
    """BOS / CHoCH / MSS and their order blocks. Also returns the trend in force after each candle."""
    b, cfg, n = c.b, c.cfg, len(c.b)
    by_ci = {}
    for s in swings:
        by_ci.setdefault(s["ci"], []).append(s)
    last = {"high": None, "low": None}
    trend, trend_series = None, []
    for i in range(n):
        close = b[i]["close"]
        for side, direction in (("high", "bull"), ("low", "bear")):
            s = last[side]
            if s is None or s.get("broken"):
                continue
            broke = close > s["price"] if side == "high" else close < s["price"]
            if not broke:
                continue
            s["broken"] = True
            against = trend is not None and trend != direction
            body = abs(close - b[i]["open"])
            disp = body >= cfg["mss_body_atr"] * c.atr[i]
            kind = ("mss" if disp else "choch") if against else "bos"
            word = "above swing high" if side == "high" else "below swing low"
            why = "Candle closed at %s, %s %s from %s. Prior trend: %s." % (
                fmt(close), word, fmt(s["price"]), _ago(c, s["i"]), trend or "undetermined")
            if kind == "mss":
                why += " Breaking candle body is %.2f x ATR (displacement)." % (body / c.atr[i])
            conds = [{"name": "Close beyond confirmed swing %s" % side, "met": True, "value": fmt(close)},
                     {"name": "Break against prior trend", "met": against, "value": trend or "none"}]
            if against:
                conds.append({"name": "Displacement body >= %.1f x ATR" % cfg["mss_body_atr"], "met": disp,
                              "value": "%.2f x ATR" % (body / c.atr[i])})
            c.add(kind, direction, s["i"], i, i, s["price"], s["price"], why, conds,
                  {"level": s["price"]}, candles=[c.t[s["i"]], c.t[i]])
            # Order block: last opposite candle at/before the swing that started the breaking leg.
            leg = last["low"] if direction == "bull" else last["high"]
            if leg is not None:
                opp = (lambda j: b[j]["close"] < b[j]["open"]) if direction == "bull" else (lambda j: b[j]["close"] > b[j]["open"])
                j = _first(range(leg["i"], max(-1, leg["i"] - cfg["ob_lookback"] - 1), -1), opp)
                if j is not None:
                    top, bottom = b[j]["high"], b[j]["low"]
                    if direction == "bull":
                        inv = _first(range(i + 1, n), lambda k: b[k]["close"] < bottom)
                        tch = _first(range(i + 1, n), lambda k: b[k]["low"] <= top)
                    else:
                        inv = _first(range(i + 1, n), lambda k: b[k]["close"] > top)
                        tch = _first(range(i + 1, n), lambda k: b[k]["high"] >= bottom)
                    c.add("order_block", direction, j, j, i, top, bottom,
                          "Last %s candle before the leg that produced the %s at %s." % (
                              "bearish" if direction == "bull" else "bullish", LABELS[kind], fmt(s["price"])),
                          [{"name": "Opposite-colour candle at leg origin", "met": True, "value": _ago(c, j)},
                           {"name": "Followed by %s" % LABELS[kind], "met": True, "value": fmt(close)}],
                          {"touched_at": c.t[tch] if tch is not None else None,
                           "invalidated_at": c.t[inv] if inv is not None else None})
            trend = direction
        for s in by_ci.get(i, []):
            last[s["side"]] = dict(s)
        trend_series.append(trend)
    return trend_series


def detect_liquidity(c, swings):
    b, cfg, n = c.b, c.cfg, len(c.b)
    seen = {"high": [], "low": []}
    for s in swings:
        tol = cfg["eq_tol_atr"] * c.atr[s["ci"]]
        for p in seen[s["side"]][-10:]:
            if abs(p["price"] - s["price"]) <= tol and p["i"] != s["i"]:
                top, bottom = max(p["price"], s["price"]), min(p["price"], s["price"])
                if s["side"] == "high":
                    swept = _first(range(s["ci"] + 1, n), lambda j: b[j]["high"] > top)
                    direction, name = "bear", "Buy-side liquidity (equal highs)"
                else:
                    swept = _first(range(s["ci"] + 1, n), lambda j: b[j]["low"] < bottom)
                    direction, name = "bull", "Sell-side liquidity (equal lows)"
                c.add("liquidity", direction, p["i"], s["i"], s["ci"], top, bottom,
                      "%s: swings at %s and %s are within %s points (tolerance %.2f x ATR)." % (
                          name, fmt(p["price"]), fmt(s["price"]), fmt(abs(p["price"] - s["price"])), cfg["eq_tol_atr"]),
                      [{"name": "Two confirmed swing %ss" % s["side"], "met": True, "value": "%s / %s" % (fmt(p["price"]), fmt(s["price"]))},
                       {"name": "Within %.2f x ATR" % cfg["eq_tol_atr"], "met": True, "value": fmt(abs(p["price"] - s["price"]))}],
                      {"name": name, "swept_at": c.t[swept] if swept is not None else None},
                      candles=[c.t[p["i"]], c.t[s["i"]]])
                break
        seen[s["side"]].append(s)
        # Sweep: first candle that trades beyond this swing, closing back inside.
        rng = range(s["ci"] + 1, min(n, s["ci"] + 1 + cfg["sweep_lookback"]))
        if s["side"] == "high":
            k = _first(rng, lambda j: b[j]["high"] > s["price"])
            if k is not None and b[k]["close"] < s["price"]:
                c.add("sweep", "bear", s["i"], k, k, b[k]["high"], s["price"],
                      "Candle traded to %s, above the swing high %s, then closed back below at %s." % (
                          fmt(b[k]["high"]), fmt(s["price"]), fmt(b[k]["close"])),
                      [{"name": "Wick above confirmed swing high", "met": True, "value": fmt(b[k]["high"])},
                       {"name": "Close back below the level", "met": True, "value": fmt(b[k]["close"])}],
                      {"level": s["price"], "extreme": b[k]["high"]}, candles=[c.t[s["i"]], c.t[k]])
        else:
            k = _first(rng, lambda j: b[j]["low"] < s["price"])
            if k is not None and b[k]["close"] > s["price"]:
                c.add("sweep", "bull", s["i"], k, k, s["price"], b[k]["low"],
                      "Candle traded to %s, below the swing low %s, then closed back above at %s." % (
                          fmt(b[k]["low"]), fmt(s["price"]), fmt(b[k]["close"])),
                      [{"name": "Wick below confirmed swing low", "met": True, "value": fmt(b[k]["low"])},
                       {"name": "Close back above the level", "met": True, "value": fmt(b[k]["close"])}],
                      {"level": s["price"], "extreme": b[k]["low"]}, candles=[c.t[s["i"]], c.t[k]])


def detect_sr(c, swings):
    cfg, clusters = c.cfg, []
    for s in swings:
        tol = cfg["sr_tol_atr"] * c.atr[s["ci"]]
        for cl in clusters:
            if abs(cl["price"] - s["price"]) <= tol:
                cl["touches"].append(s)
                cl["price"] = sum(x["price"] for x in cl["touches"]) / len(cl["touches"])
                break
        else:
            clusters.append({"price": s["price"], "touches": [s]})
    last_close = c.b[-1]["close"]
    for cl in clusters:
        t = sorted(cl["touches"], key=lambda x: x["ci"])
        if len(t) < cfg["sr_min_touches"]:
            continue
        role = "support" if last_close >= cl["price"] else "resistance"
        c.add("sr", "bull" if role == "support" else "bear", t[0]["i"], t[-1]["i"], t[cfg["sr_min_touches"] - 1]["ci"],
              cl["price"], cl["price"],
              "%d swing points cluster around %s (within %.2f x ATR). Latest close %s is %s it, so it acts as %s." % (
                  len(t), fmt(cl["price"]), cfg["sr_tol_atr"], fmt(last_close), "above" if role == "support" else "below", role),
              [{"name": "At least %d touches" % cfg["sr_min_touches"], "met": True, "value": str(len(t))}],
              {"touches": len(t), "role": role}, candles=[c.t[x["i"]] for x in t])


def detect_supply_demand(c):
    b, cfg, n = c.b, c.cfg, len(c.b)
    last = {"bull": -99, "bear": -99}
    for i in range(1, n - cfg["sd_bars"]):
        end = i + cfg["sd_bars"]
        move = b[end]["close"] - b[i]["close"]
        need = cfg["sd_move_atr"] * c.atr[i]
        if abs(move) < need:
            continue
        direction = "bull" if move > 0 else "bear"
        if i - last[direction] < 5:
            continue
        last[direction] = i
        top, bottom = b[i]["high"], b[i]["low"]
        c.add("supply_demand", direction, i, i, end, top, bottom,
              "%s zone: price moved %s points (%.1f x ATR) %s within %d candles after this base candle." % (
                  "Demand" if direction == "bull" else "Supply", fmt(abs(move)), abs(move) / c.atr[i],
                  "up" if direction == "bull" else "down", cfg["sd_bars"]),
              [{"name": "Move >= %.1f x ATR within %d candles" % (cfg["sd_move_atr"], cfg["sd_bars"]), "met": True,
                "value": "%.1f x ATR" % (abs(move) / c.atr[i])}],
              {"name": "Demand" if direction == "bull" else "Supply"})


def detect_important(c):
    b, cfg = c.b, c.cfg
    vols = [x["volume"] for x in b]
    for i in range(1, len(b)):
        x = b[i]
        body, rng = abs(x["close"] - x["open"]), x["high"] - x["low"]
        disp = body >= cfg["displacement_atr"] * c.atr[i] and rng > 0 and body / rng >= 0.6
        prior = vols[max(0, i - cfg["vol_n"]):i]
        avg = sum(prior) / len(prior) if prior else 0
        spike = avg > 0 and i >= cfg["vol_n"] and vols[i] >= cfg["vol_spike"] * avg
        if not (disp or spike):
            continue
        parts = []
        if disp:
            parts.append("body %s is %.1f x ATR (displacement)" % (fmt(body), body / c.atr[i]))
        if spike:
            parts.append("volume %s is %.1f x the %d-candle average" % ("{:,}".format(int(vols[i])), vols[i] / avg, cfg["vol_n"]))
        c.add("important", "bull" if x["close"] >= x["open"] else "bear", i, i, i, x["high"], x["low"],
              "Important candle: " + "; ".join(parts) + ".",
              [{"name": "Displacement body", "met": disp, "value": "%.1f x ATR" % (body / c.atr[i])},
               {"name": "Volume spike", "met": spike, "value": ("%.1f x avg" % (vols[i] / avg)) if avg else "no volume"}])


def detect_swing_marks(c, swings):
    for s in swings[-40:]:
        c.add("swing", "bear" if s["side"] == "high" else "bull", s["i"], s["i"], s["ci"], s["price"], s["price"],
              "Swing %s: %s is the extreme of the %d candles on each side; confirmed %d candles later." % (
                  s["side"], fmt(s["price"]), c.cfg["swing_k"], c.cfg["swing_k"]),
              [{"name": "Fractal with %d candles each side" % c.cfg["swing_k"], "met": True, "value": fmt(s["price"])}],
              {"side": s["side"]})


def detect_pd(c, swings, trend):
    highs = [s for s in swings if s["side"] == "high"]
    lows = [s for s in swings if s["side"] == "low"]
    if not highs or not lows:
        return None
    h, l = highs[-1], lows[-1]
    if h["price"] <= l["price"]:
        return None
    eq = (h["price"] + l["price"]) / 2
    close = c.b[-1]["close"]
    zone = "premium" if close > eq else "discount"
    i0, i1 = min(h["i"], l["i"]), max(h["i"], l["i"])
    ci = max(h["ci"], l["ci"])
    c.add("premium_discount", None, i0, len(c.b) - 1, ci, h["price"], l["price"],
          "Dealing range %s - %s (latest confirmed swings). Equilibrium %s. Latest close %s is in %s." % (
              fmt(l["price"]), fmt(h["price"]), fmt(eq), fmt(close), zone),
          [{"name": "Confirmed swing high and low", "met": True, "value": "%s / %s" % (fmt(h["price"]), fmt(l["price"]))}],
          {"equilibrium": eq, "zone": zone}, candles=[c.t[h["i"]], c.t[l["i"]]])
    rng = h["price"] - l["price"]
    if trend == "bull" and l["i"] < h["i"]:
        top, bottom, d = h["price"] - 0.62 * rng, h["price"] - 0.79 * rng, "bull"
    elif trend == "bear" and h["i"] < l["i"]:
        top, bottom, d = l["price"] + 0.79 * rng, l["price"] + 0.62 * rng, "bear"
    else:
        return {"equilibrium": eq, "zone": zone, "high": h["price"], "low": l["price"]}
    c.add("ote", d, i0, len(c.b) - 1, ci, top, bottom,
          "OTE: 62%%-79%% retracement of the %s leg %s -> %s." % (
              "up" if d == "bull" else "down", fmt(l["price"] if d == "bull" else h["price"]), fmt(h["price"] if d == "bull" else l["price"])),
          [{"name": "Trend direction matches leg", "met": True, "value": trend},
           {"name": "Price inside OTE now", "met": bottom <= close <= top, "value": fmt(close)}],
          candles=[c.t[h["i"]], c.t[l["i"]]])
    return {"equilibrium": eq, "zone": zone, "high": h["price"], "low": l["price"]}


def _ago(c, i):
    return "%d candles earlier" % (len(c.b) - 1 - i) if i < len(c.b) - 1 else "the latest candle"


def run(bars, symbol="", tf="", cfg=None, on_step=None):
    """Run the full pipeline. `on_step(name, detail)` is called after each stage actually completes."""
    cfg = dict(DEFAULTS, **(cfg or {}))
    steps = []

    def step(name, detail, t0):
        s = {"name": name, "detail": detail, "ms": round((time.perf_counter() - t0) * 1000, 1), "at": time.time()}
        steps.append(s)
        if on_step:
            on_step(s)

    t0 = time.perf_counter()
    bars, issues = validate(bars)
    step("Market data validated", "%d candles, %d dropped" % (len(bars), len(issues)), t0)
    if len(bars) < 2 * cfg["swing_k"] + 3:
        return {"steps": steps, "issues": issues, "detections": [], "summary": None, "trend": [], "swings": [], "bars": len(bars)}
    c = Ctx(bars, cfg, symbol, tf)
    t0 = time.perf_counter()
    sw = find_swings(bars, cfg["swing_k"])
    detect_swing_marks(c, sw)
    step("Swing points evaluated", "%d swings" % len(sw), t0)
    t0 = time.perf_counter()
    trend = detect_structure(c, sw)
    step("Market structure evaluated", "%d BOS / CHoCH / MSS, %d order blocks" % (
        sum(d["kind"] in ("bos", "choch", "mss") for d in c.dets), sum(d["kind"] == "order_block" for d in c.dets)), t0)
    t0 = time.perf_counter()
    detect_liquidity(c, sw)
    step("Liquidity zones evaluated", "%d zones, %d sweeps" % (
        sum(d["kind"] == "liquidity" for d in c.dets), sum(d["kind"] == "sweep" for d in c.dets)), t0)
    t0 = time.perf_counter()
    detect_fvg(c)
    step("Fair Value Gaps evaluated", "%d gaps" % sum(d["kind"] == "fvg" for d in c.dets), t0)
    t0 = time.perf_counter()
    detect_sr(c, sw)
    detect_supply_demand(c)
    step("Support, resistance, supply and demand evaluated", "%d levels, %d zones" % (
        sum(d["kind"] == "sr" for d in c.dets), sum(d["kind"] == "supply_demand" for d in c.dets)), t0)
    t0 = time.perf_counter()
    detect_important(c)
    pd = detect_pd(c, sw, trend[-1] if trend else None)
    step("Important candles and premium/discount evaluated", "%d candles" % sum(d["kind"] == "important" for d in c.dets), t0)
    return {"steps": steps, "issues": issues, "detections": c.dets, "trend": trend, "swings": sw, "bars": len(bars),
            "summary": summarize(c, trend, pd), "atr": c.atr}


def summarize(c, trend, pd):
    b = c.b
    last = b[-1]
    struct = [d for d in c.dets if d["kind"] in ("bos", "choch", "mss")]
    closes = [x["close"] for x in b]
    e20, e50 = ema(closes, 20)[-1], ema(closes, 50)[-1]
    bias = trend[-1] if trend else None
    facts = ["Latest closed candle: O %s H %s L %s C %s." % (fmt(last["open"]), fmt(last["high"]), fmt(last["low"]), fmt(last["close"])),
             "ATR(%d): %s points." % (c.cfg["atr_n"], fmt(c.atr[-1]))]
    if struct:
        s = struct[-1]
        facts.append("Most recent structure event: %s (%s) at %s, %s. Latest close %s is %s that level." % (
            s["label"], s["dir"], fmt(s["level"]), _ago(c, c.t.index(s["t1"])), fmt(last["close"]),
            "above" if last["close"] > s["level"] else "below" if last["close"] < s["level"] else "at"))
    else:
        facts.append("No structure break detected in the loaded data.")
    if e20 is not None and e50 is not None:
        facts.append("EMA 20 %s is %s EMA 50 %s." % (fmt(e20), "above" if e20 > e50 else "below", fmt(e50)))
    if pd:
        facts.append("Price is in %s of the range %s - %s (equilibrium %s)." % (pd["zone"], fmt(pd["low"]), fmt(pd["high"]), fmt(pd["equilibrium"])))
    open_fvg = [d for d in c.dets if d["kind"] == "fvg" and d["filled_at"] is None]
    facts.append("%d unfilled Fair Value Gaps in loaded data." % len(open_fvg))
    highs = [s for s in find_swings(b, c.cfg["swing_k"]) if s["side"] == "high"]
    lows = [s for s in find_swings(b, c.cfg["swing_k"]) if s["side"] == "low"]
    invalidation = None
    if bias == "bull" and lows:
        invalidation = {"price": lows[-1]["price"], "text": "A close below the last confirmed swing low %s would break bullish structure." % fmt(lows[-1]["price"])}
    elif bias == "bear" and highs:
        invalidation = {"price": highs[-1]["price"], "text": "A close above the last confirmed swing high %s would break bearish structure." % fmt(highs[-1]["price"])}
    return {"bias": bias or "undetermined", "close": last["close"], "time": last["time"], "atr": c.atr[-1],
            "ema20": e20, "ema50": e50, "pd": pd, "facts": facts, "invalidation": invalidation,
            "counts": {k: sum(d["kind"] == k for d in c.dets) for k in LABELS}}
