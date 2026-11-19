"""Strategies, the historical simulator and evidence-based diagnostics.

The simulator walks candles in order. A signal can only act from the candle after the detection that produced
it was confirmed. Intrabar order is unknown, so when stop and target are both inside one candle the stop wins,
and a limit entry's own candle is only checked against the stop (never the target). Results are simulated.
"""
from __future__ import annotations

import bisect

import analysis as A
import market as M

STRATEGIES = {
    "fvg_continuation": {
        "name": "FVG Continuation",
        "description": "With the structure trend, place a limit order at the near edge of a new Fair Value Gap. "
                       "Stop beyond the far edge plus a buffer, target a fixed R multiple.",
        "params": {"rr": 3.0, "stop_buffer_ticks": 12, "max_wait": 20, "max_hold": 60, "trend_filter": True,
                   "breakeven_r": 0.0, "direction": "both", "swing_k": 3, "fvg_min_atr": 0.25,
                   "htf_filter": True, "session": "rth", "need_break": 3},
    },
    "sweep_reversal": {
        "name": "Liquidity Sweep Reversal",
        "description": "After a candle sweeps a confirmed swing and closes back inside, enter at the next open in the "
                       "reversal direction. Stop beyond the sweep extreme plus a buffer, target a fixed R multiple.",
        "params": {"rr": 3.0, "stop_buffer_ticks": 4, "max_wait": 1, "max_hold": 60, "trend_filter": False,
                   "breakeven_r": 0.0, "direction": "both", "swing_k": 3, "fvg_min_atr": 0.25,
                   "htf_filter": True, "confirm_break": 3},
    },
}
_PATTERN_PARAMS = {"rr": 2.0, "stop_buffer_ticks": 4, "max_wait": 3, "max_hold": 60, "trend_filter": False, "breakeven_r": 0.0,
                   "direction": "both", "swing_k": 3, "fvg_min_atr": 0.25, "htf_filter": True, "session": "rth"}
for _k, _n, _d in (
    ("engulfing", "Engulfing Candle", "A candle whose body swallows the previous opposite candle's body (and is at least half an ATR). "
                                      "Enter at the next open; stop beyond the two candles."),
    ("pin_bar", "Pin Bar (Hammer / Shooting Star)", "A candle with a long rejection wick (at least twice the body and 60% of the range). "
                                                    "Enter at the next open the way the wick rejected; stop beyond the wick."),
    ("star", "Morning / Evening Star", "Three candles: a strong candle, a small pause candle, then a candle closing past the middle of the first. "
                                       "Enter at the next open; stop beyond the three candles."),
    ("inside_bar", "Inside Bar Breakout", "A candle inside the previous (mother) candle. With the 20/50 EMA trend, a stop order at the mother "
                                          "candle's high (long) or low (short); stop at the other side of the mother candle."),
    ("ema_pullback", "EMA Pullback", "EMA 20 above EMA 50 (below for shorts): price dips to the EMA 20 and closes back above it on a "
                                     "candle in the trend direction. Enter at the next open; stop beyond the last two candles."),
    ("orb", "Opening Range Breakout", "The 9:30-9:45 New York range: the first candle that closes outside it before noon. Enter at the "
                                      "next open; stop at the other side of the range. One trade per day. Intraday charts only."),
    ("order_block", "Order Block Retest", "After a structure break, a limit order at the edge of its order block (the last opposite candle "
                                          "before the move). Stop beyond the far side of the block."),
):
    STRATEGIES[_k] = {"name": _n, "description": _d, "params": dict(_PATTERN_PARAMS)}
# The first rules (v1). On 60 days of MNQ/NQ/ES/MES 5m+15m both lost money (FVG -0.04R, sweep -0.15R per trade);
# the rules above were the only ones that were positive on those futures and better than these on 8 unseen stocks.
V1_PARAMS = {
    "fvg_continuation": {"rr": 2.0, "stop_buffer_ticks": 4, "max_wait": 20, "max_hold": 60, "trend_filter": True,
                         "breakeven_r": 0.0, "direction": "both", "swing_k": 3, "fvg_min_atr": 0.25},
    "sweep_reversal": {"rr": 2.0, "stop_buffer_ticks": 4, "max_wait": 1, "max_hold": 60, "trend_filter": False,
                       "breakeven_r": 0.0, "direction": "both", "swing_k": 3, "fvg_min_atr": 0.25},
}
STRUCTURE = ("bos", "choch", "mss")
RTH = (9 * 60 + 35, 15 * 60 + 30)  # New York time; the opening 5 minutes and the last half hour are left out

