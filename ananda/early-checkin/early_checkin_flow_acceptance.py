#!/usr/bin/env python3
"""Static acceptance checks for early-check-in manager decision routing."""
import os
from pathlib import Path

ROOT = Path(os.environ.get("ANANDA_PROJECT_ROOT") or Path(__file__).resolve().parents[1])
staff_path = ROOT / "app" / "bots" / "staff.py"
guest_path = ROOT / "app" / "bots" / "guest.py"
staff = staff_path.read_text(encoding="utf-8")
guest = guest_path.read_text(encoding="utf-8")

# Newly created manager cards must use the explicit four-part route.
keyboard_start = staff.index("def early_checkin_keyboard(")
keyboard_end = staff.index("\n\nasync def get_active_manager", keyboard_start)
keyboard = staff[keyboard_start:keyboard_end]
assert 'callback_data=f"early:decision:confirm:{notification_id}"' in keyboard
assert 'callback_data=f"early:decision:reject:{notification_id}"' in keyboard

# Broad early:* must not capture the decision callback before its handler.
assert '@dp.callback_query(F.data.startswith("early:"))' not in staff
assert '@dp.callback_query(F.data.regexp(r"^early:(?:approve|reject):\\d+$"))' in staff
assert '@dp.callback_query(F.data.startswith("early:decision:"))' in staff
legacy_start = staff.index('@dp.callback_query(F.data.regexp(r"^early:(?:approve|reject):\\d+$"))')
legacy_end = staff.index('@dp.callback_query(F.data.startswith("early:decision:"))', legacy_start)
legacy = staff[legacy_start:legacy_end]
assert '"kind": "early_checkin_decision"' in legacy
assert '"early_checkin_decision_pending": False' in legacy
assert '"early_checkin_response"' not in legacy
assert 'payload.get("manager_decision") or payload.get("decision")' in legacy
assert '"decision": decision' in legacy
assert '"confirm" if action == "approve" else "reject"' in legacy
assert 'early_checkin_decision_pending' in legacy and 'early_checkin_time' in legacy

# New decision route must also use the shared notification kind and suppress duplicate actions.
new_start = staff.index('@dp.callback_query(F.data.startswith("early:decision:"))')
new_end = staff.find('\n@dp.callback_query', new_start + 1)
new_route = staff[new_start:new_end if new_end != -1 else None]
assert '"kind": "early_checkin_decision"' in new_route
assert 'early_checkin_decision_pending' in new_route

# Worker code already installed by FIX6 attaches Next to the decision response,
# then the guest callback advances to message #9 (arrival-mode selection).
assert 'if payload.get("kind") == "early_checkin_decision":' in guest
assert '"scenario:next:arrival_mode"' in guest
next_start = guest.index('async def cb_scenario_next_arrival_mode(')
next_end = guest.find('\n@dp.callback_query', next_start)
next_handler = guest[next_start:next_end if next_end != -1 else None]
assert 'GuestState.ARRIVAL_MODE' in next_handler
assert 't(lang, "arrival_mode")' in next_handler

print("EARLY_CHECKIN_MANAGER_KEYBOARD_OK")
print("EARLY_CHECKIN_CALLBACK_ROUTE_NOT_SHADOWED_OK")
print("EARLY_CHECKIN_LEGACY_BUTTONS_COMPATIBLE_OK")
print("EARLY_CHECKIN_APPROVE_AND_REJECT_RESPONSE_OK")
print("EARLY_CHECKIN_NEXT_TO_MESSAGE_9_OK")
print("EARLY_CHECKIN_FLOW_ACCEPTANCE_OK")
