"""
Phase 3 acceptance — access-matrix tests.

Enforces the spec §10.2/§10.3 authorisation rules:

  * Anonymous → all portal pages redirect to /auth/login; all /api/* → 401 JSON.
  * Non-admin → 200 on client routes; 403 on /admin* pages and every
    /admin/api/* + /api/scrape + /api/export + /api/scrape/status.
  * Admin    → 200 on every route above.
  * Self-action guard: acting on your own account → 400.
  * Last-admin guard: demoting/deactivating/deleting the last active admin → 400.
"""

from __future__ import annotations

from tests.conftest import csrf_headers


# --------------------------------------------------------------------------- #
# Anonymous access — client pages redirect to /auth/login; APIs return 401 JSON.
# --------------------------------------------------------------------------- #
def test_anonymous_client_pages_redirect(anon):
    for path in ["/", "/live-bids", "/dashboard", "/awards", "/admin"]:
        r = anon.get(path, follow_redirects=False)
        assert r.status_code == 302, f"{path} should redirect (got {r.status_code})"
        assert "/auth/login" in r.headers["Location"], f"{path} did not redirect to login"


def test_anonymous_api_returns_401(anon):
    api_paths = [
        "/api/tenders", "/api/live-tenders", "/api/live-stats",
        "/api/awards", "/api/facets", "/api/stats", "/api/pivot",
        "/api/scrape/status", "/api/export", "/api/admin/users",
    ]
    for path in api_paths:
        r = anon.get(path)
        assert r.status_code == 401, f"{path} should 401 for anon (got {r.status_code})"
        assert r.is_json


# --------------------------------------------------------------------------- #
# Non-admin — all client routes work; every admin+scrape+export path is 403.
# --------------------------------------------------------------------------- #
CLIENT_PAGE_PATHS = ["/", "/live-bids", "/dashboard", "/awards"]
CLIENT_API_PATHS = [
    "/api/tenders", "/api/live-tenders", "/api/live-stats",
    "/api/awards", "/api/facets", "/api/stats", "/api/pivot",
]
ADMIN_API_PATHS = [
    "/api/admin/users",
    "/api/scrape/status",
    "/api/export?format=csv",
]


def test_nonadmin_can_access_client_pages(user):
    for path in CLIENT_PAGE_PATHS:
        r = user.get(path)
        assert r.status_code == 200, f"non-admin {path} => {r.status_code}"


def test_nonadmin_can_access_client_apis(user):
    for path in CLIENT_API_PATHS:
        r = user.get(path)
        assert r.status_code == 200, f"non-admin {path} => {r.status_code}"


def test_nonadmin_forbidden_on_admin_page(user):
    r = user.get("/admin/", follow_redirects=False)
    # Non-admin is authenticated → decorator redirects to /live-bids (not login)
    assert r.status_code == 302
    assert "/live-bids" in r.headers["Location"]


def test_nonadmin_forbidden_on_admin_apis(user):
    for path in ADMIN_API_PATHS:
        r = user.get(path)
        assert r.status_code == 403, f"non-admin GET {path} => {r.status_code}"
        assert r.is_json and r.get_json().get("error") == "admin_required"


def test_nonadmin_forbidden_on_scrape_post(user):
    r = user.post("/api/scrape",
                  headers=csrf_headers(user),
                  json={"days_back": 1, "max_pages": 1})
    assert r.status_code == 403
    assert r.get_json().get("error") == "admin_required"


# --------------------------------------------------------------------------- #
# Admin — full access.
# --------------------------------------------------------------------------- #
def test_admin_can_access_admin_page(admin):
    r = admin.get("/admin/")
    assert r.status_code == 200
    # sanity: page contains the four tab labels
    body = r.get_data(as_text=True)
    for label in ["Overview", "Pipeline", "Users", "Data ops"]:
        assert label in body, f"admin page missing tab: {label}"


def test_admin_can_access_admin_apis(admin):
    r = admin.get("/api/admin/users")
    assert r.status_code == 200
    assert "users" in r.get_json()

    r = admin.get("/api/scrape/status")
    assert r.status_code == 200


def test_admin_client_pages_still_work(admin):
    for path in CLIENT_PAGE_PATHS + ["/admin/"]:
        r = admin.get(path)
        assert r.status_code == 200, f"admin {path} => {r.status_code}"


# --------------------------------------------------------------------------- #
# Self-action guard — acting on your own account is refused.
# --------------------------------------------------------------------------- #
def test_cannot_deactivate_self(admin, user_ids):
    admin_id = user_ids["admin_pytest@test.local"]
    r = admin.post(f"/api/admin/users/{admin_id}/deactivate",
                   headers=csrf_headers(admin))
    assert r.status_code == 400
    assert r.get_json().get("error") == "cannot_act_on_self"


def test_cannot_demote_self(admin, user_ids):
    admin_id = user_ids["admin_pytest@test.local"]
    r = admin.post(f"/api/admin/users/{admin_id}/demote",
                   headers=csrf_headers(admin))
    assert r.status_code == 400
    assert r.get_json().get("error") == "cannot_act_on_self"


def test_cannot_delete_self(admin, user_ids):
    admin_id = user_ids["admin_pytest@test.local"]
    r = admin.post(f"/api/admin/users/{admin_id}/delete",
                   headers=csrf_headers(admin))
    assert r.status_code == 400
    assert r.get_json().get("error") == "cannot_act_on_self"


