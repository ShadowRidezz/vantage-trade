"""Application services: analysis persistence, paper trades, reviews, research and the AI Brain graph."""
from __future__ import annotations

import json
import threading
import time

import analysis as A
import backtest as B
import db
import llm
import market as M
import brain as Br
from db import (AnalysisRun, Backtest, Condition, Detection, Experiment, Lesson, Review, Strategy, StrategyVersion,
                Trade, row)

NOW_KINDS = {"sr", "premium_discount", "ote"}
_cache, _cache_lock = {}, threading.Lock()


class UserError(ValueError):
    pass


# ---------------------------------------------------------------- setup

def seed():
    db.init()
    with db.session() as s:
        for key, st in B.STRATEGIES.items():
            if s.query(Strategy).filter_by(key=key).first():
                continue
            row_ = Strategy(key=key, name=st["name"], description=st["description"])
            s.add(row_)
            s.flush()
            s.add(StrategyVersion(strategy_id=row_.id, version=1, params=st["params"], status="active", note="Initial rules"))
        s.commit()


# ---------------------------------------------------------------- analysis

def analyze(symbol, tf, cfg=None, on_step=None, persist=True):
    bars = M.closed_bars(M.get_bars(symbol, tf), tf)
    key = (symbol, tf, bars[-1]["time"], json.dumps(cfg or {}, sort_keys=True))
    with _cache_lock:
        hit = _cache.get(key)
    if hit and on_step is None:
        return hit, bars
    res = A.run(bars, symbol, tf, cfg, on_step)
    if persist and not cfg:
        res["run_id"] = _persist(symbol, tf, bars, res)
    with _cache_lock:
        if len(_cache) > 40:
            _cache.clear()
        _cache[key] = res
    return res, bars


def _persist(symbol, tf, bars, res):
    with db.session() as s:
        existing = {d.id: d for d in s.query(Detection).filter_by(symbol=symbol, tf=tf)}
        for d in res["detections"]:
            if d["kind"] in NOW_KINDS or d["kind"] == "swing":
                continue
            e = existing.get(d["id"])
            if e is None:
                s.add(Detection(id=d["id"], symbol=symbol, tf=tf, kind=d["kind"], confirmed_at=d["confirmed_at"], data=d))
            elif e.data != d:
                e.data = d
        run = AnalysisRun(symbol=symbol, tf=tf, last_bar=bars[-1]["time"], provider=M.PROVIDER.label,
                          steps=res["steps"], summary=res["summary"])
        s.add(run)
        s.commit()
        return run.id


def visible(res, bars, recent=600):
    """Detections worth sending to the chart: those confirmed in the last `recent` candles, plus current levels."""
    cut = bars[max(0, len(bars) - recent)]["time"]
    return [d for d in res["detections"] if d["kind"] in NOW_KINDS or d["confirmed_at"] >= cut]


def active_versions(s):
    out = []
    for st in s.query(Strategy).order_by(Strategy.id):
        v = s.query(StrategyVersion).filter_by(strategy_id=st.id, status="active").first()
        if v:
            out.append((st, v))
    return out


def strategy_checks(symbol, tf, res, bars):
    tick = M.spec_for(symbol)["tick_size"]
    out = []
    with db.session() as s:
        for st, v in active_versions(s):
            an = res if B.analysis_cfg(v.params) == {"swing_k": A.DEFAULTS["swing_k"], "fvg_min_atr": A.DEFAULTS["fvg_min_atr"]} \
                else analyze(symbol, tf, B.analysis_cfg(v.params), persist=False)[0]
            c = B.conditions_now(bars, an, st.key, v.params, tick)
            out.append(dict(c, strategy=st.name, version=v.version, version_id=v.id))
    return out


def analysis_payload_stream(symbol, tf, on_step):
    return analysis_payload(symbol, tf, on_step)


