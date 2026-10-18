-- Version numbering must see every existing version, not only the rows the
-- caller's RLS policies expose. As SECURITY INVOKER, a write that referenced
-- another organization's employee computed version 1, collided with the
-- unique (employee_id, version) key, and failed with 23505 before the
-- tenant-consistency foreign key could reject it with 23503 — revealing that
-- the referenced row exists. These triggers only read max(version) for the
-- row being inserted, so running them as the owner exposes nothing.

alter function private.assign_employee_version() security definer;
alter function private.assign_workflow_version() security definer;
