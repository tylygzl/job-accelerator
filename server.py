"""求职加速器 2.0 · FastAPI 服务入口。"""

from __future__ import annotations

import io
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, Field, field_validator

from pipeline import (
    CHAT_REPLY_POLICY_VERSION,
    MatchReport,
    build_chat_reply_draft,
    llm_config_summary,
    make_chat_model,
    match_jd,
    resume_profile_from_text,
    summarize_jd_skills,
    summarize_resume_skills,
)


load_dotenv()
os.environ.setdefault("LANGSMITH_TRACING", "false")
os.environ.setdefault("LANGCHAIN_TRACING_V2", "false")


class MatchRequest(BaseModel):
    jd_text: str = Field(min_length=1, description="岗位描述全文")
    resume_text: str = ""
    mode: str = "fast"

    @field_validator("jd_text", mode="before")
    @classmethod
    def validate_jd_text(cls, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("jd_text 不能为空")
        return text

    @field_validator("resume_text", mode="before")
    @classmethod
    def normalize_resume_text_input(cls, value: Any) -> str:
        return str(value or "").strip()

    @field_validator("mode", mode="before")
    @classmethod
    def normalize_mode_input(cls, value: Any) -> str:
        return "smart" if str(value or "").strip().lower() == "smart" else "fast"


class ChatMessage(BaseModel):
    role: str = "hr"
    content: str = Field(default="", max_length=2000)

    @field_validator("role", mode="before")
    @classmethod
    def normalize_role_input(cls, value: Any) -> str:
        role = str(value or "hr").strip().lower()
        if role in {"hr", "recruiter", "boss", "interviewer", "company"}:
            return "hr"
        if role in {"me", "myself", "self"}:
            return "me"
        if role == "user":
            return "user"
        if role in {"candidate", "applicant", "jobseeker", "job_seeker"}:
            return "candidate"
        if role == "system":
            return "system"
        return "other"

    @field_validator("content", mode="before")
    @classmethod
    def normalize_content_input(cls, value: Any) -> str:
        return str(value or "").strip()


class ChatReplyRequest(BaseModel):
    hr_message: str = Field(
        min_length=1,
        max_length=2000,
        validation_alias=AliasChoices("hr_message", "latest_hr_message"),
        description="HR 最新一条消息",
    )
    conversation: list[ChatMessage] = Field(
        default_factory=list,
        max_length=20,
        validation_alias=AliasChoices("conversation", "chat_history"),
        description="最近几轮对话，最多 20 条",
    )
    job_title: str = Field(default="", max_length=120)
    company: str = Field(default="", max_length=120)
    city: str = Field(default="", max_length=80)
    salary: str = Field(default="", max_length=80)
    jd_text: str = Field(default="", max_length=8000)
    resume_text: str = Field(default="", max_length=8000)
    resume_profile: dict[str, Any] = Field(default_factory=dict)
    evidence_context: str = Field(default="", max_length=8000)
    evidence_sources: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("hr_message", mode="before")
    @classmethod
    def validate_hr_message(cls, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError("hr_message 不能为空")
        return text

    @field_validator("job_title", "company", "jd_text", "resume_text", "evidence_context", mode="before")
    @classmethod
    def normalize_optional_text_input(cls, value: Any) -> str:
        return str(value or "").strip()

    @field_validator("resume_profile", mode="before")
    @classmethod
    def normalize_resume_profile_input(cls, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    @field_validator("evidence_sources", mode="before")
    @classmethod
    def normalize_evidence_sources_input(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return []
        return [str(item or "").strip() for item in value if str(item or "").strip()]


class ApiResponse(BaseModel):
    success: bool
    data: Any = None
    message: str = ""
    request_id: str = ""


class ResumeParseResponse(BaseModel):
    ok: bool = True
    resume_text: str
    char_count: int
    page_count: int
    skill_count: int = 0
    skills_profile: dict[str, Any] = Field(default_factory=dict)
    warning: str = ""


def env_float(name: str, default: float) -> float:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return max(1.0, float(value))
    except ValueError:
        return default


def env_int(name: str, default: int, minimum: int = 1) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return max(minimum, int(value))
    except ValueError:
        return default


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name, "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def resolve_trace_path(value: str | None = None) -> Path:
    raw = str(value or "").strip() or "logs/match_trace.jsonl"
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    data_dir = Path(os.getenv("JOB_ACCELERATOR_DATA_DIR", str(Path.home() / ".job-accelerator"))).expanduser()
    return data_dir / path


@dataclass
class ConcurrencyGate:
    name: str
    limit: int
    _semaphore: threading.BoundedSemaphore = field(init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _in_flight: int = field(default=0, init=False, repr=False)

    def __post_init__(self) -> None:
        self.limit = max(1, int(self.limit))
        self._semaphore = threading.BoundedSemaphore(self.limit)

    def acquire(self) -> bool:
        acquired = self._semaphore.acquire(blocking=False)
        if acquired:
            with self._lock:
                self._in_flight += 1
        return acquired

    def release(self) -> None:
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
        self._semaphore.release()

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {"limit": self.limit, "in_flight": self._in_flight}


app = FastAPI(title="求职加速器", version="2.0.0")
_ACCESS_TOKEN = os.getenv("JOB_ACCELERATOR_ACCESS_TOKEN", "").strip()
_MAX_RESUME_PDF_BYTES = int(os.getenv("JOB_ACCELERATOR_MAX_RESUME_PDF_BYTES", str(5 * 1024 * 1024)))
_SMART_LLM_TIMEOUT_SECONDS = env_float("JOB_ACCELERATOR_SMART_LLM_TIMEOUT", 5.0)
_CHAT_REPLY_SLOW_TIMEOUT_SECONDS = env_float("JOB_ACCELERATOR_CHAT_REPLY_SLOW_TIMEOUT", 4.0)
_FAST_MATCH_GATE = ConcurrencyGate("fast_match", env_int("JOB_ACCELERATOR_FAST_CONCURRENCY", 8))
_SMART_MATCH_GATE = ConcurrencyGate("smart_match", env_int("JOB_ACCELERATOR_SMART_CONCURRENCY", 1))
_CHAT_REPLY_GATE = ConcurrencyGate("chat_reply", env_int("JOB_ACCELERATOR_CHAT_REPLY_CONCURRENCY", 2))
_PDF_PARSE_GATE = ConcurrencyGate("pdf_parse", env_int("JOB_ACCELERATOR_PDF_CONCURRENCY", 2))
_RATE_LIMIT_PER_MINUTE = env_int("JOB_ACCELERATOR_RATE_LIMIT_PER_MINUTE", 120, minimum=0)
_TRACE_ENABLED = env_bool("JOB_ACCELERATOR_TRACE_ENABLED", False)
_TRACE_DETAIL = os.getenv("JOB_ACCELERATOR_TRACE_DETAIL", "summary").strip().lower() or "summary"
_TRACE_PATH = resolve_trace_path(os.getenv("JOB_ACCELERATOR_TRACE_PATH"))
_TRACE_PREVIEW_CHARS = env_int("JOB_ACCELERATOR_TRACE_PREVIEW_CHARS", 400, minimum=0)
_TRACE_FIELD_CHARS = env_int("JOB_ACCELERATOR_TRACE_FIELD_CHARS", 500, minimum=80)
_TRACE_LOCK = threading.Lock()
_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_BUCKETS: dict[str, deque[float]] = {}
_STARTED_AT = time.time()
_STATS_LOCK = threading.Lock()
_STATS: dict[str, int] = {
    "match_total": 0,
    "match_ok": 0,
    "match_fallback": 0,
    "match_rejected": 0,
    "chat_reply_total": 0,
    "chat_reply_ok": 0,
    "chat_reply_fallback": 0,
    "chat_reply_rejected": 0,
    "resume_parse_total": 0,
    "resume_parse_ok": 0,
    "resume_parse_rejected": 0,
    "rate_limited": 0,
    "unauthorized": 0,
    "errors": 0,
}
logger = logging.getLogger("uvicorn.error")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    request.state.request_id = request.headers.get("x-request-id", "").strip() or uuid.uuid4().hex[:12]
    response = await call_next(request)
    response.headers["X-Job-Accelerator-Request-Id"] = request.state.request_id
    return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    record_stat("errors")
    errors = compact_validation_errors(exc)
    log_event(logging.WARNING, "validation_error", request, errors=errors)
    return JSONResponse(
        status_code=422,
        content=api_error("输入参数校验失败", request, data={"errors": errors}),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    log_event(logging.WARNING, "http_exception", request, status=exc.status_code, detail=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content=api_error(str(exc.detail), request),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    record_stat("errors")
    logger.exception(
        "job_accelerator unhandled_exception request_id=%s path=%s client=%s",
        request_id(request),
        request.url.path,
        client_identity(request),
    )
    return JSONResponse(
        status_code=500,
        content=api_error("服务器内部错误，请联系开发者查看日志", request),
    )


def public_llm_config_summary() -> dict[str, Any]:
    summary = dict(llm_config_summary())
    summary.pop("base_url", None)
    return summary


def public_trace_summary() -> dict[str, Any]:
    summary = trace_summary()
    return {
        "enabled": bool(summary.get("enabled")),
        "detail": str(summary.get("detail") or "summary"),
        "path_configured": bool(summary.get("path")),
    }


@app.get("/health", response_model=ApiResponse)
def health(raw_request: Request) -> dict:
    data = {
        "ok": True,
        "service": "job-accelerator",
        "version": app.version,
        "auth_required": bool(_ACCESS_TOKEN),
        "smart_llm_timeout_seconds": _SMART_LLM_TIMEOUT_SECONDS,
        "chat_reply_slow_timeout_seconds": _CHAT_REPLY_SLOW_TIMEOUT_SECONDS,
        "limits": {
            "fast_match": _FAST_MATCH_GATE.snapshot(),
            "smart_match": _SMART_MATCH_GATE.snapshot(),
            "chat_reply": _CHAT_REPLY_GATE.snapshot(),
            "pdf_parse": _PDF_PARSE_GATE.snapshot(),
            "rate_limit_per_minute": _RATE_LIMIT_PER_MINUTE,
            "max_resume_pdf_mb": round(_MAX_RESUME_PDF_BYTES / 1024 / 1024, 2),
        },
        "runtime": runtime_summary(),
        "trace": public_trace_summary(),
        "llm": public_llm_config_summary(),
    }
    return api_success(data, "服务正常", raw_request)


@app.post("/match", response_model=ApiResponse)
def match(request: MatchRequest, raw_request: Request) -> dict:
    verify_access_token(raw_request)
    check_rate_limit(raw_request, "match")
    started = time.perf_counter()
    jd_text = request.jd_text.strip()
    if not jd_text:
        raise HTTPException(status_code=400, detail="jd_text 不能为空")
    mode = normalize_match_mode(request.mode)
    gate: ConcurrencyGate | None = None
    gate_acquired = False
    engine = ""
    result: dict[str, Any] | None = None
    record_stat("match_total")
    try:
        if mode == "fast":
            gate = _FAST_MATCH_GATE
            if not gate.acquire():
                record_stat("match_rejected")
                raise HTTPException(status_code=429, detail="快速匹配请求过多，请稍后重试")
            gate_acquired = True
            result = local_match(jd_text, request.resume_text or "")
            engine = "local"
        elif not _SMART_MATCH_GATE.acquire():
            gate = _FAST_MATCH_GATE
            if not gate.acquire():
                record_stat("match_rejected")
                raise HTTPException(status_code=429, detail="智能分析正忙，快速兜底请求也较多，请稍后重试")
            gate_acquired = True
            record_stat("match_fallback")
            result = local_match(jd_text, request.resume_text or "", "智能分析正忙，已用快速模式兜底，不影响继续海投。")
            engine = "smart_busy_fallback"
        else:
            gate = _SMART_MATCH_GATE
            gate_acquired = True
            result = smart_match(jd_text, request.resume_text or "")
            engine = str(result.pop("_engine", "smart"))
            if engine != "smart":
                record_stat("match_fallback")
        record_stat("match_ok")
        log_event(
            logging.INFO,
            "match_ok",
            raw_request,
            mode=mode,
            engine=engine,
            score=result.get("match_score"),
            risk=result.get("risk_level"),
            jd_chars=len(jd_text),
            resume_chars=len(request.resume_text or ""),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        write_match_trace(raw_request, request, mode, engine, result, started=started, status="ok")
        return api_success(strip_private_fields(result), "匹配成功", raw_request)
    except ValueError as exc:
        log_event(
            logging.WARNING,
            "match_bad_request",
            raw_request,
            mode=mode,
            jd_chars=len(jd_text),
            resume_chars=len(request.resume_text or ""),
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=exc,
        )
        write_match_trace(raw_request, request, mode, engine, result, started=started, status="bad_request", error=exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException as exc:
        log_event(
            logging.WARNING,
            "match_http_error",
            raw_request,
            mode=mode,
            status=exc.status_code,
            detail=exc.detail,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        write_match_trace(raw_request, request, mode, engine, result, started=started, status=f"http_{exc.status_code}", error=exc.detail)
        raise
    except Exception as exc:
        record_stat("errors")
        log_event(
            logging.ERROR,
            "match_failed",
            raw_request,
            mode=mode,
            jd_chars=len(jd_text),
            resume_chars=len(request.resume_text or ""),
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=exc,
        )
        write_match_trace(raw_request, request, mode, engine, result, started=started, status="error", error=exc)
        raise HTTPException(status_code=500, detail=f"匹配失败：{exc}") from exc
    finally:
        if gate is not None and gate_acquired:
            gate.release()


@app.post("/chat/reply", response_model=ApiResponse)
def chat_reply(request: ChatReplyRequest, raw_request: Request) -> dict:
    verify_access_token(raw_request)
    check_rate_limit(raw_request, "chat_reply")
    started = time.perf_counter()
    record_stat("chat_reply_total")
    if not _CHAT_REPLY_GATE.acquire():
        record_stat("chat_reply_rejected")
        record_stat("chat_reply_fallback")
        result = chat_reply_busy_fallback(started)
        log_event(
            logging.WARNING,
            "chat_reply_rejected",
            raw_request,
            intent=result.get("intent"),
            risk=result.get("risk_level"),
            should_fill=result.get("should_fill"),
            action_policy=result.get("action_policy"),
            reply_mode=result.get("reply_mode"),
            evidence_relation=result.get("evidence_relation"),
            message_chars=len(request.hr_message),
            history_count=len(request.conversation),
            duration_ms=result.get("duration_ms"),
        )
        return api_success(result, "回复草稿服务繁忙，已返回兜底结果", raw_request)

    try:
        evidence_context = "\n".join(
            item
            for item in [
                request.evidence_context,
                f"城市：{request.city}" if request.city else "",
                f"薪资：{request.salary}" if request.salary else "",
            ]
            if item
        )
        result = build_chat_reply_draft(
            hr_message=request.hr_message,
            conversation=[item.model_dump() for item in request.conversation],
            job_title=request.job_title,
            company=request.company,
            jd_text=request.jd_text,
            resume_text=request.resume_text,
            resume_profile=request.resume_profile,
            evidence_context=evidence_context,
            evidence_sources=request.evidence_sources,
            llm_timeout_seconds=_CHAT_REPLY_SLOW_TIMEOUT_SECONDS,
        )
        reply_mode = str(result.get("reply_mode") or "")
        is_fallback = reply_mode == "fallback"
        record_stat("chat_reply_fallback" if is_fallback else "chat_reply_ok")
        log_event(
            logging.WARNING if is_fallback else logging.INFO,
            "chat_reply_fallback" if is_fallback else "chat_reply_ok",
            raw_request,
            intent=result.get("intent"),
            risk=result.get("risk_level"),
            should_fill=result.get("should_fill"),
            action_policy=result.get("action_policy"),
            reply_mode=result.get("reply_mode"),
            evidence_relation=result.get("evidence_relation"),
            message_chars=len(request.hr_message),
            history_count=len(request.conversation),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        return api_success(strip_private_fields(result), "回复草稿生成成功", raw_request)
    except ValueError as exc:
        log_event(
            logging.WARNING,
            "chat_reply_bad_request",
            raw_request,
            message_chars=len(request.hr_message),
            history_count=len(request.conversation),
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=exc,
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        record_stat("errors")
        log_event(
            logging.ERROR,
            "chat_reply_failed",
            raw_request,
            message_chars=len(request.hr_message),
            history_count=len(request.conversation),
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=exc,
        )
        raise HTTPException(status_code=500, detail=f"回复草稿生成失败：{exc}") from exc
    finally:
        _CHAT_REPLY_GATE.release()


@app.post("/resume/parse", response_model=ApiResponse)
async def parse_resume_pdf(raw_request: Request, file: UploadFile = File(...)) -> dict:
    verify_access_token(raw_request)
    check_rate_limit(raw_request, "resume_parse")
    if not _PDF_PARSE_GATE.acquire():
        record_stat("resume_parse_rejected")
        raise HTTPException(status_code=429, detail="服务器正在解析其他简历，请稍后重试")
    record_stat("resume_parse_total")
    started = time.perf_counter()
    try:
        filename = file.filename or "resume.pdf"
        if not filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="目前只支持 PDF 简历")

        content = await file.read(_MAX_RESUME_PDF_BYTES + 1)
        if len(content) > _MAX_RESUME_PDF_BYTES:
            raise HTTPException(status_code=413, detail="PDF 文件过大，请控制在 5MB 内")

        text, page_count = extract_pdf_text(content)
        text = normalize_resume_text(text)
        if len(text) < 30:
            raise HTTPException(status_code=400, detail="PDF 没有提取到有效文字，可能是扫描件或图片版简历")

        skills_profile: dict[str, Any] = {}
        warning = ""
        try:
            skills_profile = resume_profile_from_text(text, llm=False)
        except Exception as exc:
            warning = f"简历技能画像提取失败，已保留原始文本：{exc}"

        skill_count = count_profile_items(skills_profile)
        record_stat("resume_parse_ok")
        log_event(
            logging.INFO,
            "resume_parse_ok",
            raw_request,
            pages=page_count,
            chars=len(text),
            skills=skill_count,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        data = {
            "ok": True,
            "resume_text": text,
            "char_count": len(text),
            "page_count": page_count,
            "skill_count": skill_count,
            "skills_profile": skills_profile,
            "warning": warning,
        }
        return api_success(data, "PDF 简历解析成功", raw_request)
    except HTTPException as exc:
        log_event(
            logging.WARNING,
            "resume_parse_http_error",
            raw_request,
            status=exc.status_code,
            detail=exc.detail,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        raise
    except Exception as exc:
        record_stat("errors")
        log_event(
            logging.ERROR,
            "resume_parse_failed",
            raw_request,
            duration_ms=int((time.perf_counter() - started) * 1000),
            error=exc,
        )
        raise
    finally:
        _PDF_PARSE_GATE.release()


def verify_access_token(request: Request) -> None:
    if not _ACCESS_TOKEN:
        return
    token = request.headers.get("x-job-accelerator-token", "").strip()
    auth = request.headers.get("authorization", "").strip()
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    if token != _ACCESS_TOKEN:
        record_stat("unauthorized")
        log_event(logging.WARNING, "auth_failed", request)
        raise HTTPException(status_code=401, detail="访问令牌错误或缺失")


def check_rate_limit(request: Request, scope: str) -> None:
    if _RATE_LIMIT_PER_MINUTE <= 0:
        return

    now = time.time()
    window_start = now - 60
    key = f"{client_identity(request)}:{scope}"
    with _RATE_LIMIT_LOCK:
        bucket = _RATE_LIMIT_BUCKETS.setdefault(key, deque())
        while bucket and bucket[0] < window_start:
            bucket.popleft()
        if len(bucket) >= _RATE_LIMIT_PER_MINUTE:
            record_stat("rate_limited")
            log_event(logging.WARNING, "rate_limited", request, scope=scope, limit=_RATE_LIMIT_PER_MINUTE)
            raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
        bucket.append(now)
        cleanup_rate_limit_buckets(window_start)


def cleanup_rate_limit_buckets(window_start: float) -> None:
    stale_keys = [key for key, bucket in _RATE_LIMIT_BUCKETS.items() if not bucket or bucket[-1] < window_start]
    for key in stale_keys[:100]:
        _RATE_LIMIT_BUCKETS.pop(key, None)


def client_identity(request: Request) -> str:
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def record_stat(name: str, amount: int = 1) -> None:
    with _STATS_LOCK:
        _STATS[name] = _STATS.get(name, 0) + amount


def runtime_summary() -> dict[str, Any]:
    with _STATS_LOCK:
        stats = dict(_STATS)
    return {
        "uptime_seconds": int(time.time() - _STARTED_AT),
        "stats": stats,
    }


def trace_summary() -> dict[str, Any]:
    return {
        "enabled": _TRACE_ENABLED,
        "detail": trace_detail(),
        "path": str(_TRACE_PATH),
    }


def request_id(request: Request | None) -> str:
    if request is None:
        return "-"
    return str(getattr(request.state, "request_id", "") or "-")


def api_success(data: Any, message: str = "ok", request: Request | None = None) -> dict[str, Any]:
    return {
        "success": True,
        "data": data,
        "message": message,
        "request_id": request_id(request),
    }


def api_error(message: str, request: Request | None = None, data: Any = None) -> dict[str, Any]:
    return {
        "success": False,
        "data": data,
        "message": message or "请求失败",
        "request_id": request_id(request),
    }


def strip_private_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): strip_private_fields(item)
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, list):
        return [strip_private_fields(item) for item in value]
    return value


def compact_validation_errors(exc: RequestValidationError) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    for item in exc.errors():
        loc = ".".join(str(part) for part in item.get("loc", []) if part != "body")
        errors.append(
            {
                "field": loc or "body",
                "message": str(item.get("msg", "invalid value")),
                "type": str(item.get("type", "")),
            }
        )
    return errors[:10]


def log_event(level: int, event: str, request: Request | None = None, **fields: Any) -> None:
    payload: dict[str, Any] = {"event": event}
    if request is not None:
        payload.update(
            {
                "request_id": request_id(request),
                "client": client_identity(request),
                "path": request.url.path,
            }
        )
    payload.update(fields)
    message = "job_accelerator " + " ".join(f"{key}={log_value(value)}" for key, value in payload.items())
    if level >= logging.ERROR:
        logger.error(message)
    elif level >= logging.WARNING:
        logger.warning(message)
    else:
        logger.info(message)


def log_value(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, (int, float, bool)):
        return str(value).lower()
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    if not text:
        return "-"
    if any(ch.isspace() for ch in text) or any(ch in text for ch in ['"', "=", "|"]):
        return json.dumps(text, ensure_ascii=False)
    return text


def trace_detail() -> str:
    return "summary"


def write_match_trace(
    raw_request: Request,
    match_request: MatchRequest,
    mode: str,
    engine: str,
    result: dict[str, Any] | None,
    *,
    started: float,
    status: str,
    error: Any = None,
) -> None:
    if not _TRACE_ENABLED:
        return

    try:
        result_trace = dict((result or {}).get("_trace") or {})
        duration_ms = int((time.perf_counter() - started) * 1000)
        llm_called = any(
            bool(result_trace.get(key))
            for key in ["llm_resume_extractor_called", "llm_matcher_called", "llm_opening_called"]
        )
        payload = {
            "trace_id": request_id(raw_request),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "client": client_identity(raw_request),
            "path": raw_request.url.path,
            "mode": mode,
            "engine": engine or "",
            "duration_ms": duration_ms,
            "user_input": build_trace_user_input(match_request),
            "job_skills": safe_trace_skill_summary(
                result_trace.get("jd_skills") or safe_summarize_jd(match_request.jd_text)
            ),
            "resume_skills": safe_trace_skill_summary(
                result_trace.get("resume_skills") or safe_summarize_resume(match_request.resume_text)
            ),
            "match_score": (result or {}).get("match_score"),
            "risk_level": (result or {}).get("risk_level"),
            "matched_skills": safe_trace_match_items((result or {}).get("matched_skills", []), matched=True),
            "missing_skills": safe_trace_match_items((result or {}).get("missing_skills", []), matched=False),
            "llm_called": llm_called,
            "llm": safe_trace_llm_summary(result_trace, llm_called=llm_called, engine=engine, duration_ms=duration_ms),
            "error_reason": trace_error(error),
        }
        append_jsonl(_TRACE_PATH, payload)
    except Exception as exc:  # pragma: no cover - trace must never break matching
        logger.warning("job_accelerator trace_write_failed error=%s", log_value(exc))


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _TRACE_LOCK:
        with path.open("a", encoding="utf-8") as file:
            file.write(line + "\n")


def build_trace_user_input(match_request: MatchRequest) -> dict[str, Any]:
    return {
        "jd_text": trace_text_value(match_request.jd_text),
        "resume_text": trace_text_value(match_request.resume_text or ""),
    }


def trace_text_value(text: str) -> dict[str, Any]:
    raw = text or ""
    return {
        "chars": len(raw),
        "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest() if raw else "",
    }


def text_preview(text: str, limit: int) -> str:
    compact = " ".join((text or "").replace("\r", "\n").split())
    if limit <= 0:
        return ""
    return compact if len(compact) <= limit else compact[:limit].rstrip() + "..."


def safe_summarize_jd(jd_text: str) -> dict[str, Any]:
    try:
        return summarize_jd_skills(jd_text or "")
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def safe_summarize_resume(resume_text: str) -> dict[str, Any]:
    try:
        return summarize_resume_skills(resume_text or "")
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def safe_trace_skill_summary(value: Any) -> dict[str, Any]:
    summary: dict[str, Any] = {"counts": {}, "skills": []}
    skills: list[dict[str, str]] = []

    def collect(group_name: str, items: Any) -> None:
        item_list = items if isinstance(items, list) else []
        summary["counts"][group_name] = len(item_list)
        for item in item_list[:20]:
            skill = safe_trace_skill_item(item, group_name)
            if skill:
                skills.append(skill)

    if isinstance(value, dict):
        nested_skills = value.get("skills")
        if isinstance(nested_skills, dict):
            for group in ["must_have", "familiar"]:
                collect(group, nested_skills.get(group))

        for group in ["required", "preferred"]:
            collect(group, value.get(group))

        for count_only in ["soft_skills", "keywords", "projects", "public_profiles", "missing_skills", "matched_skills"]:
            if isinstance(value.get(count_only), list):
                summary["counts"][count_only] = len(value.get(count_only) or [])
    elif isinstance(value, list):
        collect("items", value)
    elif value:
        summary["counts"]["unknown"] = 1

    summary["skills"] = dedupe_trace_skill_items(skills)[:40]
    summary["counts"]["skills"] = len(summary["skills"])
    return summary


def safe_trace_skill_item(item: Any, category: str) -> dict[str, str] | None:
    if isinstance(item, dict):
        skill = safe_trace_label(item.get("skill") or item.get("name"))
        item_category = safe_trace_label(item.get("category") or item.get("priority") or category)
        level = safe_trace_label(item.get("level"))
    else:
        skill = safe_trace_label(item)
        item_category = category
        level = ""
    if not skill:
        return None
    result = {"skill": skill, "category": item_category or category}
    if level:
        result["level"] = level
    return result


def safe_trace_label(value: Any, limit: int = 60) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text:
        return ""
    if re.search(r"\d{7,}", text) or "@" in text or len(text) > limit:
        return ""
    return text


def dedupe_trace_skill_items(items: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()
    result: list[dict[str, str]] = []
    for item in items:
        key = (item.get("skill", ""), item.get("category", ""), item.get("level", ""))
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def safe_trace_match_items(items: Any, *, matched: bool) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    item_list = items if isinstance(items, list) else []
    for item in item_list[:30]:
        if isinstance(item, dict):
            skill = safe_trace_label(item.get("skill"))
            level = safe_trace_label(item.get("level")) if matched else ""
        else:
            skill = safe_trace_label(item)
            level = ""
        if not skill:
            continue
        entry = {"skill": skill}
        if level:
            entry["level"] = level
        result.append(entry)
    return result


def safe_trace_llm_summary(
    result_trace: dict[str, Any],
    *,
    llm_called: bool,
    engine: str,
    duration_ms: int,
) -> dict[str, Any]:
    called_paths = [
        name
        for name, key in [
            ("resume_extractor", "llm_resume_extractor_called"),
            ("matcher", "llm_matcher_called"),
            ("opening", "llm_opening_called"),
        ]
        if bool(result_trace.get(key))
    ]
    error_keys = ["llm_opening_error", "resume_profile_error", "smart_error"]
    failed = any(bool(result_trace.get(key)) for key in error_keys)
    llm_return = result_trace.get("llm_matcher_result") or result_trace.get("llm_opening_result") or {}
    return {
        "called": llm_called,
        "available": bool(result_trace.get("llm_available")),
        "path": engine or "",
        "called_paths": called_paths,
        "success": bool(llm_called and not failed),
        "failed": bool(failed),
        "duration_ms": duration_ms,
        "return": safe_trace_value_fingerprint(llm_return),
        "errors": {
            key: safe_trace_value_fingerprint(result_trace.get(key))
            for key in error_keys
            if result_trace.get(key)
        },
    }


def safe_trace_value_fingerprint(value: Any) -> dict[str, Any]:
    if value is None or value == "":
        return {"chars": 0, "sha256": ""}
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        raw = str(value)
    return {
        "chars": len(raw),
        "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
    }


def compact_trace_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): compact_trace_payload(item) for key, item in value.items()}
    if isinstance(value, list):
        return [compact_trace_payload(item) for item in value[:30]]
    if isinstance(value, tuple):
        return [compact_trace_payload(item) for item in value[:30]]
    if isinstance(value, str):
        return text_preview(value, _TRACE_FIELD_CHARS)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return text_preview(str(value), _TRACE_FIELD_CHARS)


def trace_error(error: Any) -> str:
    if error is None:
        return ""
    if isinstance(error, HTTPException):
        return f"http_{error.status_code}"
    return type(error).__name__ if isinstance(error, Exception) else type(error).__name__


def normalize_match_mode(value: str) -> str:
    return "smart" if str(value or "").strip().lower() == "smart" else "fast"


def local_match(jd_text: str, resume_text: str, note: str = "") -> dict:
    result = match_jd(jd_text, resume_text=resume_text or "", llm=False, include_trace=True)
    if note:
        add_match_note(result, note)
    return result


def smart_match(jd_text: str, resume_text: str) -> dict:
    try:
        llm = make_chat_model(json_mode=True, timeout=_SMART_LLM_TIMEOUT_SECONDS, max_retries=0)
    except Exception as exc:
        log_event(logging.WARNING, "smart_llm_init_failed", error=exc)
        result = local_match(jd_text, resume_text, "智能分析暂时不可用，已用快速模式兜底。")
        result.setdefault("_trace", {})["smart_error"] = f"{type(exc).__name__}: {exc}"
        result["_engine"] = "smart_local_fallback"
        return result

    if llm is None:
        result = local_match(jd_text, resume_text, "未配置可用模型，已用快速模式兜底。")
        result.setdefault("_trace", {})["smart_error"] = "llm_not_configured"
        result["_engine"] = "smart_local_fallback"
        return result

    try:
        skills_profile = resume_profile_from_text(resume_text, llm=False) if (resume_text or "").strip() else None
        return match_jd(
            jd_text,
            resume_text="" if skills_profile else (resume_text or ""),
            skills_profile=skills_profile,
            llm=llm,
            llm_opening=False,
            include_trace=True,
        )
    except Exception as exc:
        log_event(logging.WARNING, "smart_match_failed", error=exc)
        result = local_match(jd_text, resume_text, "智能分析超时或失败，已用快速模式兜底。")
        result.setdefault("_trace", {})["smart_error"] = f"{type(exc).__name__}: {exc}"
        result["_engine"] = "smart_local_fallback"
        return result


def add_match_note(result: dict, note: str) -> None:
    suggestions = list(result.get("suggestions") or [])
    if note and note not in suggestions:
        suggestions.insert(0, note)
    result["suggestions"] = suggestions[:5]


def chat_reply_busy_fallback(started: float) -> dict[str, Any]:
    return {
        "intent": "unknown",
        "evidence_relation": "none",
        "evidence": [],
        "missing_evidence": ["chat_reply 并发槽位"],
        "risk_level": "medium",
        "should_fill": False,
        "action_policy": "ask_user",
        "reply_mode": "fallback",
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "draft": "",
        "reason": "聊天回复草稿服务正在处理其他请求，已返回结构化兜底结果；不影响 /match 快速海投接口。",
        "policy_version": CHAT_REPLY_POLICY_VERSION,
    }


def extract_pdf_text(content: bytes) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except Exception as exc:  # pragma: no cover - depends on deployed optional package
        raise HTTPException(status_code=500, detail="服务器未安装 PDF 解析依赖 pypdf") from exc

    try:
        reader = PdfReader(io.BytesIO(content))
        pages = reader.pages
        text = "\n\n".join((page.extract_text() or "").strip() for page in pages)
        return text, len(pages)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"PDF 解析失败：{exc}") from exc


def normalize_resume_text(text: str) -> str:
    lines = [line.strip() for line in (text or "").replace("\r", "\n").splitlines()]
    return "\n".join(line for line in lines if line)


def count_profile_items(profile: dict[str, Any]) -> int:
    skills = profile.get("skills", {}) if isinstance(profile, dict) else {}
    projects = profile.get("projects", []) if isinstance(profile, dict) else []
    total = 0
    if isinstance(skills, dict):
        total += len(skills.get("must_have") or [])
        total += len(skills.get("familiar") or [])
    if isinstance(projects, list):
        total += len(projects)
    return total


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