def analysis_payload(symbol, tf, on_step=None):
    res, bars = analyze(symbol, tf, on_step=on_step)
    return {"symbol": symbol, "tf": tf, "provider": M.provider_info(), "last_closed": bars[-1]["time"],
            "summary": res["summary"], "steps": res["steps"], "issues": res["issues"], "run_id": res.get("run_id"),
            "detections": visible(res, bars), "strategies": strategy_checks(symbol, tf, res, bars)}


def scan(symbols, tfs):
    out = []
    for sym in symbols:
        for tf in tfs:
            try:
                res, bars = analyze(sym, tf)
                cut = bars[max(0, len(bars) - 10)]["time"]
                recent = [d for d in res["detections"] if d["confirmed_at"] >= cut and d["kind"] not in NOW_KINDS | {"swing"}]
                out.append({"symbol": sym, "tf": tf, "status": "ok", "bias": res["summary"]["bias"] if res["summary"] else "undetermined",
                            "zone": (res["summary"]["pd"] or {}).get("zone") if res["summary"] else None,
                            "close": bars[-1]["close"], "last_closed": bars[-1]["time"], "ran_at": time.time(),
                            "patterns": [{"id": d["id"], "kind": d["kind"], "label": d["label"], "dir": d["dir"], "time": d["confirmed_at"]}
                                         for d in sorted(recent, key=lambda d: -d["confirmed_at"])]})
            except Exception as e:  # noqa: BLE001 - one bad symbol must not kill the scan
                out.append({"symbol": sym, "tf": tf, "status": "error", "error": str(e)})
    return out


# ---------------------------------------------------------------- AI text

def _utc(t):
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(t)) if t else None


def _status(d):
    if d["kind"] in ("sweep", "bos", "choch", "mss", "important"):
        return "one-off event (already happened)"
    for k, word in (("filled_at", "filled"), ("swept_at", "swept"), ("invalidated_at", "invalidated")):
        if d.get(k):
            return "%s %s" % (word, _utc(d[k]))
    if d.get("touched_at"):
        return "active, retested %s" % _utc(d["touched_at"])
    return "active"


