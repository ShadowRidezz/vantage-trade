"""Persistence. SQLite by default; set DATABASE_URL (e.g. postgresql+psycopg://...) to use PostgreSQL.
shortcut: tables are created with create_all, no Alembic migrations yet; add Alembic before the first schema change on real data."""
from __future__ import annotations

import os
import time

from sqlalchemy import JSON, Boolean, Column, Float, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

_DIR = os.environ.get("VT_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))  # the desktop app sets VT_DATA_DIR to AppData
os.makedirs(_DIR, exist_ok=True)
URL = os.environ.get("DATABASE_URL") or "sqlite:///" + os.path.join(_DIR, "vantage.db")
engine = create_engine(URL, connect_args={"check_same_thread": False} if URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def now():
    return time.time()


class Detection(Base):
    __tablename__ = "detections"
    id = Column(String, primary_key=True)
    symbol = Column(String, index=True)
    tf = Column(String, index=True)
    kind = Column(String, index=True)
    confirmed_at = Column(Integer)
    data = Column(JSON)
    first_seen = Column(Float, default=now)


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"
    id = Column(Integer, primary_key=True)
    symbol = Column(String, index=True)
    tf = Column(String)
    ran_at = Column(Float, default=now)
    last_bar = Column(Integer)
    provider = Column(String)
    steps = Column(JSON)
    summary = Column(JSON)


class Strategy(Base):
    __tablename__ = "strategies"
    id = Column(Integer, primary_key=True)
    key = Column(String, unique=True)
    name = Column(String)
    description = Column(Text)


class StrategyVersion(Base):
    __tablename__ = "strategy_versions"
    id = Column(Integer, primary_key=True)
    strategy_id = Column(Integer, ForeignKey("strategies.id"))
    version = Column(Integer)
    params = Column(JSON)
    parent_id = Column(Integer, ForeignKey("strategy_versions.id"), nullable=True)
    status = Column(String)  # active | candidate | validated | rejected | archived
    note = Column(Text, default="")
    created_at = Column(Float, default=now)


class Backtest(Base):
    __tablename__ = "backtests"
    id = Column(Integer, primary_key=True)
    version_id = Column(Integer, ForeignKey("strategy_versions.id"))
    symbol = Column(String)
    tf = Column(String)
    start = Column(Integer)
    end = Column(Integer)
    segment = Column(String, default="full")  # full | in_sample | out_of_sample
    experiment_id = Column(Integer, ForeignKey("experiments.id"), nullable=True)
    settings = Column(JSON)
    metrics = Column(JSON)
    equity = Column(JSON)
    trades = Column(JSON)
    created_at = Column(Float, default=now)


class Condition(Base):
    __tablename__ = "conditions"
    id = Column(Integer, primary_key=True)
    key = Column(String, unique=True)
    symbol = Column(String)
    tf = Column(String)
    bias = Column(String)
    zone = Column(String)


class Trade(Base):
    __tablename__ = "trades"
    id = Column(Integer, primary_key=True)
    symbol = Column(String, index=True)
    contract = Column(String)
    tf = Column(String)
    direction = Column(String)  # long | short
    qty = Column(Integer)
    entry_time = Column(Integer)
    entry_price = Column(Float)
    stop = Column(Float)
    target = Column(Float)
    exit_time = Column(Integer, nullable=True)
    exit_price = Column(Float, nullable=True)
    exit_reason = Column(String, nullable=True)
    status = Column(String, default="open")
    pnl = Column(Float, nullable=True)
    version_id = Column(Integer, ForeignKey("strategy_versions.id"), nullable=True)
    condition_id = Column(Integer, ForeignKey("conditions.id"), nullable=True)
    analysis = Column(JSON)
    detection_ids = Column(JSON)
    price_source = Column(String)
    notes = Column(Text, default="")
    created_at = Column(Float, default=now)


class Review(Base):
    __tablename__ = "reviews"
    id = Column(Integer, primary_key=True)
    trade_id = Column(Integer, ForeignKey("trades.id"), unique=True)
    facts = Column(JSON)
    narrative = Column(Text, nullable=True)
    created_at = Column(Float, default=now)


class Lesson(Base):
    __tablename__ = "lessons"
    id = Column(Integer, primary_key=True)
    source = Column(String)  # review | backtest | experiment
    code = Column(String, index=True)
    text = Column(Text)
    evidence = Column(JSON)
    trade_id = Column(Integer, ForeignKey("trades.id"), nullable=True)
    backtest_id = Column(Integer, ForeignKey("backtests.id"), nullable=True)
    experiment_id = Column(Integer, ForeignKey("experiments.id"), nullable=True)
    version_id = Column(Integer, ForeignKey("strategy_versions.id"), nullable=True)
    created_at = Column(Float, default=now)


class Experiment(Base):
    __tablename__ = "experiments"
    id = Column(Integer, primary_key=True)
    base_version_id = Column(Integer, ForeignKey("strategy_versions.id"))
    candidate_version_id = Column(Integer, ForeignKey("strategy_versions.id"), nullable=True)
    symbol = Column(String)
    tf = Column(String)
    change = Column(JSON)
    rationale = Column(Text)
    lesson_ids = Column(JSON)
    status = Column(String, default="proposed")  # proposed | accepted | rejected
    verdict = Column(JSON, nullable=True)
    created_at = Column(Float, default=now)


# ---------------------------------------------------------------- AI Brain knowledge graph

class KnowledgeNode(Base):
    __tablename__ = "knowledge_nodes"
    id = Column(Integer, primary_key=True)
    title = Column(String, index=True)
    category = Column(String, index=True)  # strategy | pattern | skill | condition | source | research
    summary = Column(Text, default="")
    detail = Column(Text, default="")
    rules = Column(JSON, nullable=True)  # strategies only: entry/exit/stop/target/filters as stated by the source
    verification = Column(String, default="imported")  # imported | corroborated | disputed | built-in rule | tested
    origin = Column(String, nullable=True, index=True)  # set for records synced from the app itself (engine, strategy, backtest, source)
    created_at = Column(Float, default=now)
    updated_at = Column(Float, default=now)


class KnowledgeEdge(Base):
    __tablename__ = "knowledge_edges"
    id = Column(Integer, primary_key=True)
    src_id = Column(Integer, ForeignKey("knowledge_nodes.id"), index=True)
    dst_id = Column(Integer, ForeignKey("knowledge_nodes.id"), index=True)
    rel = Column(String)  # RELATED_TO | USED_BY | EXPLAINED_BY | PART_OF | REQUIRES | SUPPORTS | CONTRADICTS | TESTED_BY | DERIVED_FROM
    explanation = Column(Text)
    source_id = Column(Integer, ForeignKey("knowledge_sources.id"), nullable=True)
    created_at = Column(Float, default=now)


class KnowledgeSource(Base):
    __tablename__ = "knowledge_sources"
    id = Column(Integer, primary_key=True)
    url = Column(String, index=True)
    platform = Column(String)  # youtube | tiktok | article | website
    title = Column(String)
    author = Column(String, nullable=True)
    published = Column(String, nullable=True)
    status = Column(String, default="processing")  # processing | complete | incomplete | failed
    complete = Column(Boolean, default=False)  # True only when the full content (article text / transcript) was analysed
    note = Column(Text, nullable=True)
    content_chars = Column(Integer, default=0)
    content_hash = Column(String, nullable=True)
    main_topic = Column(Text, nullable=True)
    claims = Column(JSON, nullable=True)  # claims the source makes that need independent verification
    imported_at = Column(Float, default=now)


class SourceKnowledgeLink(Base):
    __tablename__ = "source_knowledge_links"
    id = Column(Integer, primary_key=True)
    source_id = Column(Integer, ForeignKey("knowledge_sources.id"), index=True)
    node_id = Column(Integer, ForeignKey("knowledge_nodes.id"), index=True)
    excerpt = Column(Text, nullable=True)
    timestamp_ref = Column(String, nullable=True)
    created_at = Column(Float, default=now)


class ImportJob(Base):
    __tablename__ = "import_jobs"
    id = Column(Integer, primary_key=True)
    source_id = Column(Integer, ForeignKey("knowledge_sources.id"), nullable=True)
    url = Column(String)
    status = Column(String, default="running")  # running | done | incomplete | failed
    stage = Column(String, default="")
    steps = Column(JSON)
    error = Column(Text, nullable=True)
    result = Column(JSON, nullable=True)
    started_at = Column(Float, default=now)
    completed_at = Column(Float, nullable=True)


class KnowledgeRevision(Base):
    __tablename__ = "knowledge_revisions"
    id = Column(Integer, primary_key=True)
    node_id = Column(Integer, ForeignKey("knowledge_nodes.id"), index=True)
    previous = Column(Text, nullable=True)
    updated = Column(Text, nullable=True)
    reason = Column(Text)
    source_id = Column(Integer, ForeignKey("knowledge_sources.id"), nullable=True)
    created_at = Column(Float, default=now)


class BrainLayout(Base):
    __tablename__ = "brain_layout"
    key = Column(String, primary_key=True)  # "ai", "cat:pattern", "n:12"
    x = Column(Float)
    y = Column(Float)


def init():
    Base.metadata.create_all(engine)


def session() -> Session:
    return SessionLocal()


def row(o):
    return {c.name: getattr(o, c.name) for c in o.__table__.columns}
