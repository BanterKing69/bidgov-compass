"""
pytest fixtures — bootstrap a fresh sqlite users DB and a Flask test client
for each test session.

The tenders DB (data/tenders.db, 65MB, 9k rows) is read-only for these tests
and *not* copied — we point the app at the shipped data. The users DB (which
DOES get mutated) is redirected to a per-session temp file so tests can't
step on the developer's local `admin@test.local` bootstrap.

Fixtures:
  * client      — Flask test client
  * anon        — client with no session (fresh cookies)
  * admin       — client authenticated as an admin user (first registrant)
  * user        — client authenticated as a non-admin (second registrant)
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def _sandbox_users_db(tmp_path_factory):
    """Redirect the users DB to a per-session tmp file so tests don't
    stomp on the developer's local ~/bidgov-compass/data/users.db."""
    tmp = tmp_path_factory.mktemp("bidgov-portal-tests")
    users_db = tmp / "users.db"

    # Import auth after ensuring the tmp dir exists; auth._conn() looks at
    # the module-level USERS_DB_PATH.
    import auth  # noqa: E402
    original_dir = auth.DATA_DIR
    original_path = auth.USERS_DB_PATH
    auth.DATA_DIR = tmp
    auth.USERS_DB_PATH = users_db
    yield users_db
    auth.DATA_DIR = original_dir
    auth.USERS_DB_PATH = original_path


@pytest.fixture(scope="session")
def flask_app(_sandbox_users_db):
    """Import app.py fresh (once per session) with the users DB redirected.
    admin.py is registered as part of app.py's import."""
    # SESSION_COOKIE_SECURE must be off for the plain-HTTP test client.
    os.environ.pop("SESSION_COOKIE_SECURE", None)
    os.environ["SECRET_KEY"] = "test-secret-do-not-use-in-prod"
    os.environ["ALLOW_SIGNUP"] = "1"

    import app as app_mod
    importlib.reload(app_mod)  # ensure auth's patched paths take effect
    app_mod.app.config["TESTING"] = True
    return app_mod.app


@pytest.fixture
def client(flask_app):
    return flask_app.test_client()


def _signup(client, email, name, password="testpass1234"):
    return client.post("/auth/signup", data={
        "email": email, "name": name,
        "password": password, "confirm": password,
    }, follow_redirects=False)


def _login(client, email, password="testpass1234"):
    return client.post("/auth/login", data={
        "email": email, "password": password,
    }, follow_redirects=False)


@pytest.fixture
def anon(flask_app):
    """Fresh unauthenticated client — new cookie jar per test."""
    return flask_app.test_client()


@pytest.fixture(scope="session")
def _seed_users(flask_app):
    """One-time seed: first registrant is admin, second is regular."""
    c = flask_app.test_client()
    r1 = _signup(c, "admin_pytest@test.local", "Admin PyTest")
    assert r1.status_code in (200, 302), f"admin signup failed: {r1.status_code}"
    c.get("/auth/logout")
    r2 = _signup(c, "user_pytest@test.local", "User PyTest")
    assert r2.status_code in (200, 302), f"user signup failed: {r2.status_code}"
    c.get("/auth/logout")
    # And a spare admin so tests that delete an admin still leave one behind
    r3 = _signup(c, "admin2_pytest@test.local", "Admin 2 PyTest")
    assert r3.status_code in (200, 302)
    # Promote the third user to admin by direct DB write
    import auth
    conn = auth._conn()
    try:
        conn.execute("UPDATE users SET is_admin=1 WHERE email=?", ("admin2_pytest@test.local",))
        conn.commit()
    finally:
        conn.close()
    return {
        "admin_email":  "admin_pytest@test.local",
        "user_email":   "user_pytest@test.local",
        "admin2_email": "admin2_pytest@test.local",
    }


@pytest.fixture
def admin(flask_app, _seed_users):
    """Client authenticated as the primary admin (first registrant)."""
    c = flask_app.test_client()
    r = _login(c, _seed_users["admin_email"])
    assert r.status_code == 302, f"admin login failed: {r.status_code}"
    return c


@pytest.fixture
def user(flask_app, _seed_users):
    """Client authenticated as a non-admin."""
    c = flask_app.test_client()
    r = _login(c, _seed_users["user_email"])
    assert r.status_code == 302, f"user login failed: {r.status_code}"
    return c


@pytest.fixture
def admin2(flask_app, _seed_users):
    """A second admin — used by last-admin-guard tests that need TWO admins
    initially so we can safely act on one without hitting the guard."""
    c = flask_app.test_client()
    r = _login(c, _seed_users["admin2_email"])
    assert r.status_code == 302
    return c


@pytest.fixture
def user_ids(flask_app, _seed_users):
    """Map email → user id for tests that need to POST to /admin/api/users/<id>/*"""
    import auth
    conn = auth._conn()
    try:
        rows = conn.execute("SELECT id, email FROM users").fetchall()
    finally:
        conn.close()
    m = {email: uid for uid, email in rows}
    return m