def context(symbol, tf):
    """Everything the AI may use, in plain words and readable UTC times."""
    p = analysis_payload(symbol, tf)
    bars = M.closed_bars(M.get_bars(symbol, tf), tf)
    summ = p["summary"] or {}
    price, atr = summ.get("close"), summ.get("atr") or 0

    def compact(d):
        return {"pattern": d.get("name") or d["label"], "direction": d["dir"], "price_low": d["bottom"], "price_high": d["top"],
                "candles": "%s to %s" % (_utc(d["t0"]), _utc(d["t1"])), "detected_at": _utc(d["confirmed_at"]),
                "status": _status(d), "why": d["reason"]}

    level_kinds = ("liquidity", "sr", "fvg", "order_block", "supply_demand")
    near = []
    for d in p["detections"]:
        if d["kind"] in level_kinds and _status(d).startswith("active") and price and atr:
            dist = 0 if d["bottom"] <= price <= d["top"] else min(abs(d["top"] - price), abs(d["bottom"] - price))
            if dist <= 3 * atr:
                near.append(dict(compact(d), side="above price" if d["bottom"] > price else "below price" if d["top"] < price else "price inside",
                                 distance_points=round(dist, 2)))
    near.sort(key=lambda x: x["distance_points"])
    events = [compact(d) for d in p["detections"] if d["kind"] not in ("swing", "premium_discount", "ote")]
    events.sort(key=lambda x: x["detected_at"] or "")
    with db.session() as s:
        bts = [{"strategy_version": b.version_id, "segment": b.segment, "period": "%s to %s" % (_utc(b.start), _utc(b.end)), "metrics": b.metrics}
               for b in s.query(Backtest).filter_by(symbol=symbol, tf=tf).order_by(Backtest.id.desc()).limit(6)]
        trades = s.query(Trade).filter_by(symbol=symbol).all()
        closed = [t for t in trades if t.status == "closed"]
    return {"market": symbol, "timeframe": tf, "data_source": p["provider"], "latest_closed_candle": _utc(p["last_closed"]),
            "definitions": {"bias": "Direction of the most recent break of structure (BOS/CHoCH/MSS). EMAs are separate context.",
                            "liquidity": "Only the 'Liquidity' patterns (equal highs = buy-side, equal lows = sell-side) and sweeps are liquidity. "
                                         "Range equilibrium is not liquidity.",
                            "active": "Not yet filled, swept or invalidated as of the latest closed candle.",
                            "brain_knowledge": "Stored AI Brain records about the patterns on this chart. verification 'built-in rule' = how this app's engine "
                                               "detects it; 'tested' = backtested here; 'imported' = only what one outside source claims (unverified); "
                                               "'corroborated' = several sources agree; 'disputed' = sources disagree. Cite the source title when you use one.",
                            "backtest_units": "In backtest metrics, avg_win, avg_loss, expectancy, net_pnl, max_drawdown and end_equity are "
                                              "US dollars of simulated P&L (not points); win_rate and max_drawdown_pct are percentages; "
                                              "avg_rr is average win / average loss; avg_r is the average R multiple."},
            "last_30_candles": [{"time": _utc(b["time"]), **{k: b[k] for k in ("open", "high", "low", "close", "volume")}} for b in bars[-30:]],
            "summary": summ,
            "structure_timeline_oldest_first": ["%s: %s (%s) at %s" % (_utc(d["confirmed_at"]), d["label"], d["dir"], A.fmt(d["level"]))
                                                for d in p["detections"] if d["kind"] in ("bos", "choch", "mss")][-10:],
            "active_liquidity_near_price": [x for x in near if x["pattern"].startswith(("Buy-side", "Sell-side"))]
                                           or "none: every equal-high/low pool within 3 ATR has already been swept",
            "active_levels_within_3_atr_nearest_first": near[:25],
            "recent_detections_oldest_first": events[-60:], "strategy_conditions_now": p["strategies"],
            "backtests_for_this_market": bts or "none stored",
            "brain_knowledge": Br.retrieve(sorted({d["kind"] for d in p["detections"]})) or "none stored",
            "journal": {"simulated_trades": len(trades), "closed": len(closed), "net_pnl": round(sum(t.pnl or 0 for t in closed), 2)}}


def chat(symbol, tf, messages):
    data = context(symbol, tf)
    convo = "\n".join("%s: %s" % ("User" if m["role"] == "user" else "Assistant", m["content"]) for m in messages[-12:])
    return llm.ask(llm.CHAT_STYLE + "\nAnswer the user's latest question about this chart using only the DATA.\n\nConversation so far:\n" + convo, data)


def ai_trades(symbol, tf, window=300):
    """Where the active strategies would have bought and sold on recent candles (simulated), plus any setup armed now."""
    bars = M.closed_bars(M.get_bars(symbol, tf), tf)
    spec = M.spec_for(symbol)
    settings = {"capital": 10000, "commission": spec["commission"], "slippage_ticks": 1, "qty": 1}
    cut = bars[max(0, len(bars) - window)]["time"]
    res, _ = analyze(symbol, tf)
    out, setups = [], []
    with db.session() as s:
        versions = [(st.key, st.name, v.version, dict(v.params)) for st, v in active_versions(s)]
    for key, name, ver, params in versions:
        key_ = ("trades", symbol, tf, bars[-1]["time"], key, json.dumps(params, sort_keys=True))
        with _cache_lock:
            r = _cache.get(key_)
        if r is None:
            r = B.run(bars, key, params, spec, settings)
            with _cache_lock:
                _cache[key_] = r
        for t in r["trades"]:
            if t["entry_time"] >= cut:
                out.append(dict(t, strategy="%s v%d" % (name, ver)))
        an = res if B.analysis_cfg(params) == {"swing_k": A.DEFAULTS["swing_k"], "fvg_min_atr": A.DEFAULTS["fvg_min_atr"]} \
            else analyze(symbol, tf, B.analysis_cfg(params), persist=False)[0]
        c = B.conditions_now(bars, an, key, params, spec["tick_size"])
        if c.get("plan"):
            setups.append(dict(c["plan"], strategy="%s v%d" % (name, ver), status=c["status"]))
    out.sort(key=lambda t: t["entry_time"])
    return {"symbol": symbol, "tf": tf, "provider": M.provider_info(), "bars": bars[-window:], "trades": out, "setups": setups,
            "wins": sum(t["pnl"] > 0 for t in out), "losses": sum(t["pnl"] <= 0 for t in out), "net_pnl": round(sum(t["pnl"] for t in out), 2)}


