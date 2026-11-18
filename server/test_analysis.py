import random

import analysis as A


def bar(t, o, h, l, c, v=100):
    return {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}


def walk(n=600, seed=7):
    random.seed(seed)
    out, p = [], 100.0
    for i in range(n):
        o = p
        c = o + random.gauss(0, 1)
        out.append(bar(1000 + 60 * i, o, max(o, c) + abs(random.gauss(0, 0.5)), min(o, c) - abs(random.gauss(0, 0.5)), c, random.randint(50, 400)))
        p = c
    return out


def test_validate_drops_bad_candles():
    bars = [bar(1, 10, 11, 9, 10), bar(2, 10, 9, 8, 10), bar(2, 10, 11, 9, 10), bar(3, 10, 12, 9, 11), bar(4, None, 1, 1, 1)]
    clean, issues = A.validate(bars)
    assert [b["time"] for b in clean] == [1, 2, 3]  # 2nd candle bad, so the later t=2 one is valid
    assert len(issues) == 2


def test_swings_fractal():
    highs = [1, 2, 3, 9, 3, 2, 1, 2, 3]
    bars = [bar(i, h - 0.5, h, h - 1, h - 0.5) for i, h in enumerate(highs)]
    sw = [s for s in A.find_swings(bars, 3) if s["side"] == "high"]
    assert [(s["i"], s["ci"], s["price"]) for s in sw] == [(3, 6, 9)]


def test_bullish_fvg_and_fill():
    bars = [bar(0, 9, 10, 8, 9.5), bar(1, 10, 15, 10, 15), bar(2, 14, 16, 12, 15.5), bar(3, 15, 15, 9, 10)]
    c = A.Ctx(bars, dict(A.DEFAULTS), "X", "1m")
    A.detect_fvg(c)
    f = [d for d in c.dets if d["dir"] == "bull"]
    assert len(f) == 1 and f[0]["bottom"] == 10 and f[0]["top"] == 12
    assert f[0]["confirmed_at"] == 2 and f[0]["filled_at"] == 3


def test_structure_bos_then_choch():
    # Up-zigzag making higher highs, then a collapse through the last swing low.
    closes = [10, 11, 12, 14, 13, 12, 11, 12, 13, 15, 17, 16, 15, 14, 15, 16, 18, 20, 21, 19, 17, 15, 12, 9, 7, 6, 5, 4]
    bars = [bar(i, c - 0.2, c + 0.5, c - 0.5, c) for i, c in enumerate(closes)]
    res = A.run(bars, "X", "1m", {"swing_k": 2})
    kinds = [(d["kind"], d["dir"]) for d in res["detections"] if d["kind"] in ("bos", "choch", "mss")]
    assert ("bos", "bull") in kinds
    assert kinds[-1][1] == "bear" and kinds[-1][0] in ("choch", "mss")
    assert res["trend"][-1] == "bear"


def test_no_lookahead():
    """Detections known at time T must be identical whether or not later candles exist."""
    bars = walk()
    full = A.run(bars, "X", "1m")
    skip = {"sr", "premium_discount", "ote", "swing"}  # these describe "now" (latest close / last 40 swings)
    full_ids = {d["id"] for d in full["detections"] if d["kind"] not in skip}
    for m in (150, 300, 450):
        part = A.run(bars[:m], "X", "1m")
        cut = bars[m - 1]["time"]
        part_ids = {d["id"] for d in part["detections"] if d["kind"] not in skip and d["confirmed_at"] <= cut}
        known = {d["id"] for d in full["detections"] if d["kind"] not in skip and d["confirmed_at"] <= cut}
        assert part_ids == known, (m, part_ids ^ known)
        assert full["trend"][:m] == part["trend"]
    assert full_ids


def test_pipeline_reports_every_step():
    seen = []
    res = A.run(walk(200), "X", "1m", on_step=lambda s: seen.append(s["name"]))
    assert seen == [s["name"] for s in res["steps"]] and len(seen) == 7
    assert res["summary"]["bias"] in ("bull", "bear", "undetermined")


def test_fvg_ignores_session_gap():
    # Candle times 0, 60, then a 1-hour halt: the jump is an opening gap, not a three-candle FVG.
    bars = [bar(0, 9, 10, 8, 9.5), bar(60, 10, 11, 9.8, 10.5), bar(120, 10.5, 11, 10, 10.8), bar(3720, 14, 16, 12, 15.5), bar(3780, 15.5, 16, 15, 15.8)]
    c = A.Ctx(bars, dict(A.DEFAULTS), "X", "1m")
    A.detect_fvg(c)
    assert not [d for d in c.dets if d["dir"] == "bull" and d["t0"] in (60, 120) and d["t1"] in (3720, 3780)]
