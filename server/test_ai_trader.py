"""Live AI trader: same trades as a backtest of the same period, nothing before it started, closed trades final."""
import time

import pytest
from fastapi.testclient import TestClient

import ai_trader as AT
import backtest as B
import db
import lab
import main
import market as M
import services as S
from test_api import Fake


@pytest.fixture(scope="module")
def c():
    M.PROVIDER = Fake()
    with TestClient(main.app) as client:
        yield client


def _ai_rows(**kw):
    with db.session() as s:
        return [db.row(r) for r in s.query(db.Trade).filter_by(source="ai", **kw).order_by(db.Trade.entry_time)]


def _approve(symbol, tf, since):
    """Pretend the AI Lab approved the active versions (the trader only trades lab-approved strategies)."""
    with db.session() as s:
        appr = [{"key": st.key, "name": st.name, "version_id": v.id, "version": v.version, "params": dict(v.params),
                 "newer": {"trades": 20, "win_rate": 50.0, "avg_r": 0.3}, "approved_since": since} for st, v in S.active_versions(s)]
        s.add(db.LabRun(symbol=symbol, tf=tf, bars=0, split_time=0, seconds=0, results=[], approved=appr))
        s.commit()


def test_live_trades_match_a_backtest_of_the_same_period(c):
    AT.configure("MNQ", "5m", True)
    res, bars = S.analyze("MNQ", "5m")
    start_t = bars[len(bars) // 2]["time"]
    _approve("MNQ", "5m", 0)
    with db.session() as s:
        s.query(db.Trade).filter_by(source="ai").delete()
        s.get(db.AiTrader, 1).started_at = start_t
        s.get(db.AiTrader, 1).record_since = 0
        s.commit()
    AT.step()
    rows = _ai_rows(symbol="MNQ", tf="5m")
    assert rows and all(r["entry_time"] > start_t for r in rows)  # nothing from before the trader started
    spec = M.spec_for("MNQ")
    settings = {"capital": 10000, "commission": spec["commission"], "slippage_ticks": 1, "qty": 1}
    with db.session() as s:
        versions = S.active_versions(s)
    for st, v in versions:
        bt = B.run(bars, st.key, dict(v.params), spec, settings, start_time=start_t + 1)["trades"]
        done = [(t["entry_time"], t["exit_time"], t["pnl"]) for t in bt if t["exit_reason"] != "end of data"]
        live = [(r["entry_time"], r["exit_time"], r["pnl"]) for r in rows if r["version_id"] == v.id and r["status"] == "closed"]
        assert live == done, st.key
        opens = [r for r in rows if r["version_id"] == v.id and r["status"] == "open"]
        assert len(opens) <= 1


def test_only_lab_approved_strategies_open_trades(c):
    with db.session() as s:
        s.add(db.LabRun(symbol="MNQ", tf="15m", bars=0, split_time=0, seconds=0, results=[], approved=[]))
        s.commit()
    AT.configure("MNQ", "15m", True)
    with db.session() as s:
        s.get(db.AiTrader, 1).started_at = 0
        s.commit()
    AT.step()
    assert not _ai_rows(symbol="MNQ", tf="15m")  # nothing approved: no trades, however many setups appear
    st = AT.status()
    assert st["approved"] == [] and st["lab_done"] and st["scanning"]
    AT.configure("MNQ", "5m", True)


def test_closed_trades_are_final_and_steps_are_idempotent(c):
    before = _ai_rows(symbol="MNQ", tf="5m", status="closed")
    with db.session() as s:
        first = s.query(db.Trade).filter_by(source="ai", status="closed").first()
        first.pnl = 12345.0  # if a later check rewrote closed trades, this would be overwritten
        s.commit()
    AT.step()
    AT.step()
    after = _ai_rows(symbol="MNQ", tf="5m", status="closed")
    assert len(after) == len(before) and any(r["pnl"] == 12345.0 for r in after)


def test_changing_market_trades_forward_only_and_view_and_api(c):
    t0 = time.time()
    cfg = c.put("/api/ai-trader", json={"symbol": "ES", "tf": "5m"}).json()
    assert cfg["symbol"] == "ES" and cfg["started_at"] >= t0
    time.sleep(0.3)
    assert not _ai_rows(symbol="ES", tf="5m")  # starting now: no back-filled trades
    c.put("/api/ai-trader", json={"symbol": "MNQ"})
    v = c.get("/api/ai-trader").json()
    assert v["config"]["symbol"] == "MNQ" and len(v["bars"]) == 300 and v["status"]["running"]
    st = v["stats"]
    closed = [t for t in v["trades"] if t["status"] == "closed"]
    assert st["trades"] == len(closed) and st["wins"] + st["losses"] == st["trades"]
    if st["trades"]:
        assert st["win_rate"] == round(st["wins"] / st["trades"] * 100, 1)
    assert all("now_r" in t for t in v["trades"] if t["status"] == "open")
    assert c.put("/api/ai-trader", json={"enabled": False}).json()["enabled"] is False


def test_stats_math():
    class R:
        def __init__(self, pnl, entry, stop, exit_, t):
            self.pnl, self.entry_price, self.stop, self.exit_price, self.direction = pnl, entry, stop, exit_, "long"
            self.status, self.exit_time, self.entry_time = "closed", t, t
    rows = [R(100, 10, 9, 12, 1), R(-50, 10, 9, 9, 2), R(-50, 10, 9, 9, 3), R(100, 10, 9, 12, 4), R(100, 10, 9, 12, 5)]
    st = AT.stats(rows)
    assert st["win_rate"] == 60.0 and st["net_pnl"] == 200 and st["profit_factor"] == 3.0 and st["avg_r"] == 0.8
    assert st["max_drawdown"] == 100 and st["streak"] == {"kind": "win", "count": 2}


def test_your_open_trades_still_auto_close_but_ai_ones_are_left_to_the_trader(c):
    with db.session() as s:
        s.add(db.Trade(source="ai", symbol="MNQ", tf="5m", direction="long", qty=1, entry_time=1, entry_price=1.0, stop=0.5, target=1.5, status="open"))
        s.commit()
    S.update_open_trades()
    with db.session() as s:
        assert s.query(db.Trade).filter_by(source="ai", entry_time=1).first().status == "open"