def explain(symbol, tf):
    return llm.ask("Write a structured analysis of this chart with these parts: 1) Observed facts (patterns detected, which candles, "
                   "market structure). 2) Strategy conditions met and not met. 3) What would invalidate the current read. "
                   "4) Possibilities (clearly labelled as such, no guarantees).", context(symbol, tf))


# ---------------------------------------------------------------- paper trades

def pnl(symbol, direction, qty, entry, exit_):
    sp = M.spec_for(symbol)
    d = 1 if direction == "long" else -1
    return round((exit_ - entry) * d / sp["tick_size"] * sp["tick_value"] * qty - 2 * sp["commission"] * qty, 2)


def open_trade(p):
    sym, tf = p["symbol"].upper(), p["tf"]
    price, t = M.last_price(sym)
    d = 1 if p["direction"] == "long" else -1
    if (p["stop"] - price) * d >= 0:
        raise UserError("Stop must be %s the entry price %s." % ("below" if d == 1 else "above", A.fmt(price)))
    if (p["target"] - price) * d <= 0:
        raise UserError("Target must be %s the entry price %s." % ("above" if d == 1 else "below", A.fmt(price)))
    res, bars = analyze(sym, tf)
    snap = snapshot(res, bars, price)
    summ = res["summary"] or {}
    key = "%s|%s|%s|%s" % (sym, tf, summ.get("bias"), (summ.get("pd") or {}).get("zone"))
    with db.session() as s:
        cond = s.query(Condition).filter_by(key=key).first()
        if not cond:
            cond = Condition(key=key, symbol=sym, tf=tf, bias=summ.get("bias"), zone=(summ.get("pd") or {}).get("zone"))
            s.add(cond)
            s.flush()
        tr = Trade(symbol=sym, contract=M.contract_label(sym, t), tf=tf, direction=p["direction"], qty=p["qty"],
                   entry_time=t, entry_price=price, stop=p["stop"], target=p["target"], status="open",
                   version_id=p.get("version_id"), condition_id=cond.id, analysis=snap,
                   detection_ids=[d["id"] for d in snap["detections"]], price_source=M.PROVIDER.label, notes=p.get("notes", ""))
        s.add(tr)
        for d in snap["detections"]:
            if not s.get(Detection, d["id"]):
                s.add(Detection(id=d["id"], symbol=sym, tf=tf, kind=d["kind"], confirmed_at=d["confirmed_at"], data=d))
        s.commit()
        return row(tr)


def snapshot(res, bars, price):
    """The analysis as it stood when the trade was opened: summary plus the detections near price."""
    dets, summ = res["detections"], res["summary"] or {}
    atr = summ.get("atr") or 0
    near = lambda d, k: atr and min(abs(d["top"] - price), abs(d["bottom"] - price)) <= k * atr
    pick = []
    st = [d for d in dets if d["kind"] in ("bos", "choch", "mss")]
    pick += st[-1:]
    pick += [d for d in dets if d["kind"] == "fvg" and d.get("filled_at") is None and near(d, 2)][-3:]
    pick += [d for d in dets if d["kind"] == "order_block" and d.get("invalidated_at") is None and near(d, 2)][-2:]
    pick += [d for d in dets if d["kind"] == "liquidity" and d.get("swept_at") is None and near(d, 3)][-2:]
    cut = bars[max(0, len(bars) - 5)]["time"]
    pick += [d for d in dets if d["kind"] == "sweep" and d["confirmed_at"] >= cut][-1:]
    return {"summary": summ, "steps": res["steps"], "detections": pick, "last_closed": bars[-1]["time"]}


