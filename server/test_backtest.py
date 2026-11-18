import analysis as A
import backtest as B
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
    bars = walk(800, seed=3)
    for key in B.STRATEGIES:
        p = dict(B.STRATEGIES[key]["params"], trend_filter=False, fvg_min_atr=0.1)
        full = B.run(bars, key, p, MNQ, SET)["trades"]
        for m in (300, 550):
            part = B.run(bars[:m], key, p, MNQ, SET)["trades"]
            cut = bars[m - 1]["time"]
            done = lambda ts: [t for t in ts if t["exit_time"] < cut]
            assert done(part) == done(full), (key, m)
        assert full, key


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
