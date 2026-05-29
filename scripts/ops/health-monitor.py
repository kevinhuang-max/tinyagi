#!/usr/bin/env python3
"""health-monitor.py — cloud health monitor for the TinyAGI production box.

A single auditable script that DETECTS subsystem failures, TRIAGES them into a
category, optionally REMEDIATES a safe subset, and ESCALATES via Discord. It is
designed to be cron-driven (every few minutes via run-job.sh) and safe to run
repeatedly.

SAFETY MODEL
  Both remediation and alerting are OFF by default and must be switched on
  explicitly with environment variables. With both off, `check` only reads the
  system and writes to the local ledger DB — it touches nothing external and
  restarts nothing. This is deliberate: the monitor auto-remediates a production
  server, so the default posture is observe-only.

  - HEALTH_REMEDIATE=1  enables the remediation registry.
  - HEALTH_ALERTS=1     enables Discord escalation.

  Two subsystems are NEVER auto-remediated regardless of flags: `database`
  (data integrity) and `resources` (disk/memory/load — a restart can make a
  full disk worse). Those always escalate to a human.

SUBCOMMANDS
  check       run all checks; triage, (maybe) remediate, (maybe) alert.
  status      human-readable table from health_status (alias: health).
              exit 0 = all ok, 1 = any warn, 2 = any critical (scriptable).
  init        create/upgrade the schema (also auto-run by `check`).
  test-alert  send a test Discord message (only if HEALTH_ALERTS=1).

The ledger DB is shared with the `incidents` CLI. We extend the existing
`incidents` table additively (ALTER TABLE ADD COLUMN, guarded) and add two new
tables — we never drop or rewrite what other tools wrote.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

try:
    import requests  # stdlib + requests only, per the environment contract.
except Exception:  # pragma: no cover - requests may be absent in odd envs
    requests = None


# ---------------------------------------------------------------------------
# Target environment — hardcoded facts about the production box.
# These are module constants on purpose: the monitor is auditable precisely
# because the paths it can act on are visible here, not assembled at runtime.
# ---------------------------------------------------------------------------
TINYAGI_USER = "tinyagi"
TINYAGI_HOME = "/home/tinyagi"
SERVICE_NAME = "tinyagi"

INCIDENTS_DB = os.environ.get("INCIDENTS_DB", f"{TINYAGI_HOME}/.claude/incidents.db")
MIRA_DB = os.environ.get("MIRA_DB", f"{TINYAGI_HOME}/.claude/mira-memory.db")

OPT_ROOT = "/opt/tinyagi"
QUEUE_LOG = f"{OPT_ROOT}/logs/queue.log"
WORKSPACE = f"{OPT_ROOT}/workspace/assistant"
LOG_DIR = f"{WORKSPACE}/logs"
SCRIPTS_DIR = f"{WORKSPACE}/scripts"
BACKUP_GLOB = f"{OPT_ROOT}/backups/tinyagi-*.tar.gz"
BACKUP_SCRIPT = f"{OPT_ROOT}/scripts-cloud/daily-backup.sh"
SETTINGS_JSON = f"{OPT_ROOT}/settings.json"
PAIRING_JSON = f"{OPT_ROOT}/pairing.json"
RUN_JOB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run-job.sh")

# Endpoints: (url, predicate(status)->bool, human description of expectation)
ENDPOINTS = [
    ("http://127.0.0.1:3000/", lambda s: s == 200, "office UI expects 200"),
    ("http://127.0.0.1:3777/", lambda s: 0 < s < 500, "local API expects <500 (404 ok)"),
    ("https://kh-agents.duckdns.org/", lambda s: s == 401, "public URL expects 401 (auth-gated)"),
]

# Backup freshness window.
BACKUP_MAX_AGE_SEC = 26 * 3600
BACKUP_MUST_CONTAIN = "./claude-mira-memory.db"


# ---------------------------------------------------------------------------
# Safety flags (overridable by env). Default OFF.
# ---------------------------------------------------------------------------
REMEDIATION_ENABLED = os.environ.get("HEALTH_REMEDIATE") == "1"
ALERTS_ENABLED = os.environ.get("HEALTH_ALERTS") == "1"
DEBOUNCE_CYCLES = 2          # consecutive failures before escalating (soft checks)
MAX_REMEDIATION_ATTEMPTS = 1  # per dedup_key per backoff window
ALERT_BACKOFF_MIN = 60        # don't re-alert same dedup_key within N min unless severity rises


# ---------------------------------------------------------------------------
# Scheduled jobs we watch for freshness.
#   max_staleness_min — how old the last run may be before we flag it.
#   severity_if_stale — warn|critical|info when stale.
# NB: the recurring user briefs (morning-briefing, renewal-digest cadence, etc.)
# self-gate on their own schedule and are intentionally NOT freshness-checked
# here beyond what is listed; adding them would produce noisy false staleness.
# ---------------------------------------------------------------------------
JOBS = {
    "fathom-poller":          {"logfile": "fathom-poller.log",       "max_staleness_min": 20,    "severity_if_stale": "warn"},
    "churn-tracker":          {"logfile": "churn-tracker.log",       "max_staleness_min": 75,    "severity_if_stale": "warn"},
    "email-checker":          {"logfile": "email-checker.log",       "max_staleness_min": 75,    "severity_if_stale": "warn"},
    "followup-checker":       {"logfile": "followup-checker.log",    "max_staleness_min": 75,    "severity_if_stale": "warn"},
    "park-monitor":           {"logfile": "park-monitor.log",        "max_staleness_min": 75,    "severity_if_stale": "warn"},
    "account-health-scorer":  {"logfile": "account-health-scorer.log", "max_staleness_min": 1560, "severity_if_stale": "warn"},
    "renewal-watcher":        {"logfile": "renewal-watcher.log",     "max_staleness_min": 1560,  "severity_if_stale": "warn"},
    "spif-sheet-sync":        {"logfile": "spif-sheet-sync.log",     "max_staleness_min": 1560,  "severity_if_stale": "warn"},
    "followup-hygiene":       {"logfile": "auto-stale-followups.log", "max_staleness_min": 1560, "severity_if_stale": "warn"},
    "dream-consolidation":    {"logfile": "dream-consolidation.log", "max_staleness_min": 1560,  "severity_if_stale": "warn"},
    "relationship-scan":      {"logfile": "relationship-scan.log",   "max_staleness_min": 11520, "severity_if_stale": "info"},
    "renewal-digest":         {"logfile": "renewal-digest.log",      "max_staleness_min": 8640,  "severity_if_stale": "info"},
}

# Jobs that are pure read/check work and therefore safe to re-run once as a
# remediation. Anything that writes durable outbound state stays off this list.
IDEMPOTENT_JOBS = {
    "churn-tracker", "email-checker", "followup-checker", "park-monitor",
    "account-health-scorer", "renewal-watcher", "fathom-poller",
}


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------
@dataclass
class CheckResult:
    subsystem: str
    state: str                 # ok | warn | critical
    detail: str = ""
    category: str = ""         # triage hint (filled/overridden by classify())
    diag: dict = field(default_factory=dict)
    hard_fail: bool = False    # True -> escalate immediately, skip debounce

    def dedup_key(self) -> str:
        # One open incident per subsystem; severity is tracked separately.
        return f"{self.subsystem}"


SEVERITY_RANK = {"ok": 0, "info": 0, "warn": 1, "critical": 2}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(s: str):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        try:
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        except Exception:
            return None


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def db_connect(path: str = None) -> sqlite3.Connection:
    p = path or INCIDENTS_DB
    os.makedirs(os.path.dirname(p), exist_ok=True)
    conn = sqlite3.connect(p, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000;")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS health_status (
            subsystem TEXT PRIMARY KEY,
            state TEXT,
            detail TEXT,
            category TEXT,
            consecutive_failures INTEGER DEFAULT 0,
            last_checked TEXT,
            last_ok TEXT,
            last_change TEXT,
            last_alert_ts TEXT,
            alert_count INTEGER DEFAULT 0
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS remediation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT,
            subsystem TEXT,
            dedup_key TEXT,
            action TEXT,
            attempt_num INTEGER,
            outcome TEXT,
            detail TEXT
        )
        """
    )
    # The incidents table is created by the `incidents` CLI. If it does not yet
    # exist (fresh test DB), create the base shape so we can extend it.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            agent TEXT,
            op TEXT,
            target TEXT,
            kind TEXT,
            http_status INTEGER,
            file_size INTEGER,
            verdict TEXT NOT NULL,
            raw_error TEXT
        )
        """
    )
    # Additively extend incidents with the monitor's columns, only if missing.
    existing = {row["name"] for row in cur.execute("PRAGMA table_info(incidents)")}
    extra_cols = {
        "severity": "TEXT",
        "category": "TEXT",
        "check_name": "TEXT",
        "dedup_key": "TEXT",
        "status": "TEXT",
        "resolved_ts": "TEXT",
        "actions": "TEXT",
    }
    for col, decl in extra_cols.items():
        if col not in existing:
            cur.execute(f"ALTER TABLE incidents ADD COLUMN {col} {decl}")
    conn.commit()


# ---------------------------------------------------------------------------
# Small subprocess helper. Never raises; returns (rc, stdout, stderr).
# ---------------------------------------------------------------------------
def run_cmd(args, cwd=None, timeout=30, env=None):
    try:
        p = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return p.returncode, (p.stdout or ""), (p.stderr or "")
    except FileNotFoundError as e:
        return 127, "", f"not found: {e}"
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:  # pragma: no cover
        return 1, "", str(e)


def tail_file(path: str, n: int = 15) -> str:
    try:
        with open(path, "r", errors="replace") as fh:
            lines = fh.readlines()
        return "".join(lines[-n:]).strip()
    except Exception as e:
        return f"(could not read {path}: {e})"


# ---------------------------------------------------------------------------
# CHECKS — each returns a CheckResult. They are run inside a try/except wrapper
# in run_all_checks() so a thrown check degrades to critical, never aborts.
# ---------------------------------------------------------------------------
def check_daemon() -> CheckResult:
    rc, out, _ = run_cmd(["systemctl", "is-active", SERVICE_NAME], timeout=15)
    state = out.strip()
    diag = {"is_active": state, "log_tail": tail_file(QUEUE_LOG, 15)}
    if state == "active":
        return CheckResult("daemon", "ok", "systemd service active", "transient", diag)
    return CheckResult(
        "daemon", "critical",
        f"systemctl is-active={state or 'unknown'}",
        "logic", diag, hard_fail=True,
    )


def check_database() -> CheckResult:
    diag = {}
    try:
        conn = sqlite3.connect(MIRA_DB, timeout=15)
        conn.execute("PRAGMA busy_timeout=15000;")
        qc = conn.execute("PRAGMA quick_check").fetchone()
        qc_val = qc[0] if qc else "?"
        diag["quick_check"] = qc_val
        if str(qc_val).lower() != "ok":
            conn.close()
            return CheckResult("database", "critical",
                               f"quick_check={qc_val}", "logic", diag, hard_fail=True)
        # read
        cnt = conn.execute("SELECT COUNT(*) FROM decision_log").fetchone()[0]
        diag["decision_log_rows"] = cnt
        # write-roundtrip into a scratch table (insert + delete, leaves no rows)
        conn.execute("CREATE TABLE IF NOT EXISTS _health_heartbeat (ts TEXT)")
        ts = now_iso()
        conn.execute("INSERT INTO _health_heartbeat(ts) VALUES (?)", (ts,))
        conn.execute("DELETE FROM _health_heartbeat WHERE ts = ?", (ts,))
        conn.commit()
        conn.close()
        return CheckResult("database", "ok",
                           f"quick_check ok, decision_log={cnt} rows, write-roundtrip ok",
                           "transient", diag)
    except Exception as e:
        diag["error"] = str(e)
        return CheckResult("database", "critical", f"db error: {e}",
                           "logic", diag, hard_fail=True)


def _read_marker(name: str):
    path = os.path.join(LOG_DIR, f".jobrun-{name}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def check_jobs() -> list:
    results = []
    now = utcnow()
    for name, cfg in JOBS.items():
        sub = f"job:{name}"
        max_age = cfg["max_staleness_min"] * 60
        sev_stale = cfg["severity_if_stale"]
        diag = {"max_staleness_min": cfg["max_staleness_min"]}
        try:
            marker = _read_marker(name)
            exit_code = None
            last_run_dt = None
            source = ""
            if marker:
                exit_code = marker.get("exit_code")
                last_run_dt = parse_iso(marker.get("last_run", ""))
                source = "marker"
            if last_run_dt is None:
                # Fall back to log file mtime.
                logpath = os.path.join(LOG_DIR, cfg["logfile"])
                if os.path.exists(logpath):
                    last_run_dt = datetime.fromtimestamp(
                        os.path.getmtime(logpath), tz=timezone.utc)
                    source = source or "log-mtime"
                    diag["logfile"] = cfg["logfile"]
            diag["source"] = source or "none"

            if last_run_dt is None:
                # Never observed on this host. Absence of history is NOT a
                # failure (e.g. right after a cutover, or a daily job that has
                # not hit its first scheduled run yet). Surface it as benign;
                # real overdue/failure detection kicks in once it runs once and
                # leaves a marker. This keeps fresh deploys false-positive-free.
                diag["never_observed"] = True
                results.append(CheckResult(
                    sub, "ok",
                    "no run observed yet (new on host; tracked after first run)",
                    "transient", diag))
                continue

            age_sec = (now - last_run_dt).total_seconds()
            diag["age_min"] = round(age_sec / 60, 1)
            diag["exit_code"] = exit_code

            # 1) explicit failure exit code (logic failure) takes priority.
            if exit_code is not None and exit_code != 0:
                logpath = os.path.join(LOG_DIR, cfg["logfile"])
                diag["log_tail"] = tail_file(logpath, 15)
                results.append(CheckResult(
                    sub, "critical",
                    f"last run exited {exit_code} ({diag['age_min']}m ago)",
                    "logic", diag))
                continue

            # 2) staleness.
            if age_sec > max_age:
                state = "critical" if sev_stale == "critical" else "warn"
                # info-severity jobs surface as warn at most (we have no 'info' state)
                results.append(CheckResult(
                    sub, state,
                    f"stale: last run {diag['age_min']}m ago (max {cfg['max_staleness_min']}m)",
                    "transient", diag))
                continue

            results.append(CheckResult(
                sub, "ok",
                f"ran {diag['age_min']}m ago, exit {exit_code if exit_code is not None else 'ok'}",
                "transient", diag))
        except Exception as e:
            results.append(CheckResult(sub, "critical", f"check error: {e}",
                                       "logic", {"error": str(e)}))
    return results


def _classify_connector_failure(rc: int, out: str, err: str) -> str:
    text = f"{out} {err}".lower()
    if "401" in text or "403" in text or "unauth" in text or "auth" in text or "unverified" in text:
        return "configuration"
    if "timeout" in text or "5" == text[:1] or "connection reset" in text \
            or "temporary failure in name resolution" in text or "no response" in text:
        return "dependency"
    return "dependency"


def check_connectors() -> list:
    results = []
    for name in ("confluence", "slack", "salesforce"):
        sub = f"connector:{name}"
        try:
            rc, out, err = run_cmd(["connector-check", name], timeout=40)
            diag = {"rc": rc, "out": out.strip()[:300]}
            if rc == 0:
                results.append(CheckResult(sub, "ok", out.strip() or "ok",
                                           "transient", diag))
            else:
                cat = _classify_connector_failure(rc, out, err)
                # UNVERIFIED (rc 2) = missing creds -> configuration.
                if rc == 2:
                    cat = "configuration"
                results.append(CheckResult(
                    sub, "critical" if cat == "dependency" else "warn",
                    (out.strip() or err.strip() or f"rc={rc}")[:200],
                    cat, diag))
        except Exception as e:
            results.append(CheckResult(sub, "critical", f"check error: {e}",
                                       "dependency", {"error": str(e)}))

    # Google OAuth via gws.
    sub = "connector:google"
    try:
        rc, out, err = run_cmd(["gws", "auth", "status"], cwd=TINYAGI_HOME, timeout=40)
        diag = {"rc": rc, "out": out.strip()[:300]}
        method = None
        try:
            j = json.loads(out)
            method = j.get("auth_method")
        except Exception:
            method = None
        if rc == 0 and method:
            results.append(CheckResult(sub, "ok", f"auth_method={method}",
                                       "transient", diag))
        else:
            results.append(CheckResult(
                sub, "warn",
                (out.strip() or err.strip() or "no auth_method")[:200],
                "configuration", diag))
    except Exception as e:
        results.append(CheckResult(sub, "critical", f"check error: {e}",
                                   "configuration", {"error": str(e)}))
    return results


def check_endpoints() -> CheckResult:
    diag = {}
    failures = []
    if requests is None:
        return CheckResult("endpoints", "critical",
                           "requests library unavailable", "configuration",
                           {"error": "no requests module"})
    for url, predicate, desc in ENDPOINTS:
        try:
            r = requests.get(url, timeout=15, allow_redirects=False, verify=True)
            code = r.status_code
            diag[url] = code
            if not predicate(code):
                failures.append(f"{url} -> {code} ({desc})")
        except Exception as e:
            diag[url] = f"err: {e}"
            failures.append(f"{url} -> error: {e} ({desc})")
    if not failures:
        return CheckResult("endpoints", "ok",
                           "all endpoints returned expected status", "transient", diag)
    # Public URL failing while local ok => still flag, but local failures are
    # more serious (the app itself). Treat any failure as critical-ish: warn if
    # only the public probe failed, critical if a local one did.
    local_fail = any("127.0.0.1" in f for f in failures)
    state = "critical" if local_fail else "warn"
    return CheckResult("endpoints", state, "; ".join(failures)[:300],
                       "dependency", diag)


def check_resources() -> CheckResult:
    diag = {}
    try:
        total, used, free = shutil.disk_usage("/")
        disk_pct = (used / total) * 100 if total else 0
        diag["disk_pct"] = round(disk_pct, 1)

        load1 = os.getloadavg()[0]
        cpu = os.cpu_count() or 1
        diag["load1"] = round(load1, 2)
        diag["cpu_count"] = cpu

        mem_total = mem_avail = None
        try:
            with open("/proc/meminfo") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        mem_total = int(line.split()[1])
                    elif line.startswith("MemAvailable:"):
                        mem_avail = int(line.split()[1])
            if mem_total and mem_avail is not None:
                mem_used_pct = (1 - mem_avail / mem_total) * 100
                diag["mem_used_pct"] = round(mem_used_pct, 1)
        except Exception:
            # /proc/meminfo absent (e.g. macOS) — not fatal for this check.
            diag["mem_used_pct"] = None

        crit = []
        warn = []
        if disk_pct > 95:
            crit.append(f"disk {disk_pct:.0f}%")
        elif disk_pct > 85:
            warn.append(f"disk {disk_pct:.0f}%")
        if load1 > cpu * 2:
            warn.append(f"load {load1:.1f} (>{cpu*2})")

        if crit:
            return CheckResult("resources", "critical", ", ".join(crit + warn),
                               "resource", diag, hard_fail=True)
        if warn:
            return CheckResult("resources", "warn", ", ".join(warn),
                               "resource", diag)
        return CheckResult("resources", "ok",
                           f"disk {disk_pct:.0f}%, load {load1:.1f}/{cpu}cpu",
                           "resource", diag)
    except Exception as e:
        return CheckResult("resources", "critical", f"check error: {e}",
                           "resource", {"error": str(e)})


def check_backup() -> CheckResult:
    import glob
    diag = {}
    try:
        candidates = glob.glob(BACKUP_GLOB)
        if not candidates:
            return CheckResult("backup", "critical",
                               "no backup archives found", "configuration",
                               {"glob": BACKUP_GLOB}, hard_fail=True)
        newest = max(candidates, key=lambda p: os.path.getmtime(p))
        age_sec = time.time() - os.path.getmtime(newest)
        diag["newest"] = os.path.basename(newest)
        diag["age_h"] = round(age_sec / 3600, 1)

        stale = age_sec > BACKUP_MAX_AGE_SEC
        # Verify contents list the mira db.
        rc, out, err = run_cmd(["tar", "-tzf", newest], timeout=60)
        contains = BACKUP_MUST_CONTAIN in out or BACKUP_MUST_CONTAIN.lstrip("./") in out
        diag["contains_mira"] = contains

        if not contains:
            return CheckResult("backup", "critical",
                               f"{diag['newest']} missing {BACKUP_MUST_CONTAIN}",
                               "logic", diag)
        if stale:
            return CheckResult("backup", "warn",
                               f"{diag['newest']} is {diag['age_h']}h old (>26h)",
                               "transient", diag)
        return CheckResult("backup", "ok",
                           f"{diag['newest']} {diag['age_h']}h old, contents verified",
                           "transient", diag)
    except Exception as e:
        return CheckResult("backup", "critical", f"check error: {e}",
                           "logic", {"error": str(e)})


# ---------------------------------------------------------------------------
# TRIAGE
# ---------------------------------------------------------------------------
def check_filesystem() -> CheckResult:
    # Scheduled jobs resolve paths via Path.home()/tinyagi-workspace, which MUST
    # be a symlink to the real workspace. If it's missing/broken/wrong, jobs write
    # to the wrong tree (split-brain). This is the layout the cutover established.
    link = "/home/tinyagi/tinyagi-workspace"
    target = "/opt/tinyagi/workspace"
    diag = {"link": link, "target": target}
    try:
        if not os.path.islink(link):
            is_dir = os.path.isdir(link)
            return CheckResult(
                "filesystem", "warn" if is_dir else "critical",
                f"{link} is {'a real directory (split-brain risk)' if is_dir else 'missing'}, expected symlink -> {target}",
                "configuration", diag)
        actual = os.path.realpath(link)
        diag["resolves_to"] = actual
        if actual != os.path.realpath(target):
            return CheckResult("filesystem", "warn",
                               f"{link} points to {actual}, expected {target}",
                               "configuration", diag)
        if not os.path.isdir(os.path.join(link, "assistant", "logs")):
            return CheckResult("filesystem", "warn",
                               "workspace logs dir not reachable via symlink",
                               "configuration", diag)
        return CheckResult("filesystem", "ok",
                           f"workspace symlink -> {target} intact", "transient", diag)
    except Exception as e:
        return CheckResult("filesystem", "critical", f"fs check error: {e}",
                           "logic", {"error": str(e)})


def classify(res: CheckResult) -> str:
    """Return one of: transient | configuration | dependency | resource | logic."""
    if res.subsystem == "resources":
        return "resource"

    text = (res.detail or "").lower()
    diag = res.diag or {}
    diag_text = " ".join(str(v) for v in diag.values()).lower()
    blob = f"{text} {diag_text}"

    # configuration: missing files / permissions / auth-rejection codes.
    config_markers = ["no such file", "not found", "permission denied",
                      "eacces", "directory does not exist", "401", "403"]
    if any(m in blob for m in config_markers):
        return "configuration"

    # dependency: upstream/network failure.
    dep_markers = ["timeout", "connection reset",
                   "temporary failure in name resolution", "502", "503", "504",
                   "500", "unreachable", "no response"]
    if any(m in blob for m in dep_markers):
        return "dependency"

    # logic: a job that exited non-zero with a traceback in its log.
    if res.subsystem.startswith("job:"):
        ec = diag.get("exit_code")
        if ec not in (None, 0):
            tail = (diag.get("log_tail") or "").lower()
            if "traceback" in tail or "error" in tail:
                return "logic"
            return "logic"

    # Honour a check's own hint if it set one and we matched nothing.
    if res.category in ("transient", "configuration", "dependency", "resource", "logic"):
        return res.category
    return "transient"


# ---------------------------------------------------------------------------
# REMEDIATION REGISTRY (only runs when REMEDIATION_ENABLED)
# Each fn returns (ok: bool, detail: str).
# ---------------------------------------------------------------------------
def remediate_daemon(res: CheckResult):
    rc, out, err = run_cmd(["sudo", "systemctl", "restart", SERVICE_NAME], timeout=60)
    if rc != 0:
        return False, f"restart failed rc={rc}: {(err or out).strip()[:200]}"
    # re-check
    rc2, out2, _ = run_cmd(["systemctl", "is-active", SERVICE_NAME], timeout=15)
    active = out2.strip() == "active"
    return active, f"restart issued; is-active={out2.strip()}"


def remediate_job(res: CheckResult):
    name = res.subsystem.split(":", 1)[1]
    if name not in IDEMPOTENT_JOBS:
        return False, f"{name} is not idempotent — not auto-re-run"
    # Only re-run on a real failure / staleness signal.
    diag = res.diag or {}
    ec = diag.get("exit_code")
    is_failed = ec not in (None, 0)
    is_stale = "stale" in (res.detail or "").lower()
    if not (is_failed or is_stale):
        return False, "no failure/staleness signal — skipped"
    script = f"{SCRIPTS_DIR}/{name}.py"
    rc, out, err = run_cmd(
        ["bash", RUN_JOB, name, "--", "/usr/bin/python3", script],
        cwd=TINYAGI_HOME, timeout=300)
    marker = _read_marker(name)
    new_ec = marker.get("exit_code") if marker else None
    ok = (rc == 0) and (new_ec in (0, None) if new_ec is not None else rc == 0)
    ok = (new_ec == 0) if new_ec is not None else (rc == 0)
    return ok, f"re-ran via run-job.sh; rc={rc}, marker_exit={new_ec}"


def remediate_connector(res: CheckResult):
    # Only meaningful for the gws/google OAuth path; other connectors are
    # cred/network issues a restart won't fix.
    name = res.subsystem.split(":", 1)[1]
    cat = res.category
    if name == "google" and cat == "configuration":
        # Touch auth status to trigger a refresh; gws refreshes on access.
        run_cmd(["gws", "auth", "refresh"], cwd=TINYAGI_HOME, timeout=60)
        rc, out, err = run_cmd(["gws", "auth", "status"], cwd=TINYAGI_HOME, timeout=40)
        method = None
        try:
            method = json.loads(out).get("auth_method")
        except Exception:
            method = None
        ok = rc == 0 and bool(method)
        return ok, f"gws refresh attempted; auth_method={method or 'none'}"
    return False, "connector needs human re-auth / upstream fix — escalating"


def remediate_backup(res: CheckResult):
    rc, out, err = run_cmd(["bash", BACKUP_SCRIPT], cwd=TINYAGI_HOME, timeout=600)
    if rc != 0:
        return False, f"backup script rc={rc}: {(err or out).strip()[:200]}"
    recheck = check_backup()
    return recheck.state == "ok", f"backup re-run; recheck={recheck.state}: {recheck.detail[:150]}"


def remediate_filesystem(res: CheckResult):
    # Recreate the workspace symlink ONLY for missing/broken/wrong-target cases.
    # If a REAL directory sits there it may hold data — refuse to delete it and
    # escalate instead (no data loss). Runs as tinyagi (owns /home/tinyagi); no sudo.
    link = "/home/tinyagi/tinyagi-workspace"
    target = "/opt/tinyagi/workspace"
    if not os.path.isdir(target):
        return False, f"target {target} missing — cannot relink (escalate)"
    try:
        if os.path.islink(link):
            os.remove(link)
        elif os.path.isdir(link):
            return False, f"{link} is a real directory — manual review (refusing to delete)"
        elif os.path.exists(link):
            os.remove(link)
        os.symlink(target, link)
        ok = os.path.islink(link) and os.path.realpath(link) == os.path.realpath(target)
        return ok, (f"relinked {link} -> {target}" if ok else "relink did not take")
    except Exception as e:
        return False, f"relink raised: {e}"


# subsystem-pattern -> remediation fn. database & resources deliberately absent.
def remediation_for(subsystem: str):
    if subsystem == "daemon":
        return remediate_daemon
    if subsystem == "filesystem":
        return remediate_filesystem
    if subsystem.startswith("job:"):
        return remediate_job
    if subsystem.startswith("connector:"):
        return remediate_connector
    if subsystem == "backup":
        return remediate_backup
    return None


NEVER_REMEDIATE = {"database", "resources"}


# ---------------------------------------------------------------------------
# REMEDIATION orchestration with attempt cap + backoff window.
# ---------------------------------------------------------------------------
def recent_remediation_attempts(conn, dedup_key: str) -> int:
    cutoff = (utcnow().timestamp() - ALERT_BACKOFF_MIN * 60)
    rows = conn.execute(
        "SELECT ts FROM remediation_log WHERE dedup_key = ? ORDER BY id DESC LIMIT 50",
        (dedup_key,),
    ).fetchall()
    n = 0
    for row in rows:
        dt = parse_iso(row["ts"])
        if dt and dt.timestamp() >= cutoff:
            n += 1
    return n


def log_remediation(conn, subsystem, dedup_key, action, attempt_num, outcome, detail):
    conn.execute(
        "INSERT INTO remediation_log (ts, subsystem, dedup_key, action, attempt_num, outcome, detail)"
        " VALUES (?,?,?,?,?,?,?)",
        (now_iso(), subsystem, dedup_key, action, attempt_num, outcome, detail[:500]),
    )
    conn.commit()


def try_remediate(conn, res: CheckResult):
    """Returns (attempted: bool, recovered: bool, detail: str)."""
    if res.subsystem in NEVER_REMEDIATE:
        return False, False, "subsystem is never auto-remediated (escalate)"
    fn = remediation_for(res.subsystem)
    if fn is None:
        return False, False, "no remediation registered"
    dedup = res.dedup_key()
    prior = recent_remediation_attempts(conn, dedup)
    if prior >= MAX_REMEDIATION_ATTEMPTS:
        return False, False, f"attempt cap reached ({prior}/{MAX_REMEDIATION_ATTEMPTS}) in {ALERT_BACKOFF_MIN}m window"
    attempt_num = prior + 1
    try:
        ok, detail = fn(res)
    except Exception as e:
        ok, detail = False, f"remediation raised: {e}"
    log_remediation(conn, res.subsystem, dedup, f"remediate:{res.subsystem}",
                    attempt_num, "success" if ok else "failed", detail)
    return True, ok, detail


# ---------------------------------------------------------------------------
# ESCALATION (Discord) — only when ALERTS_ENABLED.
# ---------------------------------------------------------------------------
def _read_json(path):
    with open(path) as fh:
        return json.load(fh)


def _discord_creds():
    """Return (bot_token, recipient_id) or (None, None). Never logs the token."""
    token = None
    recipient = None
    try:
        settings = _read_json(SETTINGS_JSON)
        token = settings.get("channels", {}).get("discord", {}).get("bot_token")
    except Exception:
        token = None
    try:
        pairing = _read_json(PAIRING_JSON)
        for entry in pairing.get("approved", []):
            if entry.get("channel") == "discord" and entry.get("senderId"):
                recipient = entry.get("senderId")
                break
    except Exception:
        recipient = None
    return token, recipient


def discord_send(content: str) -> bool:
    if requests is None:
        print("alert: requests unavailable; cannot post to Discord", file=sys.stderr)
        return False
    token, recipient = _discord_creds()
    if not token or not recipient:
        print("alert: missing discord token or recipient id", file=sys.stderr)
        return False
    headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    try:
        r = requests.post("https://discord.com/api/v10/users/@me/channels",
                          headers=headers, json={"recipient_id": str(recipient)},
                          timeout=20)
        if r.status_code >= 300:
            print(f"alert: open-DM failed http={r.status_code}", file=sys.stderr)
            return False
        channel_id = r.json().get("id")
        if not channel_id:
            print("alert: no DM channel id returned", file=sys.stderr)
            return False
        m = requests.post(f"https://discord.com/api/v10/channels/{channel_id}/messages",
                          headers=headers, json={"content": content[:1900]}, timeout=20)
        if m.status_code >= 300:
            print(f"alert: send-message failed http={m.status_code}", file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"alert: discord post error: {e}", file=sys.stderr)
        return False


SEV_EMOJI = {"critical": "🔴", "warn": "🟠", "ok": "🟢", "recovered": "🟢"}


def compose_alert(subsystem, severity, summary, root_cause, actions, diag):
    emoji = SEV_EMOJI.get(severity, "🟠")
    lines = [f"{emoji} [{severity.upper()}] {subsystem}"]
    if root_cause:
        lines.append(f"cause: {root_cause}")
    if actions:
        lines.append(f"actions: {actions}")
    if severity == "critical":
        lines.append("next: inspect on box; this subsystem may need a human.")
    # a few diag lines (never secrets — diag never holds the token).
    if diag:
        shown = 0
        for k, v in diag.items():
            if k == "log_tail":
                continue
            lines.append(f"  {k}={str(v)[:80]}")
            shown += 1
            if shown >= 4:
                break
    msg = "\n".join(lines)
    return msg[:1500]


def alert(conn, subsystem, severity, summary, root_cause, actions, diag, hard_fail=False):
    """Escalate via Discord, honouring dedup/backoff. No-op if alerts disabled."""
    if not ALERTS_ENABLED:
        return
    row = conn.execute(
        "SELECT last_alert_ts, alert_count, state FROM health_status WHERE subsystem = ?",
        (subsystem,),
    ).fetchone()
    last_alert = parse_iso(row["last_alert_ts"]) if row and row["last_alert_ts"] else None
    # Determine prior alerted severity from the most recent open incident.
    prior_inc = conn.execute(
        "SELECT severity FROM incidents WHERE dedup_key = ? AND status='open' "
        "ORDER BY id DESC LIMIT 1", (subsystem,)).fetchone()
    prior_sev = prior_inc["severity"] if prior_inc else None

    if last_alert is not None:
        within = (utcnow() - last_alert).total_seconds() < ALERT_BACKOFF_MIN * 60
        severity_rose = SEVERITY_RANK.get(severity, 0) > SEVERITY_RANK.get(prior_sev or "ok", 0)
        if within and not severity_rose:
            return  # backoff: suppress duplicate

    content = compose_alert(subsystem, severity, summary, root_cause, actions, diag)
    discord_send(content)  # failure is logged inside; do not crash
    cur_count = (row["alert_count"] if row and row["alert_count"] else 0) + 1
    conn.execute(
        "UPDATE health_status SET last_alert_ts = ?, alert_count = ? WHERE subsystem = ?",
        (now_iso(), cur_count, subsystem),
    )
    conn.commit()


def alert_recovery(conn, subsystem):
    if not ALERTS_ENABLED:
        return
    discord_send(f"🟢 [RECOVERED] {subsystem} is healthy again.")


# ---------------------------------------------------------------------------
# health_status upsert + incident bookkeeping
# ---------------------------------------------------------------------------
def upsert_status(conn, res: CheckResult, category: str):
    row = conn.execute(
        "SELECT state, consecutive_failures FROM health_status WHERE subsystem = ?",
        (res.subsystem,),
    ).fetchone()
    prev_state = row["state"] if row else None
    prev_fail = row["consecutive_failures"] if row else 0
    is_ok = res.state == "ok"

    if is_ok:
        consecutive = 0
    else:
        consecutive = (prev_fail or 0) + 1

    now = now_iso()
    last_change = now if prev_state != res.state else None

    if row is None:
        conn.execute(
            "INSERT INTO health_status (subsystem, state, detail, category, "
            "consecutive_failures, last_checked, last_ok, last_change, alert_count) "
            "VALUES (?,?,?,?,?,?,?,?,0)",
            (res.subsystem, res.state, res.detail[:500], category, consecutive,
             now, now if is_ok else None, now),
        )
    else:
        # Build dynamic update to preserve last_ok / last_change when unchanged.
        conn.execute(
            "UPDATE health_status SET state=?, detail=?, category=?, "
            "consecutive_failures=?, last_checked=? WHERE subsystem=?",
            (res.state, res.detail[:500], category, consecutive, now, res.subsystem),
        )
        if is_ok:
            conn.execute("UPDATE health_status SET last_ok=? WHERE subsystem=?",
                         (now, res.subsystem))
        if last_change:
            conn.execute("UPDATE health_status SET last_change=? WHERE subsystem=?",
                         (now, res.subsystem))
    conn.commit()
    return prev_state, consecutive


def open_incident(conn, res: CheckResult, category: str):
    # Avoid piling duplicate open incidents for the same dedup_key.
    existing = conn.execute(
        "SELECT id FROM incidents WHERE dedup_key=? AND status='open' "
        "ORDER BY id DESC LIMIT 1", (res.subsystem,)).fetchone()
    if existing:
        # Refresh severity/detail on the existing open incident.
        conn.execute(
            "UPDATE incidents SET severity=?, category=?, raw_error=? WHERE id=?",
            (res.state, category, res.detail[:2000], existing["id"]))
        conn.commit()
        return existing["id"]
    cur = conn.execute(
        "INSERT INTO incidents (ts, agent, op, target, kind, verdict, raw_error, "
        "severity, category, check_name, dedup_key, status) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (now_iso(), "health-monitor", f"check:{res.subsystem}", res.subsystem,
         "health", "FAILED", res.detail[:2000], res.state, category,
         res.subsystem, res.subsystem, "open"),
    )
    conn.commit()
    return cur.lastrowid


def resolve_incidents(conn, subsystem):
    conn.execute(
        "UPDATE incidents SET status='resolved', resolved_ts=? "
        "WHERE dedup_key=? AND status='open'",
        (now_iso(), subsystem),
    )
    conn.commit()


def record_actions(conn, subsystem, actions_text):
    conn.execute(
        "UPDATE incidents SET actions=? WHERE dedup_key=? AND status='open'",
        (actions_text[:1000], subsystem))
    conn.commit()


# ---------------------------------------------------------------------------
# Run all checks, each isolated.
# ---------------------------------------------------------------------------
def run_all_checks(conn) -> list:
    # Tiered cadence: cheap local checks run every tick (daemon uptime is what
    # matters and it's free); external API probes are throttled so we don't hammer
    # Slack/Confluence/Salesforce or the public endpoint every few minutes. A
    # throttled check that isn't due is simply skipped — its last health_status
    # row stays visible in `status` and it runs again once its interval elapses.
    results = []
    now = utcnow()

    def due(gate_subsystem, interval_min):
        if interval_min <= 0:
            return True
        row = conn.execute("SELECT last_checked FROM health_status WHERE subsystem = ?",
                           (gate_subsystem,)).fetchone()
        if not row or not row["last_checked"]:
            return True
        dt = parse_iso(row["last_checked"])
        return dt is None or (now - dt).total_seconds() >= interval_min * 60

    def safe(name, fn):
        try:
            out = fn()
            results.extend(out if isinstance(out, list) else [out])
        except Exception as e:
            results.append(CheckResult(name, "critical",
                                       f"check threw: {e}", "logic",
                                       {"error": str(e)}, hard_fail=True))

    # Always (cheap + local; daemon/db/fs/resources matter for uptime & integrity).
    safe("daemon", check_daemon)
    safe("database", check_database)
    safe("filesystem", check_filesystem)
    safe("jobs", check_jobs)
    safe("resources", check_resources)
    # Throttled external probes.
    if due("connector:slack", 30):
        safe("connectors", check_connectors)
    if due("endpoints", 30):
        safe("endpoints", check_endpoints)
    if due("backup", 60):
        safe("backup", check_backup)
    return results


# ---------------------------------------------------------------------------
# `check` flow
# ---------------------------------------------------------------------------
def cmd_check(args):
    conn = db_connect()
    init_schema(conn)
    results = run_all_checks(conn)

    n_ok = n_warn = n_crit = 0
    for res in results:
        category = classify(res)
        prev_state, consecutive = upsert_status(conn, res, category)
        was_failing = prev_state not in (None, "ok")
        is_ok = res.state == "ok"

        if is_ok:
            n_ok += 1
            if was_failing:
                resolve_incidents(conn, res.subsystem)
                alert_recovery(conn, res.subsystem)
            continue

        if res.state == "warn":
            n_warn += 1
        else:
            n_crit += 1

        # Record the failure as an open incident.
        open_incident(conn, res, category)

        # Debounce: soft failures escalate only after DEBOUNCE_CYCLES; hard
        # failures (daemon down, db corrupt, no backup) skip debounce.
        debounced_ready = res.hard_fail or consecutive >= DEBOUNCE_CYCLES

        actions_taken = ""
        recovered = False
        if debounced_ready and REMEDIATION_ENABLED:
            attempted, recovered, detail = try_remediate(conn, res)
            if attempted:
                actions_taken = f"remediation {'OK' if recovered else 'FAILED'}: {detail}"
                record_actions(conn, res.subsystem, actions_taken)
                if recovered:
                    # Re-check this single subsystem to confirm recovery.
                    pass

        # Escalate if still failing after (optional) remediation and debounce ok.
        if debounced_ready and not recovered:
            root_cause = f"{category}: {res.detail}"
            alert(conn, res.subsystem, res.state, res.detail, root_cause,
                  actions_taken or ("(remediation disabled)" if not REMEDIATION_ENABLED else "none"),
                  res.diag, hard_fail=res.hard_fail)

    overall = "OK"
    if n_crit:
        overall = f"CRITICAL ({n_crit} critical, {n_warn} warn)"
    elif n_warn:
        overall = f"DEGRADED ({n_warn} warn)"
    print(f"health check: {overall} — {n_ok} ok / {n_warn} warn / {n_crit} critical "
          f"[remediate={'on' if REMEDIATION_ENABLED else 'off'} "
          f"alerts={'on' if ALERTS_ENABLED else 'off'}]")
    conn.close()
    if n_crit:
        return 2
    if n_warn:
        return 1
    return 0


# ---------------------------------------------------------------------------
# `status` table
# ---------------------------------------------------------------------------
STATE_LABEL = {"ok": "OK", "warn": "WARN", "critical": "CRIT", "info": "OK"}


def cmd_status(args):
    conn = db_connect()
    init_schema(conn)
    rows = conn.execute(
        "SELECT subsystem, state, detail, last_checked FROM health_status "
        "ORDER BY CASE state WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, subsystem"
    ).fetchall()
    conn.close()

    if not rows:
        print("(no health_status rows yet — run `health-monitor.py check` first)")
        return 0

    now = utcnow()
    sub_w = max(len("subsystem"), max(len(r["subsystem"]) for r in rows))
    print(f"{'SUBSYSTEM'.ljust(sub_w)}  {'STATE':5}  {'AGE':>8}  DETAIL")
    print("-" * (sub_w + 4 + 5 + 4 + 8 + 2 + 6))
    n_warn = n_crit = 0
    for r in rows:
        label = STATE_LABEL.get(r["state"], (r["state"] or "?").upper())
        if r["state"] == "warn":
            n_warn += 1
        elif r["state"] == "critical":
            n_crit += 1
        checked = parse_iso(r["last_checked"])
        if checked:
            age_min = int((now - checked).total_seconds() // 60)
            age = f"{age_min}m ago"
        else:
            age = "never"
        detail = (r["detail"] or "")[:80]
        print(f"{r['subsystem'].ljust(sub_w)}  {label:5}  {age:>8}  {detail}")

    if n_crit:
        print(f"\noverall: CRITICAL ({n_crit} critical, {n_warn} warnings)")
        return 2
    if n_warn:
        print(f"\noverall: DEGRADED ({n_warn} warnings)")
        return 1
    print("\noverall: OK")
    return 0


def cmd_init(args):
    conn = db_connect()
    init_schema(conn)
    conn.close()
    print(f"health-monitor schema ready in {INCIDENTS_DB}")
    return 0


def cmd_test_alert(args):
    if not ALERTS_ENABLED:
        print("test-alert: HEALTH_ALERTS!=1, alerting disabled — not sending.")
        return 1
    ok = discord_send("🟢 [TEST] health-monitor test-alert — alerting path is working.")
    print("test-alert: sent" if ok else "test-alert: FAILED (see stderr)")
    return 0 if ok else 1


def build_parser():
    p = argparse.ArgumentParser(
        prog="health-monitor.py",
        description="TinyAGI cloud health monitor (detect/triage/remediate/escalate).")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="run all checks; triage, maybe remediate/alert")
    sub.add_parser("status", help="human-readable health table (exit 0/1/2)")
    sub.add_parser("health", help="alias for status")
    sub.add_parser("init", help="create/upgrade the schema")
    sub.add_parser("test-alert", help="send a test Discord message (needs HEALTH_ALERTS=1)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd in ("status", "health"):
        return cmd_status(args)
    if args.cmd == "init":
        return cmd_init(args)
    if args.cmd == "test-alert":
        return cmd_test_alert(args)
    return 64


if __name__ == "__main__":
    sys.exit(main())