def update_open_trades():
    with db.session() as s:
        # AI trades are closed by the AI trader on its own candles; only your trades are checked here
        open_ = [t for t in s.query(Trade).filter_by(status="open") if t.source != "ai"]
        for sym in {t.symbol for t in open_}:
            try:
                bars = M.get_bars(sym, "1m")
            except Exception:  # noqa: BLE001 - keep trades open when data is unavailable
                continue
            for t in [x for x in open_ if x.symbol == sym]:
                d = 1 if t.direction == "long" else -1
                for b in bars:
                    if b["time"] <= t.entry_time:
                        continue
                    hit_stop = b["low"] <= t.stop if d == 1 else b["high"] >= t.stop
                    hit_tp = b["high"] >= t.target if d == 1 else b["low"] <= t.target
                    if hit_stop or hit_tp:  # both in one candle: assume the stop (conservative)
                        px = t.stop if hit_stop else t.target
                        t.exit_time, t.exit_price, t.exit_reason = b["time"], px, "stop" if hit_stop else "target"
                        t.status, t.pnl = "closed", pnl(t.symbol, t.direction, t.qty, t.entry_price, px)
                        break
        s.commit()


def close_trade(tid):
    with db.session() as s:
        t = s.get(Trade, tid)
        if not t or t.status != "open":
            raise UserError("Trade is not open.")
        px, ts = M.last_price(t.symbol)
        t.exit_time, t.exit_price, t.exit_reason, t.status = ts, px, "manual", "closed"
        t.pnl = pnl(t.symbol, t.direction, t.qty, t.entry_price, px)
        s.commit()
        return row(t)


def trade_detail(tid):
    with db.session() as s:
        t = s.get(Trade, tid)
        if not t:
            raise UserError("Trade not found.")
        rv = s.query(Review).filter_by(trade_id=tid).first()
        ls = s.query(Lesson).filter_by(trade_id=tid).all()
        return {"trade": row(t), "review": row(rv) if rv else None, "lessons": [row(x) for x in ls]}


