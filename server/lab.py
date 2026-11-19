"""AI Lab: tests every strategy on one market in seconds and approves only what holds up on data it never tuned on.

For each strategy, a small grid of settings is backtested on the older 60% of the candles; the best one there is then
run on the newer 40%. A strategy is approved only if it was profitable on the older part AND, on the newer part, it has
enough trades, a clearly positive average result, a solid profit factor and an average at least one standard error above
zero. The live AI trader only trades approved strategies. Nothing here can make a trade certain; it filters out setups
with no evidence behind them.
"""
from __future__ import annotations

import itertools
import math
import threading
import time

import analysis as A
import backtest as B
import db
import market as M
from db import LabRun, Strategy, StrategyVersion

SPLIT = 0.6
GRID = {"rr": (1.5, 2.0, 3.0), "htf_filter": (True, False), "session": ("rth", "all"), "at_level": (False, True)}
GATE = {"is_trades": 20, "is_avg_r": 0.05, "oos_trades": 12, "oos_avg_r": 0.15, "oos_pf": 1.3, "oos_t": 1.0}
MAX_AGE = 3 * 3600  # the trader asks for a fresh run when the latest one is older than this

_lock = threading.Lock()
_state = {"running": False, "symbol": None, "tf": None, "done": 0, "total": 0, "step": "", "error": None, "run_id": None}


def state():
    with _lock:
        return dict(_state)


def _set(**kw):
    with _lock:
        _state.update(kw)


def stats(trades):
    n = len(trades)
    if not n:
        return {"trades": 0, "win_rate": None, "avg_r": None, "profit_factor": None, "t": None, "net_pnl": 0}
    rs = [t["r"] for t in trades]
    gw, gl = sum(r for r in rs if r > 0), -sum(r for r in rs if r <= 0)  # in R, so big-stop trades don't dominate
    mean = sum(rs) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in rs) / (n - 1)) if n > 1 else 0
    return {"trades": n, "win_rate": round(100 * sum(t["pnl"] > 0 for t in trades) / n, 1), "avg_r": round(mean, 3),
            "profit_factor": round(gw / gl, 2) if gl else (99.0 if gw else None), "t": round(mean / (sd / math.sqrt(n)), 2) if sd else None,
            "net_pnl": round(sum(t["pnl"] for t in trades), 2)}


def verdict(is_m, oos_m):
    g, why = GATE, []
    if is_m["trades"] < g["is_trades"] or (is_m["avg_r"] or 0) < g["is_avg_r"]:
        why.append("Not profitable enough on the older data (%d trades, %+.2fR each)." % (is_m["trades"], is_m["avg_r"] or 0))
    if oos_m["trades"] < g["oos_trades"]:
        why.append("Only %d trades on the newer data (needs %d)." % (oos_m["trades"], g["oos_trades"]))
    else:
        if (oos_m["avg_r"] or 0) < g["oos_avg_r"]:
            why.append("Newer data: %+.2fR per trade (needs %+.2fR)." % (oos_m["avg_r"] or 0, g["oos_avg_r"]))
        if (oos_m["profit_factor"] or 0) < g["oos_pf"]:
            why.append("Newer data: profit factor %s (needs %.1f)." % (oos_m["profit_factor"], g["oos_pf"]))
        if (oos_m["t"] or 0) < g["oos_t"]:
            why.append("Newer data result could easily be luck (t = %s, needs %.1f)." % (oos_m["t"], g["oos_t"]))
    return not why, why


def variants(key):
    base = B.STRATEGIES[key]["params"]
    names = list(GRID)
    return [dict(base, **dict(zip(names, combo))) for combo in itertools.product(*(GRID[n] for n in names))]


def _version_for(s, key, params, symbol, tf):
    st = s.query(Strategy).filter_by(key=key).first()
    for v in s.query(StrategyVersion).filter_by(strategy_id=st.id):
        if dict(v.params) == params:
            return v
    n = s.query(StrategyVersion).filter_by(strategy_id=st.id).count() + 1
    v = StrategyVersion(strategy_id=st.id, version=n, params=params, status="lab", note="Found by the AI Lab on %s %s" % (symbol, tf))
    s.add(v)
    s.flush()
    return v