PARAM_DOCS = {
    "rr": "Target as a multiple of the initial risk", "stop_buffer_ticks": "Ticks beyond the zone for the stop",
    "max_wait": "Candles a pending signal stays valid", "max_hold": "Candles before a time exit",
    "trend_filter": "Only trade in the direction of the structure trend", "breakeven_r": "Move stop to entry after this many R (0 = off)",
    "direction": "both, long or short", "swing_k": "Swing fractal size", "fvg_min_atr": "Minimum FVG size in ATR",
    "htf_filter": "Only trade when the next timeframe up (1H for intraday) has the same structure trend",
    "session": "rth = only signals between 9:35 and 15:30 New York time (intraday charts); all = any time",
    "need_break": "Only FVGs that formed within this many candles of a structure break the same way (0 = off)",
    "confirm_break": "After a sweep, wait up to this many candles for structure to break the same way, then enter (0 = enter at once)",
}


def analysis_cfg(params):
    return {"swing_k": int(params.get("swing_k", 3)), "fvg_min_atr": float(params.get("fvg_min_atr", 0.25))}


def _idx(bars):
    return {b["time"]: i for i, b in enumerate(bars)}


def _step(bars):
    ds = sorted(b["time"] - a["time"] for a, b in zip(bars[-300:], bars[-299:]))
    return ds[len(ds) // 2] if ds else 0


def htf_trend(bars, step):
    """Structure trend of the next timeframe up, built from these candles. A higher candle only counts once it has
    closed, so this never looks ahead. Returns f(time) -> 'bull' / 'bear' / None, or None above 1H charts."""
    size = 3600 if step < 3600 else 14400 if step < 14400 else 0
    if step <= 0 or not size or size % step:
        return None
    hb = M.aggregate(bars, size // step, step)
    tr = A.run(hb)["trend"] if len(hb) > 10 else []
    closes = [h["time"] + size for h in A.validate(hb)[0]][:len(tr)]

    def at(t):
        i = bisect.bisect_right(closes, t) - 1
        return tr[i] if i >= 0 else None
    return at


def _memo(cache, name, fn):
    if name not in cache:
        cache[name] = fn()
    return cache[name]


def _pattern_setups(bars, key, cache, step):
    """Raw candle-pattern setups: dicts with ci (deciding candle), sd (+1/-1), stop (pattern extreme), name, and an
    optional entry type/price. Each uses only candles up to and including ci."""
    atr = _memo(cache, "atr", lambda: A.atr(bars, 14))
    closes = [b["close"] for b in bars]
    e20 = _memo(cache, "ema20", lambda: A.ema(closes, 20))
    e50 = _memo(cache, "ema50", lambda: A.ema(closes, 50))
    out = []
    if key == "orb":
        if not 0 < step < 3600:
            return out
        ranges, done = {}, set()
        for i, b in enumerate(bars):
            m, day = M.et_minutes(b["time"]), M.et_day(b["time"])
            if 570 <= m and m + step // 60 <= 585:  # candle inside 9:30-9:45
                hi, lo = ranges.get(day, (None, None))
                ranges[day] = (max(hi, b["high"]) if hi is not None else b["high"], min(lo, b["low"]) if lo is not None else b["low"])
            elif 585 <= m < 720 and day in ranges and day not in done:
                hi, lo = ranges[day]
                if b["close"] > hi or b["close"] < lo:
                    done.add(day)
                    sd = 1 if b["close"] > hi else -1
                    out.append({"ci": i, "sd": sd, "stop": lo if sd == 1 else hi,
                                "name": "close %s the opening range %s-%s" % ("above" if sd == 1 else "below", A.fmt(lo), A.fmt(hi))})
        return out
    for i in range(2, len(bars)):
        b, p, q, a = bars[i], bars[i - 1], bars[i - 2], atr[i]
        if not a:
            continue
        o, c, h, l = b["open"], b["close"], b["high"], b["low"]
        body, rng = abs(c - o), h - l
        if key == "engulfing":
            pb = abs(p["close"] - p["open"])
            if c > o and p["close"] < p["open"] and c >= p["open"] and o <= p["close"] and body >= max(pb, 0.5 * a):
                out.append({"ci": i, "sd": 1, "stop": min(l, p["low"]), "name": "Bullish engulfing"})
            elif c < o and p["close"] > p["open"] and c <= p["open"] and o >= p["close"] and body >= max(pb, 0.5 * a):
                out.append({"ci": i, "sd": -1, "stop": max(h, p["high"]), "name": "Bearish engulfing"})
        elif key == "pin_bar" and rng >= 0.8 * a:
            lw, uw = min(o, c) - l, h - max(o, c)
            if lw >= 2 * body and lw >= 0.6 * rng:
                out.append({"ci": i, "sd": 1, "stop": l, "name": "Hammer (bullish pin bar)"})
            elif uw >= 2 * body and uw >= 0.6 * rng:
                out.append({"ci": i, "sd": -1, "stop": h, "name": "Shooting star (bearish pin bar)"})
        elif key == "star":
            qb, pb = abs(q["close"] - q["open"]), abs(p["close"] - p["open"])
            mid = (q["open"] + q["close"]) / 2
            if qb >= 0.6 * a and pb <= 0.3 * qb:
                if q["close"] < q["open"] and c > o and c > mid:
                    out.append({"ci": i, "sd": 1, "stop": min(l, p["low"], q["low"]), "name": "Morning star"})
                elif q["close"] > q["open"] and c < o and c < mid:
                    out.append({"ci": i, "sd": -1, "stop": max(h, p["high"], q["high"]), "name": "Evening star"})
        elif key == "inside_bar" and e50[i] is not None:
            if h < p["high"] and l > p["low"] and p["high"] - p["low"] >= 0.8 * a:
                sd = 1 if e20[i] > e50[i] else -1
                out.append({"ci": i, "sd": sd, "stop": p["low"] if sd == 1 else p["high"], "type": "stop",
                            "price": p["high"] if sd == 1 else p["low"], "name": "Inside bar, breakout %s" % ("up" if sd == 1 else "down")})
        elif key == "ema_pullback" and e50[i] is not None:
            if e20[i] > e50[i] and l <= e20[i] < c and c > o and p["close"] > e20[i - 1]:
                out.append({"ci": i, "sd": 1, "stop": min(l, p["low"]), "name": "Pullback to the rising EMA 20"})
            elif e20[i] < e50[i] and h >= e20[i] > c and c < o and p["close"] < e20[i - 1]:
                out.append({"ci": i, "sd": -1, "stop": max(h, p["high"]), "name": "Pullback to the falling EMA 20"})
    return out


def _at_level(bars, an, cache, ci, sd, look=100, tol=0.3):
    """Did candle ci test a confirmed swing low (long) / high (short) from the last `look` candles and close back on the
    right side of it? i.e. the pattern formed at support / resistance. Uses only swings confirmed by candle ci."""
    atr = _memo(cache, "atr", lambda: A.atr(bars, 14))
    side = _memo(cache, "swings:%d:%d" % (id(an), sd),
                 lambda: [(s["ci"], s["i"], s["price"]) for s in an.get("swings", []) if s["side"] == ("low" if sd == 1 else "high")])
    b, tol = bars[ci], tol * atr[ci]
    for sci, si, p in side:
        if sci > ci:
            break
        if si >= ci - look and (b["low"] <= p + tol and b["close"] > p if sd == 1 else b["high"] >= p - tol and b["close"] < p):
            return True
    return False


def signals(bars, an, key, params, tick, cache=None):
    """Every entry order the strategy would have placed. `cache` (a dict) may be shared between calls on the same
    candles to avoid recomputing the 1H trend and indicators (the AI Lab does this)."""
    cache = {} if cache is None else cache
    ix, trend, out = _idx(bars), an["trend"], []
    want = {"both": (1, -1), "long": (1,), "short": (-1,)}[params.get("direction", "both")]
    buf = params["stop_buffer_ticks"] * tick
    step = _memo(cache, "step", lambda: _step(bars))
    htf = _memo(cache, "htf", lambda: htf_trend(bars, step)) if params.get("htf_filter") else None
    rth = params.get("session") == "rth" and 0 < step < 3600
    if key not in ("fvg_continuation", "sweep_reversal"):
        dets = {"bull": 1, "bear": -1}
        if key == "order_block":
            raw = [{"ci": ix[d["confirmed_at"]], "sd": dets[d["dir"]], "stop": d["bottom"] if d["dir"] == "bull" else d["top"],
                    "type": "limit", "price": d["top"] if d["dir"] == "bull" else d["bottom"], "id": d["id"],
                    "name": "Retest of the %s order block" % d["dir"]} for d in an["detections"] if d["kind"] == "order_block"]
        else:
            raw = _memo(cache, "pat:" + key, lambda: _pattern_setups(bars, key, cache, step))
        for r in sorted(raw, key=lambda r: r["ci"]):
            ci, sd = r["ci"], r["sd"]
            dname = "bull" if sd == 1 else "bear"
            if sd not in want or ci + 1 > len(bars):
                continue
            decided = bars[ci]["time"] + step
            if rth and not RTH[0] <= M.et_minutes(decided) <= RTH[1]:
                continue
            if htf and htf(decided) != dname:
                continue
            if params.get("trend_filter") and trend[ci] != dname:
                continue
            if params.get("at_level") and not _at_level(bars, an, cache, ci, sd):
                continue
            typ = r.get("type", "market")
            stop = r["stop"] - sd * buf
            sig = {"avail": ci + 1, "dir": sd, "det_id": r.get("id", "%s:%s" % (key, bars[ci]["time"])), "trend": trend[ci], "type": typ,
                   "stop": stop, "expires": ci + (1 if typ == "market" else max(1, int(params["max_wait"]))),
                   "reason": "%s: %s" % (STRATEGIES[key]["name"], r["name"])}
            if typ != "market":
                sig["price"] = r["price"]
                if (r["price"] - stop) * sd <= 0:
                    continue
            out.append(sig)
        return out
    nb, cb = int(params.get("need_break", 0)), int(params.get("confirm_break", 0))
    breaks = sorted((ix[d["confirmed_at"]], d["dir"]) for d in an["detections"] if d["kind"] in STRUCTURE) if nb or cb else []
    used = set()
    kind = "fvg" if key == "fvg_continuation" else "sweep"
    for d in sorted((d for d in an["detections"] if d["kind"] == kind), key=lambda d: d["confirmed_at"]):
        ci = ix[d["confirmed_at"]]
        sd = 1 if d["dir"] == "bull" else -1
        if sd not in want:
            continue
        if cb:  # confirmation entry: the trade is decided on the candle that breaks structure after the sweep
            ci = next((j for j, bd in breaks if ci <= j <= ci + cb and bd == d["dir"]), None)
            if ci is None or ci in used:
                continue
            used.add(ci)
        elif nb and not any(ci - nb <= j <= ci and bd == d["dir"] for j, bd in breaks):
            continue
        decided = bars[ci]["time"] + step  # when the deciding candle closed
        if rth and not RTH[0] <= M.et_minutes(decided) <= RTH[1]:
            continue
        if htf and htf(decided) != d["dir"]:
            continue
        tr = trend[ci]
        if params.get("trend_filter") and tr != d["dir"]:
            continue
        base = {"avail": ci + 1, "dir": sd, "det_id": d["id"], "trend": tr, "expires": ci + max(1, int(params["max_wait"]))}
        if key == "fvg_continuation":
            entry = d["top"] if sd == 1 else d["bottom"]
            stop = d["bottom"] - buf if sd == 1 else d["top"] + buf
            out.append(dict(base, type="limit", price=entry, stop=stop,
                            reason="Limit at %s FVG edge %s" % (d["dir"], A.fmt(entry))))
        else:
            stop = d["extreme"] - buf if sd == 1 else d["extreme"] + buf
            out.append(dict(base, type="market", stop=stop, expires=ci + 1,
                            reason="Market after %s sweep of %s%s" % (d["dir"], A.fmt(d["level"]), " and a structure break" if cb else "")))
    out.sort(key=lambda s: s["avail"])
    return out


def simulate(bars, sigs, params, spec, settings, start, end, live=None):
    """Backtest semantics. With `live` (a dict), a position still open at the last candle is reported in live["open"]
    instead of being closed at "end of data", and orders still waiting to fill go to live["pending"]."""
    tick, tv = spec["tick_size"], spec["tick_value"]
    qty, comm = int(settings.get("qty", 1)), float(settings.get("commission", spec.get("commission", 0)))
    slip = float(settings.get("slippage_ticks", 1)) * tick
    trades, pending, pos, k = [], [], None, 0
    for i in range(start, end):
        b = bars[i]
        while k < len(sigs) and sigs[k]["avail"] <= i:
            if sigs[k]["avail"] >= start:
                pending.append(dict(sigs[k]))
            k += 1
        pending = [s for s in pending if s["expires"] >= i]
        fill_bar = False
        if pos is None:
            for s in pending:
                d = s["dir"]
                if s["type"] == "market":
                    if s["avail"] != i:
                        continue
                    fill = b["open"] + d * slip
                elif s["type"] == "stop":  # buy above / sell below: fills when price trades through the level
                    lvl = s["price"]
                    if not (b["high"] >= lvl if d == 1 else b["low"] <= lvl):
                        continue
                    fill = (max(b["open"], lvl) if d == 1 else min(b["open"], lvl)) + d * slip
                else:
                    lvl = s["price"]
                    if not (b["low"] <= lvl if d == 1 else b["high"] >= lvl):
                        continue
                    fill = (min(b["open"], lvl) if d == 1 else max(b["open"], lvl)) + d * slip
                s["used"] = True
                risk = (fill - s["stop"]) * d
                if risk <= 0:  # gapped through the stop before entry: no trade
                    continue
                pos = {"dir": d, "entry": fill, "stop": s["stop"], "risk": risk, "target": fill + d * params["rr"] * risk,
                       "entry_idx": i, "sig": s, "mfe": 0.0, "mae": 0.0, "be": False, "limit": s["type"] != "market"}
                fill_bar = True
                break
            pending = [s for s in pending if not s.get("used")]
        if pos is None:
            continue
        d = pos["dir"]
        fav = b["high"] - pos["entry"] if d == 1 else pos["entry"] - b["low"]
        adv = pos["entry"] - b["low"] if d == 1 else b["high"] - pos["entry"]
        hit_stop = b["low"] <= pos["stop"] if d == 1 else b["high"] >= pos["stop"]
        hit_tp = (b["high"] >= pos["target"] if d == 1 else b["low"] <= pos["target"]) and not (fill_bar and pos["limit"])
        exit_px = reason = None
        if hit_stop:
            gap = min(b["open"], pos["stop"]) if d == 1 else max(b["open"], pos["stop"])
            exit_px, reason = (gap if not fill_bar else pos["stop"]) - d * slip, "breakeven" if pos["be"] else "stop"
        elif hit_tp:
            exit_px, reason = pos["target"], "target"
        elif i - pos["entry_idx"] >= params["max_hold"]:
            exit_px, reason = b["close"] - d * slip, "time"
        elif i == end - 1 and live is None:
            exit_px, reason = b["close"] - d * slip, "end of data"
        if not hit_stop and not (fill_bar and pos["limit"]):  # unknown intrabar order: don't credit favourable moves
            pos["mfe"] = max(pos["mfe"], fav)
        pos["mae"] = max(pos["mae"], adv)
        if exit_px is None:
            be = params.get("breakeven_r", 0)
            if be and not pos["be"] and pos["mfe"] >= be * pos["risk"]:
                pos["stop"], pos["be"] = pos["entry"], True
            continue
        pts = (exit_px - pos["entry"]) * d
        pnl = pts / tick * tv * qty - 2 * comm * qty
        s = pos["sig"]
        trades.append({"entry_time": bars[pos["entry_idx"]]["time"], "exit_time": b["time"], "dir": "long" if d == 1 else "short",
                       "entry": round(pos["entry"], 6), "exit": round(exit_px, 6), "stop": round(s["stop"], 6),
                       "target": round(pos["target"], 6), "qty": qty, "pnl": round(pnl, 2), "r": round(pts / pos["risk"], 3),
                       "exit_reason": reason, "bars_held": i - pos["entry_idx"], "wait_bars": pos["entry_idx"] - s["avail"],
                       "mfe_r": round(pos["mfe"] / pos["risk"], 3), "mae_r": round(pos["mae"] / pos["risk"], 3),
                       "trend": s["trend"], "det_id": s["det_id"], "reason": s["reason"],
                       "planned_rr": params["rr"]})
        pos = None
    if live is not None:
        live["open"] = None
        if pos is not None:
            s, d = pos["sig"], pos["dir"]
            live["open"] = {"entry_time": bars[pos["entry_idx"]]["time"], "dir": "long" if d == 1 else "short", "entry": round(pos["entry"], 6),
                            "stop": round(pos["stop"], 6), "orig_stop": round(s["stop"], 6), "target": round(pos["target"], 6), "risk": pos["risk"],
                            "qty": qty, "breakeven": pos["be"], "det_id": s["det_id"], "reason": s["reason"], "bars_held": end - 1 - pos["entry_idx"]}
        while k < len(sigs) and sigs[k]["avail"] <= end:  # signals confirmed on the last candle act from the next one
            if sigs[k]["avail"] >= start:
                pending.append(dict(sigs[k]))
            k += 1
        live["pending"] = [{"dir": "long" if s["dir"] == 1 else "short", "type": s["type"], "price": s.get("price"), "stop": s["stop"],
                            "reason": s["reason"], "det_id": s["det_id"]} for s in pending if s["expires"] >= end and not s.get("used")]
    return trades


def metrics(trades, capital, start_time, end_time):
    n = len(trades)
    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] <= 0]
    gw, gl = sum(wins), -sum(losses)
    eq, peak, mdd, mdd_pct, curve = capital, capital, 0.0, 0.0, [{"time": start_time, "value": capital}]
    for t in trades:
        eq += t["pnl"]
        curve.append({"time": t["exit_time"], "value": round(eq, 2)})
        peak = max(peak, eq)
        if peak - eq > mdd:
            mdd, mdd_pct = peak - eq, (peak - eq) / peak * 100 if peak > 0 else 0
    avg_w = gw / len(wins) if wins else 0.0
    avg_l = gl / len(losses) if losses else 0.0
    m = {"trades": n, "wins": len(wins), "losses": len(losses),
         "win_rate": round(len(wins) / n * 100, 2) if n else None,
         "profit_factor": round(gw / gl, 3) if gl > 0 else (None if not gw else "inf"),
         "max_drawdown": round(mdd, 2), "max_drawdown_pct": round(mdd_pct, 2),
         "avg_win": round(avg_w, 2), "avg_loss": round(-avg_l, 2),
         "avg_rr": round(avg_w / avg_l, 3) if avg_l else None,
         "avg_r": round(sum(t["r"] for t in trades) / n, 3) if n else None,
         "expectancy": round((gw - gl) / n, 2) if n else None,
         "net_pnl": round(gw - gl, 2), "end_equity": round(eq, 2), "start_time": start_time, "end_time": end_time}
    return m, curve


