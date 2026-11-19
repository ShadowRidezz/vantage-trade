"""Live AI paper trader: the active strategies trade the selected market on delayed live candles, while the app runs.

Each check replays the candles since the trader started through the same chronological simulator the backtests use
(signals act only after their detection is confirmed; stop wins when stop and target share a candle), so the live
record and a backtest of the same period agree. Closed trades are stored once and never rewritten.
"""
from __future__ import annotations

import logging
import threading
import time

import backtest as B
import db
import lab
import market as M
import services as S
from db import AiTrader, Trade

log = logging.getLogger(__name__)
INTERVAL = 20  # seconds between checks
_lock = threading.Lock()


def config():
    with db.session() as s:
        c = s.get(AiTrader, 1)
        if c is None:
            c = AiTrader(id=1, enabled=True, symbol="MNQ", tf="5m", started_at=time.time(), record_since=time.time())
            s.add(c)
            s.commit()
        return db.row(c)


def configure(symbol=None, tf=None, enabled=None):
    with db.session() as s:
        config()
        c = s.get(AiTrader, 1)
        changed = (symbol and symbol != c.symbol) or (tf and tf != c.tf)
        if symbol:
            c.symbol = symbol
        if tf:
            c.tf = tf
        if enabled is not None:
            if enabled and not c.enabled:
                changed = True
            c.enabled = enabled
        if changed:  # a new market/timeframe (or a resume) trades forward from now, never back-fills history
            c.started_at = time.time()
            c.last_error = None
        s.commit()
    return config()


def _store(s, sym, tf, vid, t, status, spec, an):
    row = s.query(Trade).filter_by(source="ai", symbol=sym, tf=tf, version_id=vid, entry_time=t["entry_time"]).first()
    if row is not None and row.status == "closed":
        return row  # closed AI trades are final
    if row is None:
        det = next((d for d in an["detections"] if d["id"] == t["det_id"]), None)
        row = Trade(source="ai", symbol=sym, tf=tf, version_id=vid, direction=t["dir"], qty=t["qty"], entry_time=t["entry_time"],
                    entry_price=t["entry"], contract=M.contract_label(sym, t["entry_time"]), price_source=M.PROVIDER.label,
                    notes="Opened by the AI: %s" % t["reason"], detection_ids=[t["det_id"]],
                    analysis={"summary": an["summary"], "steps": [], "detections": [det] if det else [], "last_closed": t["entry_time"]})
        s.add(row)
    row.stop = t.get("orig_stop", t["stop"])
    row.target = t["target"]
    if status == "closed":
        row.status, row.exit_time, row.exit_price, row.exit_reason, row.pnl = "closed", t["exit_time"], t["exit"], t["exit_reason"], t["pnl"]
    else:
        row.status = "open"
    return row


def step():
    """One check: bring the AI's trades up to date with the latest closed candle."""
    c = config()
    if not c["enabled"]:
        return
    sym, tf = c["symbol"], c["tf"]
    spec = M.spec_for(sym)
    settings = {"capital": 10000, "commission": spec["commission"], "slippage_ticks": 1, "qty": 1}
    run = lab.latest(sym, tf)
    if run is None or time.time() - run["created_at"] > lab.MAX_AGE:
        lab.start([(sym, tf)])  # background; until it finishes the trader keeps the previous approvals (or waits)
    approved = (run or {}).get("approved") or []
    with _lock, db.session() as s:
        res, bars = S.analyze(sym, tf)
        if len(bars) < 30:
            return
        # (version id, trade from, only manage until) - only strategies the AI Lab approved for this market may open trades;
        # an unfinished trade of one that lost its approval is still managed until it closes
        todo = [(a["version_id"], a["approved_since"], None) for a in approved]
        ids = {a["version_id"] for a in approved}
        for row in s.query(Trade).filter_by(source="ai", symbol=sym, tf=tf, status="open"):
            if row.version_id not in ids:
                todo.append((row.version_id, 0, row.entry_time))
        cache = {}
        for vid, since_v, until in todo:
            v = s.get(db.StrategyVersion, vid)
            st = s.get(db.Strategy, v.strategy_id)
            params = dict(v.params)
            an = res if B.analysis_cfg(params) == {"swing_k": 3, "fvg_min_atr": 0.1} else S.analyze(sym, tf, B.analysis_cfg(params), persist=False)[0]
            last_exit = max([t.exit_time for t in s.query(Trade).filter_by(source="ai", symbol=sym, tf=tf, version_id=v.id, status="closed")] or [0])
            since = max(c["started_at"], since_v, last_exit)
            start = next((i for i, b in enumerate(bars) if b["time"] > since), len(bars))
            if start >= len(bars):
                continue
            live = {}
            sigs = B.signals(bars, an, st.key, params, spec["tick_size"], cache)
            if until is not None:
                sigs = [g for g in sigs if g["avail"] < len(bars) and bars[g["avail"]]["time"] <= until]
            trades = B.simulate(bars, sigs, params, spec, settings, start, len(bars), live=live)
            keep = set()
            for t in trades:
                keep.add(_store(s, sym, tf, v.id, t, "closed", spec, an).entry_time)
            if live.get("open"):
                keep.add(_store(s, sym, tf, v.id, live["open"], "open", spec, an).entry_time)
            for row in s.query(Trade).filter_by(source="ai", symbol=sym, tf=tf, version_id=v.id, status="open"):
                if row.entry_time not in keep:  # data revised by the provider: that open trade no longer exists
                    s.delete(row)
        cfg = s.get(AiTrader, 1)
        cfg.last_run, cfg.last_error = time.time(), None
        s.commit()


