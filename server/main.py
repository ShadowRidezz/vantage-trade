"""VANTAGE TRADE API. Paper trading and research only; there is no real-money order routing anywhere."""
from __future__ import annotations

import asyncio
import re
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

import db
import llm
import market as M
import services as S
import brain as B

app = FastAPI(title="VANTAGE TRADE")
SYM = r"^[A-Za-z0-9.\-^]{1,12}$"
TF = "^(%s)$" % "|".join(M.TIMEFRAMES)


@app.on_event("startup")
def _startup():
    S.seed()


def _call(fn, *a):
    try:
        return fn(*a)
    except S.UserError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except IOError as e:
        raise HTTPException(502, str(e))


# ---------------------------------------------------------------- market data

@app.get("/api/markets")
def markets():
    return {"futures": [dict(symbol=s, **{k: v for k, v in f.items() if k != "yahoo"}) for s, f in M.FUTURES.items()],
            "timeframes": list(M.TIMEFRAMES), "provider": M.provider_info()}


@app.get("/api/candles")
def candles(symbol: str = Query(..., pattern=SYM), tf: str = Query("5m", pattern=TF)):
    sym = symbol.upper()
    bars = _call(M.get_bars, sym, tf)
    spec = M.FUTURES.get(sym)
    return {"symbol": sym, "tf": tf, "continuous": spec is not None,
            "spec": {k: v for k, v in spec.items() if k != "yahoo"} if spec else None,
            "contract": M.front_month(sym, bars[-1]["time"]), "provider": M.provider_info(), "bars": bars}


# ---------------------------------------------------------------- analysis

@app.get("/api/analysis")
def get_analysis(symbol: str = Query(..., pattern=SYM), tf: str = Query(..., pattern=TF)):
    return _call(S.analysis_payload, symbol.upper(), tf)


class ScanReq(BaseModel):
    symbols: List[str] = Field(..., min_length=1, max_length=12)
    tfs: List[str] = Field(..., min_length=1, max_length=4)


@app.post("/api/scan")
def scan(r: ScanReq):
    for s in r.symbols:
        if not re.match(SYM, s):
            raise HTTPException(400, "Invalid symbol %r" % s)
    for t in r.tfs:
        if t not in M.TIMEFRAMES:
            raise HTTPException(400, "Invalid timeframe %r" % t)
    return S.scan([s.upper() for s in r.symbols], r.tfs)


@app.websocket("/ws/vision")
async def vision(ws: WebSocket, symbol: str, tf: str):
    """Streams each analysis stage as it completes, then waits for the next closed candle."""
    await ws.accept()
    if not re.match(SYM, symbol) or tf not in M.TIMEFRAMES:
        await ws.send_json({"type": "error", "message": "Invalid market or timeframe"})
        await ws.close()
        return
    sym, loop, last = symbol.upper(), asyncio.get_running_loop(), None
    try:
        while True:
            try:
                bars = await run_in_threadpool(M.get_bars, sym, tf, 20)
                closed = M.closed_bars(bars, tf)
                if closed and closed[-1]["time"] != last:
                    last = closed[-1]["time"]
                    q: asyncio.Queue = asyncio.Queue()
                    await ws.send_json({"type": "start", "symbol": sym, "tf": tf, "candle": last, "provider": M.provider_info()})
                    task = loop.run_in_executor(None, lambda: S.analysis_payload_stream(sym, tf, lambda st: loop.call_soon_threadsafe(q.put_nowait, st)))
                    while not task.done() or not q.empty():
                        try:
                            st = await asyncio.wait_for(q.get(), 0.2)
                            await ws.send_json({"type": "step", **st})
                        except asyncio.TimeoutError:
                            pass
                    await ws.send_json({"type": "result", **(await task)})
                nxt = closed[-1]["time"] + 2 * M.TIMEFRAMES[tf][3] if closed else None
                await ws.send_json({"type": "waiting", "next_close": nxt, "checked_at": time.time()})
            except (IOError, LookupError) as e:
                await ws.send_json({"type": "error", "message": str(e)})
            await asyncio.sleep(20)
    except WebSocketDisconnect:
        return


