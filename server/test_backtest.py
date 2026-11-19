import calendar

import analysis as A
import backtest as B
import market as M
from test_analysis import bar, walk

MNQ = {"tick_size": 0.25, "tick_value": 0.5, "commission": 0.62}
P = dict(B.STRATEGIES["fvg_continuation"]["params"])
SET = {"qty": 1, "slippage_ticks": 0, "capital": 10000}


def sig(**kw):
    s = {"avail": 1, "dir": 1, "type": "limit", "price": 100.0, "stop": 98.0, "expires": 5, "det_id": "x", "trend": "bull", "reason": ""}
    s.update(kw)
    return s


def test_limit_fill_then_target_pnl_uses_tick_value_and_commission():
    bars = [bar(0, 103, 104, 102, 103), bar(1, 101, 102, 99.5, 101), bar(2, 101, 104.5, 100.5, 104)]
    t = B.simulate(bars, [sig()], dict(P, rr=2), MNQ, SET, 0, 3)
    assert len(t) == 1 and t[0]["exit_reason"] == "target" and t[0]["exit"] == 104
    assert t[0]["pnl"] == round(4 / 0.25 * 0.5 - 2 * 0.62, 2)  # 16 ticks x $0.50 - round-trip commission
    assert t[0]["r"] == 2


def test_stop_wins_when_both_hit_in_one_candle():
    bars = [bar(0, 103, 104, 102, 103), bar(1, 101, 102, 99.5, 101), bar(2, 101, 105, 97, 100)]
    t = B.simulate(bars, [sig()], dict(P, rr=2), MNQ, SET, 0, 3)
    assert t[0]["exit_reason"] == "stop" and t[0]["exit"] == 98


def test_limit_fill_candle_never_hits_target():
    bars = [bar(0, 103, 104, 102, 103), bar(1, 101, 106, 99.5, 101), bar(2, 101, 101.5, 100.5, 101)]
    t = B.simulate(bars, [sig()], dict(P, rr=2, max_hold=60), MNQ, SET, 0, 3)
    assert t[0]["exit_reason"] == "end of data"


def test_signal_not_used_before_available():
    bars = [bar(0, 100, 100.5, 99, 100), bar(1, 101, 102, 101, 101.5), bar(2, 101, 101.5, 99.8, 101)]
    t = B.simulate(bars, [sig(avail=2)], dict(P, rr=2), MNQ, SET, 0, 3)
    assert t[0]["entry_time"] == 2  # bar 0 touched 100 but the signal did not exist yet


def test_slippage_and_gap_through_stop_skips():
    bars = [bar(0, 103, 104, 102, 103), bar(1, 97, 97.5, 96, 97)]
    assert B.simulate(bars, [sig()], P, MNQ, SET, 0, 2) == []


def test_backtest_has_no_lookahead():
    bars = walk(3000, seed=3)
    for key in B.STRATEGIES:
        # first rules, the current ones (1H trend, structure-break) with the session filter off for synthetic times,
        # and the AI Lab's support/resistance filter
        bases = [dict(B.STRATEGIES[key]["params"], session="all"), dict(B.STRATEGIES[key]["params"], session="all", htf_filter=False, at_level=True)]
        any_trades = False
        for base in ([B.V1_PARAMS[key]] if key in B.V1_PARAMS else []) + bases:
            p = dict(base, trend_filter=False, fvg_min_atr=0.1)
            full = B.run(bars, key, p, MNQ, SET)["trades"]
            for m in (1100, 2200):
                part = B.run(bars[:m], key, p, MNQ, SET)["trades"]
                cut = bars[m - 1]["time"]
                done = lambda ts: [t for t in ts if t["exit_time"] < cut]
                assert done(part) == done(full), (key, m, base)
            any_trades = any_trades or bool(full)
        assert any_trades, key


def test_stop_entry_fills_only_when_price_trades_through():
    bars = [bar(0, 100, 100.5, 99.5, 100), bar(1, 100, 100.8, 99.6, 100.5), bar(2, 100.5, 101.5, 100.2, 101.2)]
    s = sig(type="stop", price=101.0, stop=99.0, avail=1, expires=3)
    t = B.simulate(bars, [s], dict(P, rr=2), MNQ, SET, 0, 3)
    assert t[0]["entry_time"] == bars[2]["time"] and t[0]["entry"] == 101.0  # not on bar 1 (high 100.8)


