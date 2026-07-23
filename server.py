"""求职加速器 2.0 · FastAPI 服务入口。"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from pipeline import MatchReport, match_jd


load_dotenv()
os.environ.setdefault("LANGSMITH_TRACING", "false")
os.environ.setdefault("LANGCHAIN_TRACING_V2", "false")


class MatchRequest(BaseModel):
    jd_text: str = Field(min_length=1, description="岗位描述全文")
    resume_text: str = ""


app = FastAPI(title="求职加速器", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.post("/match", response_model=MatchReport)
def match(request: MatchRequest) -> dict:
    jd_text = request.jd_text.strip()
    if not jd_text:
        raise HTTPException(status_code=400, detail="jd_text 不能为空")
    try:
        return match_jd(jd_text, resume_text=request.resume_text or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"匹配失败：{exc}") from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
