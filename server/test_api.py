"""End-to-end API flow against a deterministic fake data provider (no network)."""
import os
import tempfile
import time

os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "t.db")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import market as M  # noqa: E402
from test_analysis import walk  # noqa: E402


class Fake:
    id, status, label = "fake", "simulated", "Test data · simulated"

    def candles(self, ticker, interval, rng):
        step = 60 if interval == "1m" else 300
        now = int(time.time()) // step * step
        bars = walk(1500, seed=11)
        base = 20000
        return [dict(b, time=now - step * (len(bars) - i), open=b["open"] + base, high=b["high"] + base, low=b["low"] + base,
                     close=b["close"] + base) for i, b in enumerate(bars)]


@pytest.fixture(scope="module")
def c():
    M.PROVIDER = Fake()
    with TestClient(main.app) as client:
        yield client


def test_analysis_and_scan(c):
    a = c.get("/api/analysis", params={"symbol": "MNQ", "tf": "5m"}).json()
    assert a["provider"]["status"] == "simulated" and len(a["steps"]) == 7 and a["detections"]
    assert {s["strategy"] for s in a["strategies"]} == {"FVG Continuation", "Liquidity Sweep Reversal"}
    s = c.post("/api/scan", json={"symbols": ["MNQ", "ES"], "tfs": ["5m"]}).json()
    assert [x["status"] for x in s] == ["ok", "ok"]
    assert c.post("/api/scan", json={"symbols": ["bad sym!"], "tfs": ["5m"]}).status_code == 400


def test_vision_socket_streams_real_steps(c):
    with c.websocket_connect("/ws/vision?symbol=MNQ&tf=5m") as ws:
        msgs = [ws.receive_json() for _ in range(10)]
    kinds = [m["type"] for m in msgs]
    assert kinds[0] == "start" and kinds[1:8] == ["step"] * 7 and kinds[8] == "result" and kinds[9] == "waiting"


def test_trade_lifecycle_review_replay(c):
    price = M.last_price("MNQ")[0]
    bad = c.post("/api/trades", json={"symbol": "MNQ", "tf": "5m", "direction": "long", "stop": price + 5, "target": price + 10})
    assert bad.status_code == 400
    t = c.post("/api/trades", json={"symbol": "MNQ", "tf": "5m", "direction": "long", "qty": 2, "stop": price - 3, "target": price + 6}).json()
    assert t["status"] == "open" and t["contract"].startswith("MNQ")
    closed = c.post("/api/trades/%d/close" % t["id"]).json()
    assert closed["status"] == "closed" and closed["exit_reason"] == "manual"
    r = c.post("/api/trades/%d/review" % t["id"]).json()
    assert r["review"]["facts"]["expected"]["entry"] == t["entry_price"]
    rp = c.get("/api/trades/%d/replay" % t["id"]).json()
    assert rp["bars"] and all(d["confirmed_at"] <= rp["bars"][-1]["time"] for d in rp["detections"])
    assert c.get("/api/trades", params={"q": "MNQ"}).json()


def test_backtest_research_and_brain(c):
    v = c.get("/api/strategies").json()["strategies"][0]["versions"][0]
    b = c.post("/api/backtests", json={"version_id": v["id"], "symbol": "MNQ", "tf": "5m"}).json()
    assert b["metrics"]["trades"] == len(b["trades"]) and b["segment"] == "full"
    p = c.post("/api/research/hypotheses", json={"version_id": v["id"], "symbol": "MNQ", "tf": "5m"}).json()
    assert "diagnostics" in p
    exps = c.get("/api/research/experiments").json()
    if exps:
        e = c.post("/api/research/experiments/%d/evaluate" % exps[0]["id"]).json()
        assert e["status"] in ("accepted", "rejected") and e["verdict"]["reasons"]
        assert c.post("/api/research/experiments/%d/evaluate" % e["id"]).status_code == 400
    g = c.get("/api/brain").json()
    ids = {n["id"] for n in g["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in g["links"])
    assert {"strategy", "version", "backtest", "trade"} <= {n["type"] for n in g["nodes"]}
    assert c.post("/api/versions/%d/adopt" % v["id"]).status_code == 400  # active, not a validated candidate


def test_ai_trades_chart_data(c):
    r = c.get("/api/ai-trades", params={"symbol": "MNQ", "tf": "5m"}).json()
    assert len(r["bars"]) == 300 and r["wins"] + r["losses"] == len(r["trades"])
    assert all(t["entry_time"] >= r["bars"][0]["time"] for t in r["trades"])
    assert all({"dir", "entry", "stop", "target", "strategy"} <= set(x) for x in r["setups"])