def review_trade(tid):
    """Evidence-based review of a closed trade. Saves the review and any lessons."""
    with db.session() as s:
        t = s.get(Trade, tid)
        if not t or t.status != "closed":
            raise UserError("Only closed trades can be reviewed.")
        d = 1 if t.direction == "long" else -1
        risk = abs(t.entry_price - t.stop)
        path = [b for b in M.get_bars(t.symbol, "1m") if t.entry_time < b["time"] <= t.exit_time]
        mfe = max([(b["high"] - t.entry_price) * d if d == 1 else (t.entry_price - b["low"]) for b in path] or [0])
        mae = max([(t.entry_price - b["low"]) if d == 1 else (b["high"] - t.entry_price) for b in path] or [0])
        tf_bars = M.closed_bars(M.get_bars(t.symbol, t.tf), t.tf)
        sec = M.TIMEFRAMES[t.tf][3]
        held = max(0, (t.exit_time - t.entry_time) // sec)
        after = [b for b in tf_bars if b["time"] > t.exit_time][:20]
        reached_after = any((b["high"] >= t.target) if d == 1 else (b["low"] <= t.target) for b in after)
        upto = [b for b in tf_bars if b["time"] <= t.exit_time]
        shifts = []
        if len(upto) > 20:
            res = A.run(upto, t.symbol, t.tf)
            want = "bear" if d == 1 else "bull"
            shifts = [x for x in res["detections"] if x["kind"] in ("choch", "mss") and x["dir"] == want and t.entry_time < x["confirmed_at"] <= t.exit_time]
        bias = (t.analysis or {}).get("summary", {}).get("bias")
        facts = {
            "setup": {"bias_at_entry": bias, "zone_at_entry": ((t.analysis or {}).get("summary", {}).get("pd") or {}).get("zone"),
                      "patterns": [{"label": x["label"], "dir": x["dir"], "reason": x["reason"]} for x in (t.analysis or {}).get("detections", [])]},
            "expected": {"direction": t.direction, "entry": t.entry_price, "stop": t.stop, "target": t.target,
                         "planned_rr": round(abs(t.target - t.entry_price) / risk, 2) if risk else None},
            "outcome": {"exit_reason": t.exit_reason, "exit": t.exit_price, "pnl": t.pnl,
                        "commission_round_trip": round(2 * M.spec_for(t.symbol)["commission"] * t.qty, 2),
                        "r": round((t.exit_price - t.entry_price) * d / risk, 2) if risk else None, "candles_held": held},
            "path": {"mfe_points": round(mfe, 2), "mae_points": round(mae, 2), "mfe_r": round(mfe / risk, 2) if risk else None,
                     "one_minute_candles": len(path)},
            "after_exit": {"candles_checked": len(after), "target_reached_after_exit": reached_after},
            "invalidated": [{"label": x["label"], "time": x["confirmed_at"], "reason": x["reason"]} for x in shifts],
        }
        lessons = []
        if t.exit_reason == "stop" and held <= 2:
            lessons.append(("quick_stopouts", "Stopped out within %d candle(s) of entry; the stop was %s points (%s ticks) from entry." % (
                held, A.fmt(risk), int(risk / M.spec_for(t.symbol)["tick_size"]))))
        if t.exit_reason == "stop" and reached_after:
            lessons.append(("stop_then_target", "Price reached the original target within %d candles after the stop-out." % len(after)))
        if t.exit_reason == "stop" and risk and mfe >= risk:
            lessons.append(("gave_back", "The trade was %.1fR in profit before reversing to the stop." % (mfe / risk)))
        if bias in ("bull", "bear") and bias != ("bull" if d == 1 else "bear"):
            lessons.append(("counter_trend", "Entered %s against a %s structure bias recorded at entry." % (t.direction, bias)))
        if shifts:
            lessons.append(("structure_shift", "A %s against the position formed during the trade (%s)." % (shifts[0]["label"], shifts[0]["reason"])))
        if not path:
            facts["note"] = ("The trade lasted under one minute, so there are no completed 1-minute candles between entry and exit."
                             if t.exit_time - t.entry_time < 60 else
                             "No 1-minute candles available between entry and exit (1-minute data covers the last 7 days only).")
        rv = s.query(Review).filter_by(trade_id=tid).first()
        if rv:
            rv.facts = facts
        else:
            s.add(Review(trade_id=tid, facts=facts))
        s.query(Lesson).filter_by(trade_id=tid, source="review").delete()
        for code, text in lessons:
            s.add(Lesson(source="review", code=code, text=text, evidence={"trade_id": tid, "facts": facts["outcome"]},
                         trade_id=tid, version_id=t.version_id))
        s.commit()
    return trade_detail(tid)


def narrate(tid):
    det = trade_detail(tid)
    if not det["review"]:
        raise UserError("Run the review first.")
    ok, text = llm.ask("Write a short post-trade review of this simulated trade: original setup, what was expected, what happened, "
                       "which assumptions were invalidated, and the lessons listed. Do not add lessons that are not supported by the data.",
                       {"trade": {k: det["trade"][k] for k in ("symbol", "tf", "direction", "entry_price", "stop", "target", "exit_price", "exit_reason", "pnl")},
                        "review_facts": det["review"]["facts"], "lessons": [x["text"] for x in det["lessons"]]})
    if ok:
        with db.session() as s:
            s.query(Review).filter_by(trade_id=tid).update({"narrative": text})
            s.commit()
    return ok, text


def replay(tid):
    with db.session() as s:
        t = s.get(Trade, tid)
        if not t:
            raise UserError("Trade not found.")
        t = row(t)
    bars = M.closed_bars(M.get_bars(t["symbol"], t["tf"]), t["tf"])
    if not bars or bars[0]["time"] > t["entry_time"]:
        raise UserError("Historical candles for this trade are no longer available from the data provider.")
    i0 = max(i for i, b in enumerate(bars) if b["time"] <= t["entry_time"])  # the candle containing the entry
    end_t = t["exit_time"] or bars[-1]["time"]
    i1 = next((i for i, b in enumerate(bars) if b["time"] > end_t), len(bars))
    window = bars[max(0, i0 - 150): min(len(bars), i1 + 30)]
    res = A.run(window, t["symbol"], t["tf"])
    dets = [d for d in res["detections"] if d["kind"] not in NOW_KINDS]
    return {"trade": t, "bars": window, "detections": dets, "provider": M.provider_info()}


# ---------------------------------------------------------------- backtests and research

def _version(s, vid):
    v = s.get(StrategyVersion, vid)
    if not v:
        raise UserError("Strategy version not found.")
    return v, s.get(Strategy, v.strategy_id)


def run_backtest(p):
    sym, tf = p["symbol"].upper(), p["tf"]
    with db.session() as s:
        v, st = _version(s, p["version_id"])
        params, key = dict(v.params), st.key
    bars = M.closed_bars(M.get_bars(sym, tf), tf)
    spec = M.spec_for(sym)
    settings = {"capital": p["capital"], "commission": p["commission"], "slippage_ticks": p["slippage_ticks"], "qty": p["qty"]}
    r = B.run(bars, key, params, spec, settings, p.get("start"), p.get("end"))
    if not r["metrics"]["start_time"]:
        raise UserError("No candles in the selected date range.")
    with db.session() as s:
        bt = Backtest(version_id=p["version_id"], symbol=sym, tf=tf, start=r["metrics"]["start_time"], end=r["metrics"]["end_time"],
                      segment="full", settings=dict(settings, spec=spec, data=M.PROVIDER.label), metrics=r["metrics"],
                      equity=r["equity"], trades=r["trades"])
        s.add(bt)
        s.commit()
        out = row(bt)
    out["diagnostics"] = B.diagnostics(r["trades"], params)
    out["data_range"] = {"first": bars[0]["time"], "last": bars[-1]["time"]}
    return out


def strategies():
    with db.session() as s:
        out = []
        for st in s.query(Strategy).order_by(Strategy.id):
            vs = s.query(StrategyVersion).filter_by(strategy_id=st.id).order_by(StrategyVersion.version).all()
            out.append(dict(row(st), versions=[row(v) for v in vs]))
        return {"strategies": out, "param_docs": B.PARAM_DOCS}


def propose(version_id, symbol, tf):
    """Find recurring issues (backtest diagnostics + journal review lessons) and turn each into one testable change."""
    sym = symbol.upper()
    bt = run_backtest({"version_id": version_id, "symbol": sym, "tf": tf, "capital": 10000, "qty": 1,
                       "commission": M.spec_for(sym)["commission"], "slippage_ticks": 1})
    created = []
    with db.session() as s:
        v, st = _version(s, version_id)
        cands = {}
        for dgn in bt["diagnostics"]:
            ls = Lesson(source="backtest", code=dgn["code"], text=dgn["text"], evidence=dgn["evidence"], backtest_id=bt["id"], version_id=version_id)
            s.add(ls)
            s.flush()
            cands.setdefault(dgn["code"], {"texts": [], "ids": []})
            cands[dgn["code"]]["texts"].append(dgn["text"])
            cands[dgn["code"]]["ids"].append(ls.id)
        review = s.query(Lesson).filter_by(source="review", version_id=version_id).all()
        by_code = {}
        for ls in review:
            by_code.setdefault(ls.code, []).append(ls)
        for code, items in by_code.items():
            if len(items) >= 2:  # recurring across at least two reviewed trades
                c = cands.setdefault(code, {"texts": [], "ids": []})
                c["texts"].append("%d reviewed journal trades share this issue: %s" % (len(items), items[0].text))
                c["ids"] += [x.id for x in items]
        for code, c in cands.items():
            change = B.change_for(code, v.params)
            if not change:
                continue
            dup = [e for e in s.query(Experiment).filter_by(base_version_id=version_id, symbol=sym, tf=tf).all() if e.change == change]
            if dup:
                continue
            e = Experiment(base_version_id=version_id, symbol=sym, tf=tf, change=change, rationale=" ".join(c["texts"]),
                           lesson_ids=c["ids"], status="proposed")
            s.add(e)
            s.flush()
            created.append(row(e))
        s.commit()
    return {"backtest_id": bt["id"], "diagnostics": bt["diagnostics"], "created": created}


def experiments():
    with db.session() as s:
        return [row(e) for e in s.query(Experiment).order_by(Experiment.id.desc())]


def evaluate(eid, split=0.7):
    with db.session() as s:
        e = s.get(Experiment, eid)
        if not e or e.status != "proposed":
            raise UserError("Only proposed hypotheses can be evaluated.")
        v, st = _version(s, e.base_version_id)
        base_p, key = dict(v.params), st.key
        cand_p = dict(base_p, **e.change)
        n = (s.query(StrategyVersion).filter_by(strategy_id=st.id).count()) + 1
        cv = StrategyVersion(strategy_id=st.id, version=n, params=cand_p, parent_id=v.id, status="candidate",
                             note="Hypothesis #%d: %s" % (eid, json.dumps(e.change)))
        s.add(cv)
        s.flush()
        e.candidate_version_id = cv.id
        s.commit()
        sym, tf, cid = e.symbol, e.tf, cv.id
    bars = M.closed_bars(M.get_bars(sym, tf), tf)
    spec = M.spec_for(sym)
    settings = {"capital": 10000, "commission": spec["commission"], "slippage_ticks": 1, "qty": 1}
    cut = bars[int(len(bars) * split)]["time"]
    an_b = A.run(bars, "", "", B.analysis_cfg(base_p))
    an_c = an_b if B.analysis_cfg(cand_p) == B.analysis_cfg(base_p) else A.run(bars, "", "", B.analysis_cfg(cand_p))
    res = {}
    for name, p, an, vid in (("base", base_p, an_b, e.base_version_id), ("cand", cand_p, an_c, cid)):
        for seg, (a, b) in (("in_sample", (None, cut - 1)), ("out_of_sample", (cut, None))):
            r = B.run(bars, key, p, spec, settings, a, b, an=an)
            res[(name, seg)] = r["metrics"]
            with db.session() as s:
                s.add(Backtest(version_id=vid, symbol=sym, tf=tf, start=r["metrics"]["start_time"], end=r["metrics"]["end_time"],
                               segment=seg, experiment_id=eid, settings=dict(settings, data=M.PROVIDER.label), metrics=r["metrics"],
                               equity=r["equity"], trades=r["trades"]))
                s.commit()
    ok, reasons = B.verdict(res[("base", "out_of_sample")], res[("cand", "out_of_sample")], res[("base", "in_sample")], res[("cand", "in_sample")])
    with db.session() as s:
        e = s.get(Experiment, eid)
        e.status = "accepted" if ok else "rejected"
        e.verdict = {"accepted": ok, "reasons": reasons, "split_time": cut,
                     "metrics": {"%s_%s" % k: v for k, v in res.items()}}
        s.get(StrategyVersion, cid).status = "validated" if ok else "rejected"
        s.add(Lesson(source="experiment", code="finding_supported" if ok else "finding_rejected",
                     text="%s %s on %s %s: %s" % ("Supported:" if ok else "Not supported:", json.dumps(e.change), sym, tf, " ".join(reasons)),
                     evidence=e.verdict, experiment_id=eid, version_id=cid))
        s.commit()
        return row(e)


def adopt(vid):
    with db.session() as s:
        v = s.get(StrategyVersion, vid)
        if not v or v.status != "validated":
            raise UserError("Only versions that passed out-of-sample validation can be adopted.")
        for o in s.query(StrategyVersion).filter_by(strategy_id=v.strategy_id, status="active"):
            o.status = "archived"
        v.status = "active"
        s.commit()
        return row(v)