def run(symbol, tf):
    """Runs synchronously and stores a LabRun. Returns its row."""
    t0 = time.time()
    keys = list(B.STRATEGIES)
    total = sum(len(variants(k)) for k in keys) + len(keys)
    _set(symbol=symbol, tf=tf, done=0, total=total, step="Loading candles", error=None)
    bars = A.validate(M.closed_bars(M.get_bars(symbol, tf), tf))[0]
    if len(bars) < 400:
        raise ValueError("Not enough candles on %s %s to test (%d)." % (symbol, tf, len(bars)))
    spec = M.spec_for(symbol)
    settings = {"capital": 10000, "commission": spec["commission"], "slippage_ticks": 1, "qty": 1}
    _set(step="Finding patterns")
    an = A.run(bars, symbol, tf, B.analysis_cfg(B.STRATEGIES[keys[0]]["params"]))
    cache, cut, done, results = {}, int(len(bars) * SPLIT), 0, []
    for key in keys:
        _set(step="Testing %s" % B.STRATEGIES[key]["name"])
        best = None
        for p in variants(key):
            sigs = B.signals(bars, an, key, p, spec["tick_size"], cache)
            m = stats(B.simulate(bars, sigs, p, spec, settings, 60, cut))
            if m["trades"] >= GATE["is_trades"] and (best is None or m["avg_r"] > best[1]["avg_r"]):
                best = (p, m, sigs)
            done += 1
            _set(done=done)
        row = {"key": key, "name": B.STRATEGIES[key]["name"]}
        if best is None:
            row.update(params=None, older=None, newer=None, approved=False, reasons=["Fewer than %d trades on the older data with any setting." % GATE["is_trades"]])
        else:
            p, is_m, sigs = best
            oos = [t for t in B.simulate(bars, sigs, p, spec, settings, cut, len(bars)) if t["exit_reason"] != "end of data"]
            oos_m = stats(oos)
            ok, why = verdict(is_m, oos_m)
            row.update(params=p, older=is_m, newer=oos_m, approved=ok, reasons=why or ["Passed every check on data it was not tuned on."])
        done += 1
        _set(done=done)
        results.append(row)
    results.sort(key=lambda r: (not r["approved"], -((r["newer"] or {}).get("avg_r") or -9)))
    with db.session() as s:
        prev = s.query(LabRun).filter_by(symbol=symbol, tf=tf).order_by(LabRun.id.desc()).first()
        since = {a["version_id"]: a["approved_since"] for a in (prev.approved or [])} if prev else {}
        approved, now = [], time.time()
        for r in results:
            if r["approved"]:
                v = _version_for(s, r["key"], r["params"], symbol, tf)
                r["version_id"] = v.id
                approved.append({"key": r["key"], "name": r["name"], "version_id": v.id, "version": v.version, "params": r["params"],
                                 "newer": r["newer"], "approved_since": since.get(v.id, now)})
        lr = LabRun(symbol=symbol, tf=tf, bars=len(bars), split_time=bars[cut]["time"], seconds=round(time.time() - t0, 1),
                    results=results, approved=approved)
        s.add(lr)
        s.commit()
        return db.row(lr)


def start(targets):
    """Test [(symbol, tf), ...] one after another in the background unless a run is already going. Returns the state."""
    with _lock:
        if _state["running"]:
            return dict(_state)
        _state.update(running=True, done=0, total=0, step="Starting", error=None, markets=len(targets), market_no=0)

    def go():
        errors = []
        for i, (symbol, tf) in enumerate(targets):
            _set(market_no=i + 1)
            try:
                r = run(symbol, tf)
                _set(run_id=r["id"])
            except Exception as e:  # noqa: BLE001 - shown in the Lab panel; other markets still run
                errors.append("%s %s: %s" % (symbol, tf, str(e)[:200]))
        _set(running=False, step="Done", error="; ".join(errors) or None)
    threading.Thread(target=go, name="ai-lab", daemon=True).start()
    return state()


def latest(symbol, tf):
    with db.session() as s:
        r = s.query(LabRun).filter_by(symbol=symbol, tf=tf).order_by(LabRun.id.desc()).first()
        return db.row(r) if r else None


def overview():
    """The newest run for every market tested, newest first, without the per-strategy detail."""
    with db.session() as s:
        seen, out = set(), []
        for r in s.query(LabRun).order_by(LabRun.id.desc()).limit(200):
            if (r.symbol, r.tf) in seen:
                continue
            seen.add((r.symbol, r.tf))
            out.append({"id": r.id, "symbol": r.symbol, "tf": r.tf, "created_at": r.created_at, "seconds": r.seconds,
                        "approved": [{"name": a["name"], "newer": a["newer"]} for a in (r.approved or [])]})
        return out
