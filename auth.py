"""
BidGov Compass — members-portal authentication.

Design decisions:
  * Users live in a SEPARATE SQLite (`data/users.db`) from the tenders store,
    so redeploying / rebuilding the tenders DB never wipes accounts.
  * Passwords are hashed with werkzeug (PBKDF2). No plaintext storage.
  * Sessions are Flask-Login secure cookies (HttpOnly, SameSite=Lax; Secure
    in production when SESSION_COOKIE_SECURE=1).
  * The very first user to register auto-becomes admin (bootstrap convenience).
"""

from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Optional

from flask import (
    Blueprint, current_app, flash, jsonify, redirect,
    render_template, request, session, url_for,
)
from flask_login import (
    LoginManager, UserMixin, current_user, login_required,
    login_user, logout_user,
)
from werkzeug.security import check_password_hash, generate_password_hash

DATA_DIR = Path(__file__).resolve().parent / "data"
USERS_DB_PATH = DATA_DIR / "users.db"


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #
CREATE_USERS_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
"""


def _conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(USERS_DB_PATH)
    conn.executescript(CREATE_USERS_SQL)
    return conn


# --------------------------------------------------------------------------- #
# User model (Flask-Login integration)
# --------------------------------------------------------------------------- #
class User(UserMixin):
    def __init__(self, id_: int, email: str, name: Optional[str],
                 is_admin: bool, is_active: bool):
        self.id = id_
        self.email = email
        self.name = name
        self.is_admin = is_admin
        # Flask-Login's UserMixin uses `is_active` — we intentionally shadow it
        self._active = is_active

    @property
    def is_active(self) -> bool:  # noqa: D401 - part of Flask-Login contract
        return self._active

    def get_id(self) -> str:
        return str(self.id)

    @classmethod
    def from_row(cls, row) -> "User":
        return cls(
            id_=row[0], email=row[1], name=row[2],
            is_admin=bool(row[3]), is_active=bool(row[4]),
        )


def find_by_id(user_id: int) -> Optional[User]:
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, email, name, is_admin, is_active FROM users WHERE id=?",
            (user_id,),
        ).fetchone()
    finally:
        conn.close()
    return User.from_row(row) if row else None


def find_by_email(email: str) -> Optional[tuple[User, str]]:
    """Returns (user, password_hash) or None if no such active email."""
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, email, name, is_admin, is_active, password_hash "
            "FROM users WHERE LOWER(email) = LOWER(?)",
            (email.strip(),),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return User.from_row(row[:5]), row[5]


def create_user(email: str, name: str, password: str) -> tuple[Optional[User], Optional[str]]:
    """Returns (user, None) on success or (None, error_message)."""
    email = (email or "").strip()
    name = (name or "").strip()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return None, "That doesn't look like a valid email address."
    if len(password or "") < 8:
        return None, "Password must be at least 8 characters."
    conn = _conn()
    try:
        exists = conn.execute(
            "SELECT 1 FROM users WHERE LOWER(email) = LOWER(?)", (email,)
        ).fetchone()
        if exists:
            return None, "An account with that email already exists."
        # First user auto-becomes admin.
        is_first = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        pw_hash = generate_password_hash(password, method="pbkdf2:sha256")
        now = datetime.now(timezone.utc).isoformat()
        cur = conn.execute(
            "INSERT INTO users (email, name, password_hash, is_admin, is_active, created_at) "
            "VALUES (?, ?, ?, ?, 1, ?)",
            (email, name or None, pw_hash, 1 if is_first else 0, now),
        )
        conn.commit()
        uid = cur.lastrowid
        return User(uid, email, name or None, is_first, True), None
    finally:
        conn.close()


def touch_last_login(user_id: int) -> None:
    conn = _conn()
    try:
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), user_id),
        )
        conn.commit()
    finally:
        conn.close()


def change_password(user_id: int, old: str, new: str) -> Optional[str]:
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not row or not check_password_hash(row[0], old):
            return "Current password is incorrect."
        if len(new) < 8:
            return "New password must be at least 8 characters."
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(new, method="pbkdf2:sha256"), user_id),
        )
        conn.commit()
    finally:
        conn.close()
    return None


# --------------------------------------------------------------------------- #
# Blueprint + Flask-Login wiring
# --------------------------------------------------------------------------- #
login_manager = LoginManager()
login_manager.login_view = "auth.login"
login_manager.login_message = "Please sign in to access the portal."
login_manager.login_message_category = "info"

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


@login_manager.user_loader
def _load_user(user_id: str):
    try:
        return find_by_id(int(user_id))
    except (TypeError, ValueError):
        return None


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("home"))
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        remember = request.form.get("remember") == "1"
        result = find_by_email(email)
        if not result:
            flash("No account matches that email.", "error")
            return render_template("login.html", email=email), 401
        user, pw_hash = result
        if not check_password_hash(pw_hash, password):
            flash("Incorrect password.", "error")
            return render_template("login.html", email=email), 401
        if not user.is_active:
            flash("Your account is inactive. Contact an administrator.", "error")
            return render_template("login.html", email=email), 403
        login_user(user, remember=remember)
        touch_last_login(user.id)
        next_url = request.args.get("next")
        # only allow same-site next redirects
        if next_url and not next_url.startswith("/"):
            next_url = None
        # Post-login default lands on /live-bids (the client hero screen —
        # highest signal per screen). Explicit `?next=` still honoured.
        return redirect(next_url or url_for("live_bids"))
    return render_template("login.html", email="")


@auth_bp.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for("home"))
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        name = request.form.get("name", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")
        if password != confirm:
            flash("Passwords don't match.", "error")
            return render_template("signup.html", email=email, name=name), 400
        user, err = create_user(email, name, password)
        if err:
            flash(err, "error")
            return render_template("signup.html", email=email, name=name), 400
        login_user(user)
        touch_last_login(user.id)
        return redirect(url_for("home"))
    return render_template("signup.html", email="", name="")


@auth_bp.route("/logout")
@login_required
def logout():
    logout_user()
    session.clear()
    return redirect(url_for("auth.login"))


@auth_bp.route("/account", methods=["GET", "POST"])
@login_required
def account():
    if request.method == "POST" and request.form.get("action") == "change_password":
        err = change_password(
            current_user.id,
            request.form.get("current_password", ""),
            request.form.get("new_password", ""),
        )
        if err:
            flash(err, "error")
        else:
            flash("Password updated.", "success")
    return render_template("account.html", user=current_user)


# --------------------------------------------------------------------------- #
# Optional JSON helpers (used by API routes to fail cleanly)
# --------------------------------------------------------------------------- #
def api_login_required(fn):
    """Like @login_required but returns JSON 401 instead of redirecting."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user.is_authenticated:
            return jsonify({"error": "auth_required"}), 401
        return fn(*args, **kwargs)
    return wrapper


def init_app(app):
    """Wire Flask-Login + auth blueprint into the Flask app."""
    # Required for signed session cookies. Set SECRET_KEY in the environment
    # in production; the dev fallback is only for local runs.
    secret = os.environ.get("SECRET_KEY", "dev-only-do-not-use-in-production")
    app.secret_key = secret  # Flask's session signer reads app.secret_key
    app.config["SECRET_KEY"] = secret
    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
    # Set SESSION_COOKIE_SECURE=1 in prod (over HTTPS) — the deploy env sets it.
    if os.environ.get("SESSION_COOKIE_SECURE", "").lower() in ("1", "true", "yes"):
        app.config["SESSION_COOKIE_SECURE"] = True
    login_manager.init_app(app)
    app.register_blueprint(auth_bp)
    # ensure the users DB exists on boot
    _conn().close()
