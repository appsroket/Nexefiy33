-- Local stand-in for Supabase's pg_jsonschema: the same two functions, backed
-- by Python's jsonschema package. For local testing only.
create function @extschema@.jsonb_matches_schema(schema json, instance jsonb)
returns boolean
language plpython3u
immutable
as $py$
import json
import jsonschema
if schema is None or instance is None:
    return None
try:
    jsonschema.validate(json.loads(instance), json.loads(schema))
    return True
except jsonschema.ValidationError:
    return False
$py$;

create function @extschema@.json_matches_schema(schema json, instance json)
returns boolean language sql immutable
as $$ select @extschema@.jsonb_matches_schema(schema, instance::jsonb) $$;