@app.get("/api/ai-trades")
def ai_trades(symbol: str = Query(..., pattern=SYM), tf: str = Query(..., pattern=TF)):
    return _call(S.ai_trades, symbol.upper(), tf)


# ---------------------------------------------------------------- AI text

class ChatMsg(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., max_length=4000)


class ChatReq(BaseModel):
    symbol: str = Field(..., pattern=SYM)
    tf: str = Field(..., pattern=TF)
    messages: List[ChatMsg] = Field(..., min_length=1, max_length=40)


@app.get("/api/llm/status")
def llm_status(force: bool = False):
    return llm.status(force)


@app.post("/api/llm/signin")
def llm_signin():
    try:
        llm.open_sign_in()
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/chat")
def chat(r: ChatReq):
    ok, text = _call(S.chat, r.symbol.upper(), r.tf, [m.model_dump() for m in r.messages])
    return {"ok": ok, "text": text}


class MarketReq(BaseModel):
    symbol: str = Field(..., pattern=SYM)
    tf: str = Field(..., pattern=TF)


@app.post("/api/explain")
def explain(r: MarketReq):
    ok, text = _call(S.explain, r.symbol.upper(), r.tf)
    return {"ok": ok, "text": text}


# ---------------------------------------------------------------- strategies, backtests, research

@app.get("/api/strategies")
def strategies():
    return S.strategies()


class BacktestReq(BaseModel):
    version_id: int
    symbol: str = Field(..., pattern=SYM)
    tf: str = Field(..., pattern=TF)
    start: Optional[int] = None
    end: Optional[int] = None
    capital: float = Field(10000, gt=0, le=1e9)
    commission: float = Field(0.62, ge=0, le=100)
    slippage_ticks: float = Field(1, ge=0, le=50)
    qty: int = Field(1, ge=1, le=1000)


@app.post("/api/backtests")
def backtest(r: BacktestReq):
    return _call(S.run_backtest, r.model_dump())


@app.get("/api/backtests")
def backtests(version_id: Optional[int] = None):
    with db.session() as s:
        q = s.query(db.Backtest.id, db.Backtest.version_id, db.Backtest.symbol, db.Backtest.tf, db.Backtest.segment,
                    db.Backtest.experiment_id, db.Backtest.metrics, db.Backtest.created_at).order_by(db.Backtest.id.desc())
        if version_id:
            q = q.filter(db.Backtest.version_id == version_id)
        return [dict(r._mapping) for r in q.limit(200)]


@app.get("/api/backtests/{bid}")
def backtest_get(bid: int):
    with db.session() as s:
        b = s.get(db.Backtest, bid)
        if not b:
            raise HTTPException(404, "Backtest not found")
        return db.row(b)


class ProposeReq(BaseModel):
    version_id: int
    symbol: str = Field(..., pattern=SYM)
    tf: str = Field(..., pattern=TF)


@app.post("/api/research/hypotheses")
def propose(r: ProposeReq):
    return _call(S.propose, r.version_id, r.symbol, r.tf)


@app.get("/api/research/experiments")
def experiments():
    return S.experiments()


@app.post("/api/research/experiments/{eid}/evaluate")
def evaluate(eid: int):
    return _call(S.evaluate, eid)


@app.post("/api/versions/{vid}/adopt")
def adopt(vid: int):
    return _call(S.adopt, vid)


# ---------------------------------------------------------------- journal

class TradeReq(BaseModel):
    symbol: str = Field(..., pattern=SYM)
    tf: str = Field(..., pattern=TF)
    direction: str = Field(..., pattern="^(long|short)$")
    qty: int = Field(1, ge=1, le=1000)
    stop: float = Field(..., gt=0)
    target: float = Field(..., gt=0)
    version_id: Optional[int] = None
    notes: str = Field("", max_length=4000)


class NotesReq(BaseModel):
    notes: str = Field(..., max_length=4000)


@app.get("/api/trades")
def trades(q: str = "", status: str = "", symbol: str = ""):
    S.update_open_trades()
    with db.session() as s:
        qry = s.query(db.Trade).order_by(db.Trade.id.desc())
        if status in ("open", "closed"):
            qry = qry.filter(db.Trade.status == status)
        if symbol:
            qry = qry.filter(db.Trade.symbol == symbol.upper())
        out = []
        for t in qry:
            r = db.row(t)
            r.pop("analysis")
            if q and q.lower() not in " ".join(str(v) for v in r.values()).lower():
                continue
            out.append(r)
        return out