def status():
    """Small, for the always-visible indicator."""
    c = config()
    run = lab.latest(c["symbol"], c["tf"])
    fresh = c["last_run"] is not None and time.time() - c["last_run"] < 3 * INTERVAL + 30
    return {"enabled": c["enabled"], "symbol": c["symbol"], "tf": c["tf"], "last_run": c["last_run"], "error": c["last_error"],
            "scanning": bool(c["enabled"] and fresh and not c["last_error"]), "lab_running": lab.state()["running"],
            "approved": [a["name"] for a in (run or {}).get("approved") or []], "lab_done": run is not None}


def run_forever(stop_event=None):
    while not (stop_event and stop_event.is_set()):
        try:
            step()
        except Exception as e:  # noqa: BLE001 - keep trading on the next check; show the problem in the UI
            log.warning("AI trader check failed: %s", e)
            with db.session() as s:
                c = s.get(AiTrader, 1)
                if c:
                    c.last_error, c.last_run = str(e)[:300], time.time()
                    s.commit()
        time.sleep(INTERVAL)


def start_background():
    threading.Thread(target=run_forever, name="ai-trader", daemon=True).start()


# ---------------------------------------------------------------- what the page shows

def stats(rows):
    closed = sorted([r for r in rows if r.status == "closed"], key=lambda r: r.exit_time)
    wins = [r for r in closed if (r.pnl or 0) > 0]
    gw, gl = sum(r.pnl for r in wins), -sum(r.pnl for r in closed if (r.pnl or 0) <= 0)
    rr = []
    for r in closed:
        risk = abs(r.entry_price - r.stop)
        if risk:
            rr.append((r.exit_price - r.entry_price) * (1 if r.direction == "long" else -1) / risk)
    eq = peak = mdd = 0.0
    for r in closed:
        eq += r.pnl or 0
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    streak, kind = 0, None
    for r in reversed(closed):
        k = "win" if (r.pnl or 0) > 0 else "loss"
        if kind in (None, k):
            kind, streak = k, streak + 1
        else:
            break
    today = time.strftime("%Y-%m-%d")
    return {"trades": len(closed), "wins": len(wins), "losses": len(closed) - len(wins),
            "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else None, "net_pnl": round(gw - gl, 2),
            "profit_factor": round(gw / gl, 2) if gl else (None if not gw else "inf"), "avg_r": round(sum(rr) / len(rr), 2) if rr else None,
            "max_drawdown": round(mdd, 2), "streak": {"kind": kind, "count": streak} if kind else None,
            "today": sum(1 for r in rows if time.strftime("%Y-%m-%d", time.localtime(r.entry_time)) == today)}


def view():
    c = config()
    sym, tf = c["symbol"], c["tf"]
    all_bars = M.get_bars(sym, tf)
    closed = M.closed_bars(all_bars, tf)
    with db.session() as s:
        rows = s.query(Trade).filter_by(source="ai", symbol=sym, tf=tf).order_by(Trade.entry_time).all()
        names = {v.id: "%s v%d" % (s.get(db.Strategy, v.strategy_id).name, v.version) for v in s.query(db.StrategyVersion)}
        since = c.get("record_since") or 0
        trades = [dict(db.row(r), strategy=names.get(r.version_id, ""), current_rules=r.entry_time >= since) for r in rows]
        for t in trades:
            t.pop("analysis", None)
        # the tracker scores trades since the AI Lab era began; earlier ones are counted separately
        st = stats([r for r in rows if r.entry_time >= since])
        old = [r for r in rows if r.entry_time < since and r.status == "closed"]
        st["earlier"] = {"wins": sum((r.pnl or 0) > 0 for r in old), "losses": sum((r.pnl or 0) <= 0 for r in old)} if old else None
    price = all_bars[-1]["close"]
    spec = M.spec_for(sym)
    for t in trades:
        if t["status"] == "open":
            d = 1 if t["direction"] == "long" else -1
            risk = abs(t["entry_price"] - t["stop"]) or 1
            t["now_r"] = round((price - t["entry_price"]) * d / risk, 2)
            t["unrealized"] = round((price - t["entry_price"]) * d / spec["tick_size"] * spec["tick_value"] * t["qty"], 2)
    pending = []
    try:
        for a in (lab.latest(sym, tf) or {}).get("approved") or []:  # only setups the trader may actually take
            p = a["params"]
            an = S.analyze(sym, tf, B.analysis_cfg(p), persist=False)[0]
            x = B.conditions_now(closed, an, a["key"], p, spec["tick_size"])
            if x.get("plan") and not x["plan"].get("touched"):
                pending.append(dict(x["plan"], strategy="%s v%d" % (a["name"], a["version"])))
    except Exception:  # noqa: BLE001 - pending setups are optional decoration
        pass
    age = time.time() - all_bars[-1]["time"]
    run = lab.latest(sym, tf)
    lab_info = {"state": lab.state(), "run": {k: run[k] for k in ("id", "created_at", "approved", "seconds", "bars")} if run else None,
                "tested": len(run["results"]) if run else 0,
                "elsewhere": sorted((o for o in lab.overview() if o["approved"] and (o["symbol"], o["tf"]) != (sym, tf)),
                                   key=lambda o: o["symbol"] != sym)}  # same market on another timeframe first
    return {"config": c, "provider": M.provider_info(), "lab": lab_info, "spec": {k: v for k, v in spec.items() if k != "yahoo"},
            "bars": all_bars[-300:], "last_closed": closed[-1]["time"] if closed else None, "price": price,
            "market_quiet": age > 3 * M.TIMEFRAMES[tf][3] + 600, "trades": trades, "stats": st, "pending": pending,
            "status": {"running": c["enabled"], "last_run": c["last_run"], "last_error": c["last_error"], "interval": INTERVAL}}
