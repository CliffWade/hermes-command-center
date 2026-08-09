"""command-center plugin backend: read-only health + activity dashboard.

Mounted by the Hermes backend under /api/plugins/command-center/.

Answers "what is my Hermes doing?" in one place:
  - /overview  — active processes, today's tokens, cron health, error count, memory fill
  - /cron      — job definitions + recent executions (from cron/executions.db)
  - /plugins   — installed backend plugins + desktop plugins, versions, staleness
  - /models    — per-model token + cost breakdown (session_model_usage)
  - /skills    — skill usage stats from ~/.hermes/skills/.usage.json
  - /memory    — always-on memory + fact store health

Read-only everywhere. No writes, no state, no daemons.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()


# ── helpers ────────────────────────────────────────────────────────────────

def _hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    return Path.home() / ".hermes"


def _f(v, nd=4):
    try:
        return round(float(v or 0), nd)
    except (TypeError, ValueError):
        return 0.0


def _int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _read_json(path: Path) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _db():
    """Open the Hermes state DB via SessionDB (same pattern as status-cost)."""
    from hermes_state import SessionDB
    return SessionDB()


def _query(sql: str, params: tuple = ()) -> list:
    """Run a read-only query against state.db and return rows."""
    db = None
    try:
        db = _db()
        rows = db._conn.execute(sql, params).fetchall()
        return list(rows)
    except Exception:
        return []
    finally:
        if db is not None:
            close = getattr(db, "close", None)
            if close:
                try:
                    close()
                except Exception:
                    pass


# ── overview ───────────────────────────────────────────────────────────────

@router.get("/overview")
async def overview():
    now = time.time()
    home = _hermes_home()

    # Active backend processes (hermes serve / gateway / desktop spawns).
    # The desktop spawns one backend per pane, so collapse same-start-time
    # groups into a single row with a count.
    processes = []
    seen_pids = set()
    groups: dict = {}
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid,lstart,command"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        for line in out.splitlines():
            parts = line.split(None, 2)
            if len(parts) < 3:
                continue
            pid, cmd = parts[0], parts[2]
            if pid in seen_pids:
                continue
            if "hermes_cli.main" in cmd and ("serve" in cmd or "gateway" in cmd):
                seen_pids.add(pid)
                start = " ".join(parts[1].split()[:5])
                key = start
                if key not in groups:
                    groups[key] = {"start": start, "count": 0, "cmd": cmd[:80]}
                groups[key]["count"] += 1
            elif "Hermes.app/Contents/MacOS/Hermes" in cmd and "Helper" not in cmd:
                seen_pids.add(pid)
                processes.append({"pid": pid, "cmd": "Hermes desktop app"})
    except Exception:
        pass
    for g in sorted(groups.values(), key=lambda x: x["start"]):
        processes.append({
            "pid": f"{g['count']}x",
            "cmd": f"{g['cmd']} (+{g['count'] - 1} more at {g['start']})",
        })

    # Today's tokens from session_model_usage.
    tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "cost": 0.0}
    rows = _query(
        "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
        "COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0), "
        "COALESCE(SUM(estimated_cost_usd),0) FROM session_model_usage "
        "WHERE last_seen >= ?",
        (now - 86400,),
    )
    if rows:
        tokens = {
            "input": _int(rows[0][0]),
            "output": _int(rows[0][1]),
            "cache_read": _int(rows[0][2]),
            "cache_write": _int(rows[0][3]),
            "cost": _f(rows[0][4]),
        }

    # Cron health: executions in the last 24h by status. process_started_at
    # is epoch MILLISECONDS in executions.db.
    cron = {"completed": 0, "failed": 0, "total_24h": 0}
    exec_db = home / "cron" / "executions.db"
    try:
        import sqlite3
        con = sqlite3.connect(exec_db)
        cur = con.cursor()
        row = cur.execute(
            "SELECT COUNT(*), COALESCE(SUM(status='completed'),0), "
            "COALESCE(SUM(status='failed'),0) FROM executions "
            "WHERE process_started_at >= ?",
            (int(now) * 1000 - 86400 * 1000,),
        ).fetchone()
        if row:
            cron = {
                "total_24h": _int(row[0]),
                "completed": _int(row[1]),
                "failed": _int(row[2]),
            }
        con.close()
    except Exception:
        pass

    # Error count in errors.log, last 24h.
    errors = {"count_24h": 0, "latest": []}
    log_path = home / "logs" / "errors.log"
    try:
        if log_path.exists():
            mtime = log_path.stat().st_mtime
            recent = []
            if mtime >= now - 86400:
                lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
                recent = lines[-8:]
            errors["count_24h"] = len(recent) if mtime >= now - 86400 else 0
            errors["latest"] = recent[-3:]
    except Exception:
        pass

    # Memory fill: always-on memory (MEMORY.md + USER.md) and fact store.
    memory = {"always_on_chars": 0, "always_on_limit": 4000, "facts": 0,
              "memory_md_chars": 0, "user_md_chars": 0, "memory_md_limit": 4000, "user_md_limit": 2500}
    mem_dir = home / "memories"
    total_chars = 0
    try:
        if mem_dir.is_dir():
            for fname, key, lim in (("MEMORY.md", "memory_md_chars", 4000), ("USER.md", "user_md_chars", 2500)):
                p = mem_dir / fname
                if p.exists():
                    n = p.stat().st_size
                    memory[key] = n
                    total_chars += n
                memory[key + "_limit"] = lim
    except Exception:
        pass
    memory["always_on_chars"] = total_chars
    try:
        import sqlite3
        db_path = home / "memory_store.db"
        if db_path.exists():
            con = sqlite3.connect(db_path)
            try:
                row = con.execute("SELECT COUNT(*) FROM facts").fetchone()
                if row:
                    memory["facts"] = _int(row[0])
            finally:
                con.close()
    except Exception:
        pass
    # Gateway status from lifecycle JSON + heartbeat file.
    gateway = {"phase": "unknown", "pid": None, "exited_at": None, "heartbeat_age": None}
    try:
        life = _read_json(home / "state" / "gateway.lifecycle.json")
        if isinstance(life, dict):
            gateway["phase"] = life.get("phase") or "unknown"
            gateway["pid"] = life.get("pid")
            gateway["exited_at"] = life.get("exited_at") or None
    except Exception:
        pass
    try:
        hb = home / "state" / "gateway.heartbeat"
        if hb.exists():
            m = hb.stat().st_mtime
            gateway["heartbeat_age"] = max(0, int(now - m))
    except Exception:
        pass
    return {
        "processes": processes,
        "tokens_24h": tokens,
        "cron_24h": cron,
        "errors_24h": errors,
        "memory": memory,
        "gateway": gateway,
        "generated_at": int(now),
    }


# ── cron ───────────────────────────────────────────────────────────────────

@router.get("/cron")
async def cron():
    home = _hermes_home()
    jobs = []
    store = home / "cron" / "jobs.json"
    raw = _read_json(store)
    job_list = raw.get("jobs", []) if isinstance(raw.get("jobs"), list) else []
    for job in job_list:
        if not isinstance(job, dict):
            continue
        jobs.append({
            "id": job.get("id") or "",
            "name": job.get("name") or job.get("id") or "",
            "schedule": job.get("schedule") or "",
            "schedule_display": job.get("schedule_display") or "",
            "enabled": job.get("enabled", True),
            "no_agent": job.get("no_agent", False),
            "last_status": job.get("last_status") or "",
            "last_error": job.get("last_error") or job.get("last_delivery_error") or "",
            "next_run_at": job.get("next_run_at") or "",
            "last_run_at": job.get("last_run_at") or "",
            "state": job.get("state") or "scheduled",
            "paused": bool(job.get("paused_at")),
            "deliver": job.get("deliver") or "",
            "model": job.get("model") or "",
            "skills": job.get("skills") or [],
            "script": job.get("script") or "",
        })

    executions = []
    exec_db = home / "cron" / "executions.db"
    try:
        import sqlite3
        con = sqlite3.connect(exec_db)
        cur = con.cursor()
        rows = cur.execute(
            "SELECT job_id, status, process_started_at, started_at, finished_at, error FROM executions "
            "ORDER BY process_started_at DESC LIMIT 40"
        ).fetchall()
        job_names = {j["id"]: j["name"] for j in jobs}
        for r in rows:
            started_iso = r[3]
            finished_iso = r[4]
            duration_ms = None
            try:
                if started_iso and finished_iso:
                    from datetime import datetime
                    s = datetime.fromisoformat(started_iso)
                    f = datetime.fromisoformat(finished_iso)
                    delta = (f - s).total_seconds() * 1000
                    duration_ms = max(0, int(delta)) if delta >= 0 else None
            except Exception:
                pass
            executions.append({
                "job_id": r[0],
                "job_name": job_names.get(r[0]) or r[0],
                "status": r[1],
                "at_ms": r[2],
                "at_iso": started_iso or "",
                "finished_ms": None,
                "duration_ms": duration_ms,
                "error": r[5] or "",
            })
        con.close()
    except Exception:
        pass

    return {"jobs": jobs, "executions": executions}


# ── plugins ────────────────────────────────────────────────────────────────

@router.get("/plugins")
async def plugins():
    home = _hermes_home()
    out = {"backend": [], "desktop": []}

    plugins_dir = home / "plugins"
    repo_plugins = None
    if plugins_dir.exists():
        for p in sorted(plugins_dir.iterdir()):
            if not p.is_dir():
                continue
            api = p / "dashboard" / "plugin_api.py"
            manifest = p / "dashboard" / "manifest.json"
            yaml_file = p / "plugin.yaml"
            meta = _read_json(manifest)
            yaml_meta = _read_yaml(yaml_file) if yaml_file.exists() else {}
            # Some backends live in the hermes-agent repo checkout and are
            # repo-mounted rather than copied into HERMES_HOME.
            repo_api = None
            if not api.exists():
                try:
                    candidate = Path(os.environ.get("HERMES_AGENT_REPO", "")) / "plugins" / p.name / "dashboard" / "plugin_api.py"
                    if candidate.exists():
                        repo_api = str(candidate)
                except Exception:
                    pass
            out["backend"].append({
                "name": p.name,
                "version": meta.get("version") or yaml_meta.get("version") or "?",
                "description": (meta.get("description") or yaml_meta.get("description") or ""),
                "has_api": api.exists() or repo_api is not None,
                "mounted_from": "repo" if repo_api else "home",
                "mtime": int(p.stat().st_mtime),
            })

    desktop_dir = home / "desktop-plugins"
    if desktop_dir.exists():
        for p in sorted(desktop_dir.iterdir()):
            if not p.is_dir():
                continue
            js = p / "plugin.js"
            out["desktop"].append({
                "name": p.name,
                "has_plugin": js.exists(),
                "size": js.stat().st_size if js.exists() else 0,
                "mtime": int(js.stat().st_mtime) if js.exists() else 0,
            })

    return out


def _read_yaml(path: Path) -> dict:
    try:
        import yaml
        d = yaml.safe_load(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


# ── models ─────────────────────────────────────────────────────────────────

@router.get("/models")
async def models():
    now = time.time()
    out = {"by_model": [], "daily": []}

    rows = _query(
        "SELECT model, SUM(input_tokens), SUM(output_tokens), "
        "SUM(cache_read_tokens), SUM(estimated_cost_usd) "
        "FROM session_model_usage WHERE last_seen >= ? "
        "GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC",
        (now - 30 * 86400,),
    )
    for r in rows:
        out["by_model"].append({
            "model": r[0] or "unknown",
            "input": _int(r[1]),
            "output": _int(r[2]),
            "cache_read": _int(r[3]),
            "cost": _f(r[4]),
        })

    # Reasoning tokens per model (all-time, session_model_usage).
    reason_rows = _query(
        "SELECT model, SUM(reasoning_tokens), SUM(api_call_count), "
        "COUNT(DISTINCT session_id) "
        "FROM session_model_usage GROUP BY model",
    )
    reason_map = {}
    for r in reason_rows:
        reason_map[r[0] or "unknown"] = {
            "reasoning_tokens": _int(r[1]),
            "api_calls": _int(r[2]),
            "sessions": _int(r[3]),
        }
    for m in out["by_model"]:
        extra = reason_map.get(m["model"], {})
        m["reasoning_tokens"] = extra.get("reasoning_tokens", 0)
        m["api_calls"] = extra.get("api_calls", 0)
        m["sessions"] = extra.get("sessions", 0)

    # Per-task token breakdown (30d).
    task_rows = _query(
        "SELECT COALESCE(NULLIF(task, ''), 'chat'), SUM(input_tokens + output_tokens) "
        "FROM session_model_usage WHERE last_seen >= ? "
        "GROUP BY COALESCE(NULLIF(task, ''), 'chat') "
        "ORDER BY SUM(input_tokens + output_tokens) DESC",
        (now - 30 * 86400,),
    )
    out["by_task"] = [{"task": r[0] or "chat", "tokens": _int(r[1])} for r in task_rows]

    # Top sessions by tokens (30d) — makes the burn concrete.
    top_rows = _query(
        "SELECT session_id, model, SUM(input_tokens + output_tokens), "
        "SUM(api_call_count), MAX(last_seen) "
        "FROM session_model_usage WHERE last_seen >= ? "
        "GROUP BY session_id ORDER BY SUM(input_tokens + output_tokens) DESC LIMIT 8",
        (now - 30 * 86400,),
    )
    out["top_sessions"] = []
    for r in top_rows:
        out["top_sessions"].append({
            "session_id": r[0] or "",
            "model": r[1] or "",
            "tokens": _int(r[2]),
            "api_calls": _int(r[3]),
            "last_seen": _int(r[4]) or 0,
        })

    for day in range(14, -1, -1):
        start = now - day * 86400
        end = start + 86400
        row = _query(
            "SELECT COALESCE(SUM(input_tokens + output_tokens),0), "
            "COALESCE(SUM(estimated_cost_usd),0) "
            "FROM session_model_usage WHERE last_seen >= ? AND last_seen < ?",
            (start, end),
        )
        if row:
            out["daily"].append({
                "day": int(start),
                "tokens": _int(row[0][0]),
                "cost": _f(row[0][1]),
            })
    return out


# ── skills ─────────────────────────────────────────────────────────────────

@router.get("/skills")
async def skills():
    home = _hermes_home()
    usage_file = home / "skills" / ".usage.json"
    usage = _read_json(usage_file)
    rows = []
    if isinstance(usage, dict):
        items = [(k, v) for k, v in usage.items() if isinstance(v, dict)]
        items.sort(key=lambda kv: -_int(kv[1].get("use_count", 0)))
        for name, meta in items[:200]:
            rows.append({
                "name": name,
                "use_count": _int(meta.get("use_count", 0)),
                "last_activity": meta.get("last_activity_at") or "",
                "state": meta.get("state") or "active",
            })
    return {"skills": rows}


# ── activity ────────────────────────────────────────────────────────────────

def _state_db() -> Path:
    return _hermes_home() / "state.db"


@router.get("/activity")
async def activity():
    """Recent sessions, delegations, and delivery obligations."""
    out = {"sessions": [], "delegations": [], "deliveries": []}
    db = _state_db()
    if not db.exists():
        return out

    try:
        import sqlite3
        con = sqlite3.connect(db)
        con.row_factory = sqlite3.Row
        cur = con.cursor()

        # Recent sessions (most active first by message count).
        rows = cur.execute(
            "SELECT s.id, s.source, s.model, s.started_at, "
            "COALESCE(m.msg_count, 0) AS msg_count, "
            "COALESCE(m.last_msg, 0) AS last_msg "
            "FROM sessions s LEFT JOIN ("
            "  SELECT session_id, COUNT(*) AS msg_count, MAX(timestamp) AS last_msg "
            "  FROM messages GROUP BY session_id"
            ") m ON m.session_id = s.id "
            "ORDER BY COALESCE(m.last_msg, 0) DESC LIMIT 12"
        ).fetchall()
        for r in rows:
            out["sessions"].append({
                "id": r["id"],
                "source": r["source"] or "",
                "model": r["model"] or "",
                "started_at": _int(r["started_at"]) or 0,
                "msg_count": _int(r["msg_count"]),
                "last_msg": _int(r["last_msg"]) or 0,
            })

        # Recent delegations.
        drows = cur.execute(
            "SELECT delegation_id, origin_session, state, dispatched_at, completed_at "
            "FROM async_delegations ORDER BY COALESCE(dispatched_at, 0) DESC LIMIT 8"
        ).fetchall()
        for r in drows:
            out["delegations"].append({
                "id": r["delegation_id"],
                "origin_session": r["origin_session"] or "",
                "state": r["state"] or "",
                "dispatched_at": _int(r["dispatched_at"]) or 0,
                "completed_at": _int(r["completed_at"]) or 0,
            })

        # Recent delivery obligations.
        orows = cur.execute(
            "SELECT obligation_id, session_key, platform, state, created_at "
            "FROM delivery_obligations ORDER BY COALESCE(created_at, 0) DESC LIMIT 8"
        ).fetchall()
        for r in orows:
            out["deliveries"].append({
                "id": r["obligation_id"],
                "session_key": r["session_key"] or "",
                "platform": r["platform"] or "",
                "state": r["state"] or "",
                "created_at": _int(r["created_at"]) or 0,
            })

        con.close()
    except Exception:
        pass

    return out