@app.post("/api/trades")
def trade_open(r: TradeReq):
    return _call(S.open_trade, r.model_dump())


@app.get("/api/trades/{tid}")
def trade_get(tid: int):
    S.update_open_trades()
    return _call(S.trade_detail, tid)


@app.patch("/api/trades/{tid}")
def trade_notes(tid: int, r: NotesReq):
    with db.session() as s:
        t = s.get(db.Trade, tid)
        if not t:
            raise HTTPException(404, "Trade not found")
        t.notes = r.notes
        s.commit()
    return {"ok": True}


@app.delete("/api/trades/{tid}")
def trade_delete(tid: int):
    with db.session() as s:
        t = s.get(db.Trade, tid)
        if not t:
            raise HTTPException(404, "Trade not found")
        s.query(db.Lesson).filter_by(trade_id=tid).delete()
        s.query(db.Review).filter_by(trade_id=tid).delete()
        s.delete(t)
        s.commit()
    return {"ok": True}


@app.post("/api/trades/{tid}/close")
def trade_close(tid: int):
    return _call(S.close_trade, tid)


@app.post("/api/trades/{tid}/review")
def trade_review(tid: int):
    return _call(S.review_trade, tid)


@app.post("/api/trades/{tid}/narrative")
def trade_narrative(tid: int):
    ok, text = _call(S.narrate, tid)
    return {"ok": ok, "text": text}


@app.get("/api/trades/{tid}/replay")
def trade_replay(tid: int):
    return _call(S.replay, tid)


# ---------------------------------------------------------------- AI Brain

def _b(fn, *a):
    try:
        return fn(*a)
    except B.ImportError_ as e:
        raise HTTPException(400, str(e))


class ImportReq(BaseModel):
    url: str = Field(..., min_length=8, max_length=2000)
    kind: str = Field("auto", pattern="^(auto|youtube|tiktok|article|website)$")
    transcript: str = Field("", max_length=200_000)


class LayoutItem(BaseModel):
    key: str = Field(..., pattern=r"^(ai|cat:[a-z]+|n:\d+)$")
    x: float
    y: float


@app.get("/api/brain/graph")
def brain_graph():
    return B.graph()


@app.get("/api/brain/nodes/{nid}")
def brain_node(nid: int):
    return _b(B.node_detail, nid)


@app.put("/api/brain/layout")
def brain_layout(items: List[LayoutItem]):
    B.save_layout([i.model_dump() for i in items])
    return {"ok": True}


@app.delete("/api/brain/layout")
def brain_layout_reset():
    B.reset_layout()
    return {"ok": True}


@app.post("/api/brain/import")
def brain_import(r: ImportReq):
    return {"job_id": _b(B.start_import, r.url, r.kind, r.transcript)}


@app.get("/api/brain/jobs")
def brain_jobs():
    return B.jobs()


@app.get("/api/brain/jobs/{jid}")
def brain_job(jid: int):
    return _b(B.job, jid)


@app.get("/api/brain/sources")
def brain_sources():
    return B.sources()


@app.delete("/api/brain/sources/{sid}")
def brain_source_delete(sid: int):
    _b(B.delete_source, sid)
    return {"ok": True}


@app.get("/api/brain/history")
def brain_history():
    return B.history()


@app.get("/api/brain/strategy-lab")
def brain_lab():
    return B.strategy_lab()


# ---------------------------------------------------------------- built web app (single-process launch)

from pathlib import Path  # noqa: E402

from fastapi.responses import FileResponse  # noqa: E402

import os  # noqa: E402

DIST = Path(os.environ.get("VT_WEB_DIR") or Path(__file__).resolve().parent.parent / "web" / "dist").resolve()
if DIST.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = (DIST / path).resolve()
        if path and f.is_file() and DIST in f.parents:  # never serve outside dist/
            return FileResponse(f)
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        return FileResponse(DIST / "index.html")
