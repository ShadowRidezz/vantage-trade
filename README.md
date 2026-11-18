# VANTAGE TRADE

AI-powered trading research platform: professional charting, rule-based market-structure analysis, AI chart vision,
historical backtesting, a paper-trading journal with trade replay, and an AI Brain of everything it has tested.

**Paper trading and research only. VANTAGE TRADE never places real orders.**

## Download

Get the latest Windows installer from [Releases](https://github.com/ShadowRidezz/vantage-trade/releases/latest)
(`VANTAGE-TRADE-Setup-x.y.z.exe`) and run it.

AI explanations and chat use [Claude Code](https://claude.com/claude-code) signed in on your PC (no API key is stored).
Everything else, including pattern detection and backtests, works without it.

## Features

- **Charts** – candlesticks, 10 timeframes, drawing tools, SMA / EMA / VWAP / RSI / MACD, light and dark themes.
- **AI Vision** – live detection of Fair Value Gaps, order blocks, liquidity, sweeps, BOS / CHoCH / MSS, support and resistance, with the reason for every marking.
- **AI Analyst** – market scanner, a chart of where the AI's strategies buy and sell, and a plain-English chat about the chart.
- **Backtesting** – chronological simulation with futures tick values, commissions and slippage; strategy versions.
- **Journal & Replay** – simulated trades, rule-based trade reviews, candle-by-candle replay without future data.
- **Research** – recurring issues become hypotheses that are kept only if they win on unseen (out-of-sample) data.
- **AI Brain** – a persistent knowledge graph. Paste a YouTube, TikTok, article or website link and the AI extracts the
  patterns, strategies, skills and market conditions it explains, links them to what it already knows (no duplicates,
  disagreements kept), and cites the source with verbatim quotes and timestamps. Videos need a pasted transcript for full
  analysis. Imported claims are never treated as verified; strategies count as tested only after a backtest here.
  The AI Analyst uses this knowledge when explaining the chart.

Market data: Yahoo Finance, delayed. Futures are continuous front-month series.

## Run from source

```
cd server && python -m venv .venv && .venv\Scripts\pip install fastapi==0.109.2 uvicorn==0.29.0 sqlalchemy==2.0.36 websockets==12.0
cd web && npm install && npm run build
server\.venv\Scripts\python -m uvicorn --app-dir server main:app --port 8010
```

Tests: `server\.venv\Scripts\python -m pytest` (server) and `node web/src/indicators.test.ts` (web).
Build the installer and publish a release: `release.ps1`.