def run(bars, key, params, spec, settings, start_time=None, end_time=None, an=None):
    """Backtest on bars[start_time..end_time]. Analysis runs on all bars, but its outputs are only used after their
    confirmation time, which test_backtest verifies."""
    an = an or A.run(bars, "", "", analysis_cfg(params))
    bars = A.validate(bars)[0]
    start = next((i for i, b in enumerate(bars) if start_time is None or b["time"] >= start_time), len(bars))
    end = next((i for i, b in enumerate(bars) if end_time is not None and b["time"] > end_time), len(bars))
    sigs = signals(bars, an, key, params, spec["tick_size"])
    trades = simulate(bars, sigs, params, spec, settings, start, end)
    st = bars[start]["time"] if start < len(bars) else None
    et = bars[end - 1]["time"] if end > 0 else None
    m, curve = metrics(trades, float(settings.get("capital", 10000)), st, et)
    return {"metrics": m, "equity": curve, "trades": trades}


# ---------------------------------------------------------------- live conditions (AI Analyst)

def conditions_now(bars, an, key, params, tick):
    """Which of a strategy's conditions hold on the latest closed candle."""
    if not an["summary"]:
        return {"status": "Not enough data", "conditions": []}
    n, ix = len(an["trend"]), _idx(A.validate(bars)[0])
    bias = an["summary"]["bias"]
    conds = [{"name": "Structure trend is defined", "met": bias != "undetermined", "detail": bias}]
    if key not in ("fvg_continuation", "sweep_reversal"):
        live = [g for g in signals(bars, an, key, params, tick) if g["avail"] == n or (g["type"] != "market" and g["avail"] <= n <= g["expires"])]
        conds.append({"name": "%s setup that passes its filters" % STRATEGIES[key]["name"], "met": bool(live), "detail": live[-1]["reason"] if live else "none"})
        if not live:
            return {"status": "No setup", "conditions": conds}
        g = live[-1]
        entry = g.get("price") or bars[-1]["close"]
        tgt = entry + g["dir"] * params["rr"] * abs(entry - g["stop"])
        return {"status": "%s %s, stop %s" % ("Long" if g["dir"] == 1 else "Short", g["type"] if g["type"] != "market" else "at next open", A.fmt(g["stop"])),
                "conditions": conds, "det_id": g["det_id"],
                "plan": {"dir": "long" if g["dir"] == 1 else "short", "entry": entry, "stop": g["stop"], "target": tgt, "touched": False}}
    if key == "fvg_continuation":
        recent = [d for d in an["detections"] if d["kind"] == "fvg" and ix.get(d["confirmed_at"], -1) >= n - 1 - params["max_wait"]]
        if params.get("trend_filter"):
            recent = [d for d in recent if d["dir"] == bias]
        if any(params.get(p) for p in ("htf_filter", "need_break")) or params.get("session") == "rth":
            allowed = {g["det_id"] for g in signals(bars, an, key, params, tick)}
            conds.append({"name": "Passes the AI's filters (1H trend, New York session, structure break)",
                          "met": any(d["id"] in allowed for d in recent), "detail": "%d of %d" % (sum(d["id"] in allowed for d in recent), len(recent))})
            recent = [d for d in recent if d["id"] in allowed]
        live = [d for d in recent if d.get("filled_at") is None]
        conds.append({"name": "FVG formed in the last %d candles%s" % (params["max_wait"], " in trend direction" if params.get("trend_filter") else ""),
                      "met": bool(recent), "detail": "%d found" % len(recent)})
        conds.append({"name": "That FVG is not filled", "met": bool(live), "detail": "%d unfilled" % len(live)})
        if live:
            d = live[-1]
            sd = 1 if d["dir"] == "bull" else -1
            entry = d["top"] if sd == 1 else d["bottom"]
            stop = d["bottom"] - params["stop_buffer_ticks"] * tick if sd == 1 else d["top"] + params["stop_buffer_ticks"] * tick
            tgt = entry + sd * params["rr"] * abs(entry - stop)
            touched = d.get("touched_at") is not None
            conds.append({"name": "Price has returned to the FVG edge", "met": touched, "detail": A.fmt(entry)})
            return {"status": "%s limit %s, stop %s, target %s (%s)" % ("Long" if sd == 1 else "Short", A.fmt(entry), A.fmt(stop), A.fmt(tgt),
                    "entry touched" if touched else "waiting for price"), "conditions": conds, "det_id": d["id"],
                    "plan": {"dir": "long" if sd == 1 else "short", "entry": entry, "stop": stop, "target": tgt, "touched": touched}}
        return {"status": "No setup", "conditions": conds}
    if params.get("confirm_break") or params.get("htf_filter"):
        ready = {g["det_id"] for g in signals(bars, an, key, params, tick) if g["avail"] == n}
        last = [d for d in an["detections"] if d["id"] in ready]
        conds.append({"name": "Sweep, then structure broke the same way on the latest candle%s" % (" with the 1H trend" if params.get("htf_filter") else ""),
                      "met": bool(last), "detail": last[-1]["reason"] if last else "none"})
    else:
        last = [d for d in an["detections"] if d["kind"] == "sweep" and ix.get(d["confirmed_at"]) == n - 1]
        conds.append({"name": "Sweep on the latest closed candle", "met": bool(last), "detail": last[-1]["reason"] if last else "none"})
    if params.get("trend_filter"):
        conds.append({"name": "Sweep direction matches trend", "met": bool(last) and last[-1]["dir"] == bias, "detail": bias})
    ok = all(c["met"] for c in conds[1:])
    return {"status": ("%s at next open, stop beyond %s" % ("Long" if last[-1]["dir"] == "bull" else "Short", A.fmt(last[-1]["extreme"]))) if ok else "No setup",
            "conditions": conds, "det_id": last[-1]["id"] if last else None}


