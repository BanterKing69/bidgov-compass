"""
BidGov Compass — admin blueprint (Phase 3).

Everything a paying client MUST NOT see lives here:
  * Sales-console pages (/admin — Overview, Pipeline, Users, Data ops tabs)
  * User management APIs
  * Bulk export + scrape controls (Phase 3 moves the *existing* /api/scrape*
    and /api/export endpoints behind admin_required; their UI moves into
    the Data-ops tab in this template)
  * Pipeline CRUD + fee economics (Phase 4)

Access is gated at two layers:
  1. @admin_required on every route in this blueprint (server-side).
  2. The Admin rail icon is only rendered when current_user.is_admin
     (see templates/_app_base.html) — but that's UX only, never trusted
     for authorisation.

Fee/pipeline data lives in users.db (added Phase 4), NEVER in tenders.db.
This keeps it out of the chat-queryable connection by construction.
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, render_template, request
from flask_login import current_user

from auth import (
    admin_required,
    count_active_admins,
    delete_user_row,
    get_user_row,
    list_all_users,
    set_user_active,
    set_user_admin,
)

# Blueprint has NO url_prefix — the page route lives at /admin, but the JSON
# API routes live at /api/admin/* (per spec §5) so the global `_require_login`
# gate in app.py catches them via its `/api/` prefix check and returns JSON 401
# for unauthenticated hits instead of a page redirect.
admin_bp = Blueprint("admin", __name__)


# --------------------------------------------------------------------------- #
# /admin — single page, client-side tab switching. Tabs: Overview · Pipeline ·
# Users · Data ops. All four are wired by static/js/admin.js.
# --------------------------------------------------------------------------- #
@admin_bp.route("/admin/")
@admin_required
def overview():
    return render_template("admin.html", user=current_user)


# --------------------------------------------------------------------------- #
# Users tab — list + activate/deactivate/promote/demote/delete
# Guards (all return 400 on refuse):
#   * Cannot act on your own account (deactivate/demote/delete yourself).
#   * Cannot demote/deactivate/delete the LAST active admin (would lock out
#     admin access — the app requires at least one admin at all times).
# All endpoints are also @admin_required (JSON 403 for non-admins).
# --------------------------------------------------------------------------- #
@admin_bp.route("/api/admin/users", methods=["GET"])
@admin_required
def api_users_list():
    return jsonify({"users": list_all_users()})


def _load_target(user_id: int):
    """Return (target_user_dict, error_response_or_None). Standardises the
    "does the user exist / are you acting on yourself" gate."""
    target = get_user_row(user_id)
    if not target:
        return None, (jsonify({"error": "user_not_found"}), 404)
    if target["id"] == current_user.id:
        return None, (jsonify({"error": "cannot_act_on_self"}), 400)
    return target, None


def _would_leave_no_admin(target: dict, *, removing_admin: bool = False,
                          deactivating: bool = False, deleting: bool = False) -> bool:
    """Would this action leave zero active admins? Only cares about the last-admin
    edge; ordinary demotions with multiple admins around are fine."""
    if not target["is_admin"]:
        return False
    # target is currently admin AND active (only these counted)
    if not target["is_active"] and not deleting:
        return False
    if count_active_admins() > 1:
        return False
    # target IS the sole active admin — any of these three actions would remove them
    return removing_admin or deactivating or deleting


@admin_bp.route("/api/admin/users/<int:user_id>/activate", methods=["POST"])
@admin_required
def api_users_activate(user_id: int):
    target, err = _load_target(user_id)
    if err: return err
    set_user_active(target["id"], True)
    return jsonify({"ok": True})


@admin_bp.route("/api/admin/users/<int:user_id>/deactivate", methods=["POST"])
@admin_required
def api_users_deactivate(user_id: int):
    target, err = _load_target(user_id)
    if err: return err
    if _would_leave_no_admin(target, deactivating=True):
        return jsonify({"error": "would_leave_no_admin"}), 400
    set_user_active(target["id"], False)
    return jsonify({"ok": True})


@admin_bp.route("/api/admin/users/<int:user_id>/promote", methods=["POST"])
@admin_required
def api_users_promote(user_id: int):
    target, err = _load_target(user_id)
    if err: return err
    set_user_admin(target["id"], True)
    return jsonify({"ok": True})


@admin_bp.route("/api/admin/users/<int:user_id>/demote", methods=["POST"])
@admin_required
def api_users_demote(user_id: int):
    target, err = _load_target(user_id)
    if err: return err
    if _would_leave_no_admin(target, removing_admin=True):
        return jsonify({"error": "would_leave_no_admin"}), 400
    set_user_admin(target["id"], False)
    return jsonify({"ok": True})


@admin_bp.route("/api/admin/users/<int:user_id>/delete", methods=["POST"])
@admin_required
def api_users_delete(user_id: int):
    target, err = _load_target(user_id)
    if err: return err
    if _would_leave_no_admin(target, deleting=True):
        return jsonify({"error": "would_leave_no_admin"}), 400
    delete_user_row(target["id"])
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Pipeline + fees APIs land here in Phase 4:
#   GET/POST /api/admin/pipeline
#   PATCH/DELETE /api/admin/pipeline/<id>
#   GET /api/admin/pipeline/export
# --------------------------------------------------------------------------- #


def init_app(app):
    """Register the admin blueprint on the Flask app."""
    app.register_blueprint(admin_bp)
