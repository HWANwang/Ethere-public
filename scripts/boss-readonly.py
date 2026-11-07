"""Narrow, read-only BOSS adapter. Run with the isolated boss-cli virtualenv.

Unlike boss-cli's normal commands, this entry point never scans browser cookie
stores and never exposes greeting, application, chat, or profile methods.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from boss_cli.auth import Credential
from boss_cli.client import BossClient, list_cities, resolve_city
from boss_cli.exceptions import SessionExpiredError
from boss_cli.constants import (
    DEGREE_CODES,
    EXP_CODES,
    INDUSTRY_CODES,
    JOB_TYPE_CODES,
    SALARY_CODES,
    SCALE_CODES,
    STAGE_CODES,
)


def credential_path() -> Path:
    value = os.environ.get("ETHERE_BOSS_CREDENTIAL_FILE", "")
    if not value:
        raise ValueError("缺少 BOSS 专用凭证路径")
    return Path(value).resolve()


def load_credential() -> Credential:
    path = credential_path()
    if not path.is_file():
        raise ValueError("BOSS 尚未完成专用浏览器登录")
    data = json.loads(path.read_text(encoding="utf-8"))
    credential = Credential.from_dict(data)
    if not credential.has_required_cookies:
        raise ValueError("BOSS 登录状态不完整，请重新打开专用浏览器授权")
    return credential


def selected_code(mapping: dict, value: str | None, label: str) -> str | None:
    if not value:
        return None
    if value not in mapping:
        raise ValueError(f"不支持的{label}筛选值")
    return mapping[value]


def compact_job(job: dict) -> dict:
    keys = (
        "jobName", "salaryDesc", "brandName", "cityName", "areaDistrict",
        "businessDistrict", "jobExperience", "jobDegree", "skills",
        "encryptJobId", "securityId", "lid", "welfareList",
    )
    compact = {key: job[key] for key in keys if key in job}
    job_url = official_job_url(job.get("encryptJobId"))
    if job_url:
        compact["jobUrl"] = job_url
    return compact


def official_job_url(encrypt_job_id: object) -> str | None:
    job_id = str(encrypt_job_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_~\-]{8,128}", job_id):
        return None
    return f"https://www.zhipin.com/job_detail/{job_id}.html"


def run_readonly(request: dict) -> dict:
    operation = request.get("operation")
    if operation == "status":
        path = credential_path()
        return {"loginReady": path.is_file(), "needsBrowserLogin": not path.is_file()}
    credential = load_credential()
    with BossClient(credential, request_delay=0.2) as client:
        if operation == "search":
            keyword = str(request.get("keyword", "")).strip()
            if not keyword or len(keyword) > 80:
                raise ValueError("搜索关键词长度须为 1–80 字")
            page = int(request.get("page", 1))
            if page < 1 or page > 5:
                raise ValueError("页码须在 1–5 之间")
            city = str(request.get("city", "全国")).strip() or "全国"
            if city not in list_cities() and not (city.isdigit() and len(city) >= 6):
                raise ValueError("暂不支持该城市，请换用城市名或城市代码")
            result = client.search_jobs(
                query=keyword, city=resolve_city(city), page=page, page_size=15,
                salary=selected_code(SALARY_CODES, request.get("salary"), "薪资"),
                experience=selected_code(EXP_CODES, request.get("experience"), "经验"),
                degree=selected_code(DEGREE_CODES, request.get("degree"), "学历"),
                industry=selected_code(INDUSTRY_CODES, request.get("industry"), "行业"),
                scale=selected_code(SCALE_CODES, request.get("scale"), "规模"),
                stage=selected_code(STAGE_CODES, request.get("stage"), "融资阶段"),
                job_type=selected_code(JOB_TYPE_CODES, request.get("jobType"), "工作类型"),
            )
            return {
                "jobs": [compact_job(item) for item in result.get("jobList", [])[:15]],
                "hasMore": bool(result.get("hasMore")),
                "page": page,
            }
        if operation == "detail":
            security_id = str(request.get("securityId", "")).strip()
            if not security_id or len(security_id) > 1024 or not all(33 <= ord(c) <= 126 for c in security_id):
                raise ValueError("无效的职位标识")
            result = client.get_job_detail(security_id=security_id)
            job = result.get("jobInfo", result)
            brand = result.get("brandComInfo", {})
            compact = {key: job[key] for key in (
                    "jobName", "salaryDesc", "experienceName", "degreeName",
                    "locationName", "skills", "postDescription", "jobDesc",
                    "encryptJobId",
                ) if key in job}
            if "postDescription" not in compact and "jobDesc" not in compact and result.get("jobDesc"):
                compact["jobDesc"] = result["jobDesc"]
            job_url = official_job_url(job.get("encryptJobId") or request.get("encryptJobId"))
            if job_url:
                compact["jobUrl"] = job_url
            return {
                "job": compact,
                "company": {key: brand[key] for key in (
                    "brandName", "industryName", "scaleName", "stageName",
                ) if key in brand},
            }
    raise ValueError("仅支持状态、搜索和职位详情")


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("请求格式错误")
        data = run_readonly(request)
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
        return 0
    except Exception as error:
        # Never echo cookies, HTTP response bodies, or traceback into MCP.
        message = str(error)
        if isinstance(error, SessionExpiredError):
            message = "BOSS 安全校验未通过（37）；当前静态登录快照可能失效，请不要反复扫码，需改进会话续期方式"
        elif not isinstance(error, ValueError):
            message = "BOSS 查询失败，请检查登录状态或稍后重试"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