def test_candle_patterns():
    def mk(rows):
        return [bar(i * 300, *r) for i, r in enumerate(rows)]
    flat = [(100, 101, 99, 100)] * 20  # ATR about 2
    eng = mk(flat + [(100, 100.2, 98.8, 99), (98.8, 101.5, 98.6, 101.3)])
    hits = B._pattern_setups(eng, "engulfing", {}, 300)
    assert hits and hits[-1]["sd"] == 1 and hits[-1]["ci"] == len(eng) - 1 and hits[-1]["stop"] == 98.6
    pin = mk(flat + [(100, 100.3, 97, 100.2)])
    assert B._pattern_setups(pin, "pin_bar", {}, 300)[-1]["sd"] == 1
    star = mk(flat + [(101, 101.2, 98.5, 98.7), (98.6, 98.9, 98.3, 98.5), (98.6, 100.6, 98.5, 100.4)])
    assert B._pattern_setups(star, "star", {}, 300)[-1]["sd"] == 1


def test_higher_timeframe_trend_only_uses_closed_hours_and_new_york_session():
    bars = walk(3000, seed=5)
    full = B.htf_trend(bars, 60)
    for m in (700, 1500, 2600):
        part = B.htf_trend(bars[:m], 60)
        for b in bars[:m]:
            assert part(b["time"] + 60) == full(b["time"] + 60)
    assert {full(b["time"]) for b in bars} >= {"bull", "bear"}
    assert M.et_minutes(calendar.timegm((2026, 7, 1, 13, 30, 0))) == 570  # 9:30 EDT
    assert M.et_minutes(calendar.timegm((2026, 12, 1, 14, 30, 0))) == 570  # 9:30 EST
    assert M.et_minutes(calendar.timegm((2026, 11, 1, 5, 59, 0))) == 119  # 1:59 EDT, just before clocks go back
    p = dict(B.STRATEGIES["fvg_continuation"]["params"], trend_filter=False, fvg_min_atr=0.1, htf_filter=False, need_break=0)
    an = A.run(bars)
    rth = B.signals(bars, an, "fvg_continuation", p, 0.25)
    assert len(rth) < len(B.signals(bars, an, "fvg_continuation", dict(p, session="all"), 0.25))
    assert all(B.RTH[0] <= M.et_minutes(bars[s["avail"] - 1]["time"] + 60) <= B.RTH[1] for s in rth)


def test_metrics():
    ts = [{"pnl": 100, "r": 2, "exit_time": 1}, {"pnl": -50, "r": -1, "exit_time": 2}, {"pnl": -50, "r": -1, "exit_time": 3}, {"pnl": 100, "r": 2, "exit_time": 4}]
    m, curve = B.metrics(ts, 1000, 0, 4)
    assert m["win_rate"] == 50 and m["profit_factor"] == 2 and m["net_pnl"] == 100
    assert m["max_drawdown"] == 100 and m["avg_rr"] == 2 and m["expectancy"] == 25
    assert [p["value"] for p in curve] == [1000, 1100, 1050, 1000, 1100]


def test_diagnostics_and_verdict():
    losses = [{"pnl": -10, "exit_reason": "stop", "bars_held": 1, "mfe_r": 0, "trend": "bull", "dir": "long", "wait_bars": 0, "entry_time": 1}] * 6
    d = B.diagnostics(losses, dict(P))
    assert d[0]["code"] == "quick_stopouts" and d[0]["change"] == {"stop_buffer_ticks": P["stop_buffer_ticks"] + 4}
    base = {"trades": 20, "expectancy": 5, "profit_factor": 1.2}
    ok, _ = B.verdict(base, {"trades": 20, "expectancy": 8, "profit_factor": 1.4}, base, base)
    bad, why = B.verdict(base, {"trades": 5, "expectancy": 8, "profit_factor": 1.4}, base, base)
    assert ok and not bad and "out-of-sample trades" in why[0]