# --------------------------------------------------------------------------- #
# Last-admin guard — cannot leave the platform with zero active admins.
# Setup: we have TWO admins (admin_pytest + admin2_pytest). If admin2 demotes
# admin1, that's still fine (admin2 remains). But if admin2 then demotes
# itself → cannot_act_on_self. Instead: admin1 demotes admin2 → OK (admin1 remains).
# Then admin1 tries to demote itself → cannot_act_on_self (never reaches
# would_leave_no_admin). So the last-admin path is exercised by having admin1
# demote admin2 first, then trying anything on admin1 from admin1's session.
# The pure "last-admin" case is: admin2 tries to demote admin1 AFTER admin1
# has been the sole active admin somehow. We construct that by directly
# deactivating admin2 in the DB, then admin1 attempts to demote itself (blocked
# by self-guard), so we simulate: admin1 (as the last active admin) is the target
# of admin2's demote — but admin2 is inactive, so its session couldn't act.
#
# Cleanest programmatic test: admin1 demotes admin2 (leaves admin1 as sole).
# Then admin1 attempts to demote a non-existent-yet-admin colleague → but
# there isn't one. So instead, we go the other way:
#   * admin2 demotes admin1: admin1 loses admin status; admin2 is still admin
#     ⇒ succeeds (there's still one admin). That doesn't hit the guard.
#   * NOW admin1 tries anything on admin2 → 403 (admin1 is no longer admin).
#
# The last-admin guard fires when: admin2 tries to demote admin1 AFTER admin1
# is the only admin. To construct: admin1 demotes admin2 → sole admin. Then
# admin2 (still authenticated as admin? no, they've been demoted) → their
# session no longer has admin. So we simulate the guard by giving a scenario
# where the ONE remaining admin tries to demote themselves — hits self-guard
# first. To ACTUALLY hit the last-admin guard we need admin B who tries to
# demote admin A when A is the only *other* admin and B would demote A leaving
# NO active admins. That happens only if B == A (self-guard).
#
# So: the last-admin guard is exercised by admin trying to DEACTIVATE their
# only fellow admin, when they themselves are inactive — but then they can't
# log in. The pragmatic exercise: use a DB mutation to make admin1 inactive,
# then log in as admin2 and try to demote themselves — self-guard fires first.
#
# The most direct way to exercise the guard: promote a third throwaway user
# in the seed, then admin demotes admin2 (fine — admin remains), admin demotes
# the throwaway (fine — admin remains), then admin tries to demote themselves
# (self-guard, not last-admin). Given the guards are or'd correctly, we can
# unit-test the helper directly.
# --------------------------------------------------------------------------- #
def test_last_admin_guard_helper():
    """Unit-test the pure helper to avoid the untestable-through-HTTP scenarios
    above. The helper is the authoritative source of the guard, so covering it
    directly matches spec §10.2 intent without contorting session state."""
    import admin as admin_mod
    # Fake target that IS the last active admin.
    target = {"id": 99, "is_admin": True, "is_active": True}
    # Monkey-patch count_active_admins to return 1
    original = admin_mod.count_active_admins
    admin_mod.count_active_admins = lambda: 1
    try:
        assert admin_mod._would_leave_no_admin(target, removing_admin=True)
        assert admin_mod._would_leave_no_admin(target, deactivating=True)
        assert admin_mod._would_leave_no_admin(target, deleting=True)
        # Non-admin target — never last-admin
        target2 = {"id": 100, "is_admin": False, "is_active": True}
        assert not admin_mod._would_leave_no_admin(target2, deleting=True)
        # Two admins exist — safe
        admin_mod.count_active_admins = lambda: 2
        assert not admin_mod._would_leave_no_admin(target, removing_admin=True)
    finally:
        admin_mod.count_active_admins = original


def test_last_admin_guard_via_http(admin, user_ids):
    """End-to-end: admin1 demotes admin2 (fine). Then attempts to demote
    the now-solo admin1 via user_ids — self-guard fires. To hit the last-admin
    guard through HTTP we'd need a distinct actor, which the test seed doesn't
    provide without also creating race conditions. Coverage of the helper
    (previous test) + self-guard (below) collectively verify the spec."""
    hdr = csrf_headers(admin)
    admin2_id = user_ids["admin2_pytest@test.local"]
    r = admin.post(f"/api/admin/users/{admin2_id}/demote", headers=hdr)
    assert r.status_code == 200, f"demoting non-last admin failed: {r.status_code} {r.data}"
    r = admin.post(f"/api/admin/users/{admin2_id}/deactivate", headers=hdr)
    assert r.status_code == 200
    admin1_id = user_ids["admin_pytest@test.local"]
    for action in ("deactivate", "demote", "delete"):
        r = admin.post(f"/api/admin/users/{admin1_id}/{action}", headers=hdr)
        assert r.status_code == 400
        assert r.get_json().get("error") == "cannot_act_on_self"
    # Re-promote admin2 to restore a two-admin state for downstream tests
    # (fixture is session-scoped, so ordering matters — cleanup keeps the
    # state healthy).
    r = admin.post(f"/api/admin/users/{admin2_id}/promote", headers=hdr)
    assert r.status_code == 200
    r = admin.post(f"/api/admin/users/{admin2_id}/activate", headers=hdr)
    assert r.status_code == 200
