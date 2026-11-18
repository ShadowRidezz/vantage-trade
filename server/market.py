"""Market data behind a provider abstraction. Every response says whether data is live, delayed, historical or simulated."""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
import urllib.request

# Continuous front-month futures. Specs per CME contract sheets.
FUTURES = {
    "MNQ": {"name": "Micro E-mini Nasdaq-100", "yahoo": "MNQ=F", "tick_size": 0.25, "tick_value": 0.50, "exchange": "CME", "commission": 0.62},
    "MES": {"name": "Micro E-mini S&P 500", "yahoo": "MES=F", "tick_size": 0.25, "tick_value": 1.25, "exchange": "CME", "commission": 0.62},
    "NQ": {"name": "E-mini Nasdaq-100", "yahoo": "NQ=F", "tick_size": 0.25, "tick_value": 5.00, "exchange": "CME", "commission": 2.25},
    "ES": {"name": "E-mini S&P 500", "yahoo": "ES=F", "tick_size": 0.25, "tick_value": 12.50, "exchange": "CME", "commission": 2.25},
}
STOCK_SPEC = {"name": "Stock", "tick_size": 0.01, "tick_value": 0.01, "exchange": "", "commission": 0.0}

# timeframe -> (yahoo interval, yahoo range, aggregate N source bars, bar seconds)
TIMEFRAMES = {
    "1m": ("1m", "7d", 1, 60), "3m": ("1m", "7d", 3, 180), "5m": ("5m", "60d", 1, 300),
    "15m": ("15m", "60d", 1, 900), "30m": ("30m", "60d", 1, 1800), "1H": ("60m", "730d", 1, 3600),
    "4H": ("60m", "730d", 4, 14400), "1D": ("1d", "10y", 1, 86400), "1W": ("1wk", "max", 1, 604800), "1M": ("1mo", "max", 1, 2678400),
}


INTRADAY_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600}


class YahooProvider:
    """Delayed/historical data. Not licensed for live trading decisions."""
    id = "yahoo"
    status = "delayed"  # one of: live, delayed, historical, simulated
    label = "Yahoo Finance · delayed"

    def candles(self, ticker, interval, rng):
        url = "https://query1.finance.yahoo.com/v8/finance/chart/%s?%s" % (
            urllib.parse.quote(ticker), urllib.parse.urlencode({"interval": interval, "range": rng}))
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.load(r)["chart"]["result"]
        if not res or "timestamp" not in res[0]:
            return []
        ts, q = res[0]["timestamp"], res[0]["indicators"]["quote"][0]
        sec = INTRADAY_SECONDS.get(interval)
        out = []
        for i, t in enumerate(ts):
            o, h, l, c, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
            if None in (o, h, l, c):  # Yahoo leaves gaps as nulls; drop, never fill
                continue
            out.append({"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v or 0})
        # Yahoo appends the live quote as a pseudo-candle off the interval grid; it is not a candle.
        if sec and len(out) >= 2 and (out[-1]["time"] - out[-2]["time"]) % sec:
            out.pop()
        return out


PROVIDER = YahooProvider()
_cache = {}
_lock = threading.Lock()


def provider_info():
    return {"id": PROVIDER.id, "status": PROVIDER.status, "label": PROVIDER.label}


def spec_for(symbol):
    return FUTURES.get(symbol.upper(), STOCK_SPEC)


def aggregate(bars, n, seconds):
    """Group bars into fixed time buckets of n*seconds (aligned to epoch)."""
    if n == 1:
        return bars
    size, out = n * seconds, []
    for b in bars:
        start = b["time"] - b["time"] % size
        if out and out[-1]["time"] == start:
            a = out[-1]
            a["high"], a["low"] = max(a["high"], b["high"]), min(a["low"], b["low"])
            a["close"], a["volume"] = b["close"], a["volume"] + b["volume"]
        else:
            out.append(dict(b, time=start))
    return out


def get_bars(symbol, tf, max_age=30):
    """All available bars, including the still-forming last one. Raises LookupError / IOError."""
    if tf not in TIMEFRAMES:
        raise LookupError("Unsupported timeframe")
    sym = symbol.upper()
    ticker = FUTURES[sym]["yahoo"] if sym in FUTURES else sym
    interval, rng, n, _ = TIMEFRAMES[tf]
    key = (ticker, tf)
    with _lock:
        hit = _cache.get(key)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    try:
        raw = PROVIDER.candles(ticker, interval, rng)
    except Exception as e:
        raise IOError("Market data unavailable: %s" % e)
    bars = aggregate(raw, n, 60 if interval == "1m" else 3600)
    if not bars:
        raise LookupError("No data for %s" % sym)
    with _lock:
        _cache[key] = (time.time(), bars)
    return bars


def closed_bars(bars, tf, now=None):
    """Drop the still-forming bar so analysis only uses completed candles."""
    sec = TIMEFRAMES[tf][3]
    now = time.time() if now is None else now
    return bars[:-1] if bars and bars[-1]["time"] + sec > now else bars


def last_price(symbol):
    """Most recent traded price we have (delayed), from 1m bars."""
    b = get_bars(symbol, "1m", max_age=15)
    return b[-1]["close"], b[-1]["time"]


MONTH_CODES = {3: "H", 6: "M", 9: "U", 12: "Z"}


def _third_friday(y, m):
    import datetime as dt
    d = dt.date(y, m, 15)
    return d + dt.timedelta(days=(4 - d.weekday()) % 7)


def front_month(symbol, t, roll_days=8):
    """Estimated front-month contract for CME equity-index futures at unix time t (e.g. 'MNQZ6').
    Quarterly (Mar/Jun/Sep/Dec) contracts expire the third Friday; volume rolls about `roll_days` earlier."""
    import datetime as dt
    sym = symbol.upper()
    if sym not in FUTURES:
        return None
    day = dt.datetime.utcfromtimestamp(t).date()
    y, m = day.year, day.month
    for _ in range(6):
        if m in MONTH_CODES:
            exp = _third_friday(y, m)
            if day < exp - dt.timedelta(days=roll_days):
                return {"code": "%s%s%d" % (sym, MONTH_CODES[m], y % 10), "expiry": exp.isoformat()}
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return None


def contract_label(symbol, t):
    fm = front_month(symbol, t)
    if not fm:
        return symbol.upper()
    return "%s (est. front month, expires %s; data is the continuous series)" % (fm["code"], fm["expiry"])
