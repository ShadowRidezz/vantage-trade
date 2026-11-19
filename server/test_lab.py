"""AI Lab: stats and the approval gate, and a full run that stores approvals the trader can use."""
import pytest
from fastapi.testclient import TestClient

import backtest as B
import lab
import main
import market as M
from test_api import Fake


def _t(r):
    return {"r": r, "pnl": r * 10}


def test_stats_and_gate():
    m = lab.stats([_t(2), _t(-1), _t(2), _t(-1), _t(-1)])
    assert m["trades"] == 5 and m["win_rate"] == 40.0 and m["avg_r"] == 0.2 and m["profit_factor"] == 1.33
    good_old = {"trades": 40, "avg_r": 0.2}
    ok, why = lab.verdict(good_old, lab.stats([_t(2), _t(-1)] * 10))  # +0.5R over 20 trades, t well above 1
    assert ok and not why
    ok, why = lab.verdict(good_old, lab.stats([_t(2), _t(-1)] * 4))  # too few unseen trades
    assert not ok and "Only 8 trades" in why[0]
    ok, _ = lab.verdict({"trades": 40, "avg_r": -0.1}, lab.stats([_t(2), _t(-1)] * 10))  # losing on the tuning data
    assert not ok
    ok, why = lab.verdict(good_old, lab.stats([_t(1.1), _t(-1)] * 10))  # +0.05R: not enough edge
    assert not ok


def test_variants_cover_the_grid():
    vs = lab.variants("engulfing")
    assert len(vs) == 24 and len({tuple(sorted(v.items())) for v in vs}) == 24


@pytest.fixture(scope="module")
def c():
    M.PROVIDER = Fake()
    with TestClient(main.app) as client:
        yield client


def test_full_run_is_fast_and_stored(c):
    r = lab.run("MNQ", "5m")
    assert len(r["results"]) == len(B.STRATEGIES) and r["seconds"] < 60
    assert all(x["approved"] == (not any("needs" in w or "Only" in w or "Not" in w or "Fewer" in w for w in x["reasons"])) for x in r["results"])
    for a in r["approved"]:
        assert a["version_id"] and a["params"]
    v = c.get("/api/lab", params={"symbol": "MNQ", "tf": "5m"}).json()
    assert v["run"]["id"] == r["id"] and any(o["symbol"] == "MNQ" for o in v["overview"])
    assert c.post("/api/lab/run", json={"targets": [["bad sym!", "5m"]]}).status_code == 422