# ---------------------------------------------------------------- learning: evidence -> hypotheses

def change_for(code, params):
    """The single parameter change proposed for a recurring issue."""
    if code in ("quick_stopouts", "stop_then_target"):
        return {"stop_buffer_ticks": int(params["stop_buffer_ticks"]) + 4}
    if code == "gave_back" and not params.get("breakeven_r"):
        return {"breakeven_r": 1.0}
    if code == "counter_trend" and not params.get("trend_filter"):
        return {"trend_filter": True}
    if code == "stale_entries" and params["max_wait"] > 3:
        return {"max_wait": max(3, int(params["max_wait"]) // 2)}
    if code == "targets_rarely_hit" and params["rr"] > 1.0:
        return {"rr": round(params["rr"] - 0.5, 2)}
    return None


def _wr(ts):
    return sum(t["pnl"] > 0 for t in ts) / len(ts) if ts else 0.0


def diagnostics(trades, params):
    """Recurring patterns in losing trades, each with the numbers behind it."""
    out, losses = [], [t for t in trades if t["pnl"] <= 0]
    if len(losses) >= 5:
        quick = [t for t in losses if t["exit_reason"] == "stop" and t["bars_held"] <= 2]
        if len(quick) / len(losses) >= 0.4:
            out.append({"code": "quick_stopouts", "text": "%d of %d losing trades (%.0f%%) were stopped out within 2 candles of entry, "
                        "suggesting the stop sits inside normal noise." % (len(quick), len(losses), 100 * len(quick) / len(losses)),
                        "evidence": {"quick": len(quick), "losses": len(losses), "examples": [t["entry_time"] for t in quick[:5]]}})
        gave = [t for t in losses if t["mfe_r"] >= 1]
        if len(gave) / len(losses) >= 0.25 and not params.get("breakeven_r"):
            out.append({"code": "gave_back", "text": "%d of %d losing trades (%.0f%%) were at least 1R in profit before reversing to a loss." % (
                len(gave), len(losses), 100 * len(gave) / len(losses)),
                        "evidence": {"gave_back": len(gave), "losses": len(losses), "examples": [t["entry_time"] for t in gave[:5]]}})
    if not params.get("trend_filter"):
        wt = [t for t in trades if t["trend"] == ("bull" if t["dir"] == "long" else "bear")]
        ct = [t for t in trades if t not in wt]
        if len(wt) >= 8 and len(ct) >= 8 and _wr(ct) + 0.1 <= _wr(wt):
            out.append({"code": "counter_trend", "text": "Counter-trend trades won %.0f%% (%d trades) versus %.0f%% with the trend (%d trades)." % (
                100 * _wr(ct), len(ct), 100 * _wr(wt), len(wt)), "evidence": {"counter": len(ct), "with": len(wt), "wr_counter": _wr(ct), "wr_with": _wr(wt)}})
    if params["max_wait"] > 3:
        half = params["max_wait"] / 2
        late = [t for t in trades if t["wait_bars"] > half]
        early = [t for t in trades if t["wait_bars"] <= half]
        if len(late) >= 8 and len(early) >= 8 and _wr(late) + 0.1 <= _wr(early):
            out.append({"code": "stale_entries", "text": "Entries filled more than %d candles after the signal won %.0f%% (%d) versus %.0f%% for quicker fills (%d)." % (
                half, 100 * _wr(late), len(late), 100 * _wr(early), len(early)),
                        "evidence": {"late": len(late), "early": len(early), "wr_late": _wr(late), "wr_early": _wr(early)}})
    if len(trades) >= 20 and params["rr"] > 1.0:
        hit = sum(t["exit_reason"] == "target" for t in trades)
        reach1 = sum(t["mfe_r"] >= 1 for t in trades)
        if hit / len(trades) < 0.25 and reach1 / len(trades) >= 0.45:
            out.append({"code": "targets_rarely_hit", "text": "Only %d of %d trades (%.0f%%) reached the %.1fR target, while %d (%.0f%%) reached 1R." % (
                hit, len(trades), 100 * hit / len(trades), params["rr"], reach1, 100 * reach1 / len(trades)),
                        "evidence": {"target_hits": hit, "reached_1r": reach1, "trades": len(trades)}})
    for o in out:
        o["change"] = change_for(o["code"], params)
    return [o for o in out if o["change"]]


def verdict(base_oos, cand_oos, base_is, cand_is, min_trades=10):
    """Accept only if the candidate beats the baseline on unseen (out-of-sample) data with enough trades."""
    reasons = []
    ok = True
    if cand_oos["trades"] < min_trades:
        ok = False
        reasons.append("Candidate had only %d out-of-sample trades (minimum %d)." % (cand_oos["trades"], min_trades))
    be, ce = base_oos["expectancy"] or 0, cand_oos["expectancy"] or 0
    if ce <= be:
        ok = False
        reasons.append("Out-of-sample expectancy did not improve (%.2f -> %.2f per trade)." % (be, ce))
    pf = lambda m: 99.0 if m["profit_factor"] == "inf" else (m["profit_factor"] or 0)
    if pf(cand_oos) < pf(base_oos):
        ok = False
        reasons.append("Out-of-sample profit factor fell (%s -> %s)." % (base_oos["profit_factor"], cand_oos["profit_factor"]))
    if ok:
        reasons.append("Out-of-sample expectancy %.2f -> %.2f per trade, profit factor %s -> %s over %d trades." % (
            be, ce, base_oos["profit_factor"], cand_oos["profit_factor"], cand_oos["trades"]))
    reasons.append("In-sample for reference: expectancy %.2f -> %.2f." % (base_is["expectancy"] or 0, cand_is["expectancy"] or 0))
    return ok, reasons
