from market import aggregate


def test_aggregate_3m():
    bars = [{"time": 180 + 60 * i, "open": i, "high": i + 1, "low": i - 1, "close": i + 0.5, "volume": 10} for i in range(4)]
    out = aggregate(bars, 3, 60)
    assert [b["time"] for b in out] == [180, 360]
    assert out[0] == {"time": 180, "open": 0, "high": 3, "low": -1, "close": 2.5, "volume": 30}
    assert out[1]["open"] == 3 and out[1]["volume"] == 10


if __name__ == "__main__":
    test_aggregate_3m()
    print("ok")


def test_front_month_rolls_before_expiry():
    import calendar
    from market import front_month
    ts = lambda y, m, d: calendar.timegm((y, m, d, 12, 0, 0))
    assert front_month("MNQ", ts(2026, 11, 17))["code"] == "MNQZ6"   # Dec 2026 expires Fri 18 Dec
    assert front_month("MNQ", ts(2026, 12, 11))["code"] == "MNQH7"   # within 8 days of expiry -> March
    assert front_month("ES", ts(2026, 1, 5)) == {"code": "ESH6", "expiry": "2026-03-20"}
    assert front_month("AAPL", ts(2026, 1, 5)) is None
