-- Identity reservation only: this is not a published model or approval store.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kvvi_registry_owner') THEN
    CREATE ROLE kvvi_registry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE kvvi_registry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE kvvi_registry_owner FROM kvvi_platform;
-- applyFile records its ledger after this COMMIT; replay must preserve data if
-- that final acknowledgement is lost. All policy/function resets are atomic.
CREATE SCHEMA IF NOT EXISTS kvvi_registry_private AUTHORIZATION kvvi_registry_owner;
ALTER SCHEMA kvvi_registry_private OWNER TO kvvi_registry_owner;
REVOKE ALL ON SCHEMA kvvi_registry_private FROM PUBLIC,kvvi_platform;
GRANT USAGE ON SCHEMA kvvi_registry_private TO kvvi_platform;
GRANT USAGE ON SCHEMA public TO kvvi_registry_owner;

CREATE TABLE IF NOT EXISTS kvvi_registry_private.business_identities (
  schema_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(company_id),
  app_id text COLLATE "C" CHECK(app_id IS NULL OR length(app_id)>0),
  module_id text COLLATE "C" CHECK(module_id IS NULL OR length(module_id)>0),
  asset_id text COLLATE "C" NOT NULL CHECK(length(asset_id)>0),
  schema_code text COLLATE "C" NOT NULL CHECK(schema_code~'^[a-z][a-z0-9_]{2,63}$' AND schema_code!~'[^a-z0-9_]'),
  -- Private index buckets, not public c14n/content digests. Exact values are
  -- checked on lookup, so even a hash collision cannot alias another identity.
  identity_key bytea NOT NULL CHECK(octet_length(identity_key)=32),
  code_key bytea NOT NULL CHECK(octet_length(code_key)=32),
  created_by uuid NOT NULL REFERENCES public.users(user_id),
  created_session_id uuid NOT NULL REFERENCES public.sessions(session_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  trace_id text NOT NULL CHECK(length(trace_id)>0),
  UNIQUE(company_id,identity_key),
  UNIQUE(company_id,code_key),
  FOREIGN KEY(company_id,created_by) REFERENCES public.memberships(company_id,user_id)
);
ALTER TABLE kvvi_registry_private.business_identities OWNER TO kvvi_registry_owner;
ALTER TABLE kvvi_registry_private.business_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kvvi_registry_private.business_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registry_identity_company ON kvvi_registry_private.business_identities;
CREATE POLICY registry_identity_company ON kvvi_registry_private.business_identities
  USING(company_id=NULLIF(current_setting('kvvi.company_id',true),'')::uuid)
  WITH CHECK(company_id=NULLIF(current_setting('kvvi.company_id',true),'')::uuid);
REVOKE ALL ON kvvi_registry_private.business_identities FROM PUBLIC,kvvi_platform;

CREATE OR REPLACE FUNCTION kvvi_registry_private.immutable_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'KVVI_REGISTRY_IMMUTABLE'; END $$;
ALTER FUNCTION kvvi_registry_private.immutable_identity() OWNER TO kvvi_registry_owner;
REVOKE ALL ON FUNCTION kvvi_registry_private.immutable_identity() FROM PUBLIC,kvvi_platform;
DROP TRIGGER IF EXISTS registry_identity_immutable ON kvvi_registry_private.business_identities;
CREATE TRIGGER registry_identity_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON kvvi_registry_private.business_identities FOR EACH STATEMENT EXECUTE FUNCTION kvvi_registry_private.immutable_identity();

-- GUC checks establish server-call context consistency, not end-user authority.
-- The host must authorize on its borrowed transaction after this namespace lock.
CREATE OR REPLACE FUNCTION kvvi_registry_private.lock_business_namespace(p_company uuid,p_app text,p_module text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'KVVI_REGISTRY_ISOLATION_UNSUPPORTED'; END IF;
  IF p_company IS NULL OR current_setting('kvvi.company_id',true) IS DISTINCT FROM p_company::text
    OR COALESCE(current_setting('kvvi.user_id',true),'')=''
    OR COALESCE(current_setting('kvvi.session_id',true),'')=''
    THEN RAISE EXCEPTION 'KVVI_REGISTRY_CONTEXT_REQUIRED'; END IF;
  IF (p_app IS NOT NULL AND p_app='') OR (p_module IS NOT NULL AND p_module='') THEN RAISE EXCEPTION 'KVVI_REGISTRY_INPUT_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('business-namespace:'||jsonb_build_array(p_company,p_app,p_module)::text,0));
END $$;
ALTER FUNCTION kvvi_registry_private.lock_business_namespace(uuid,text,text) OWNER TO kvvi_registry_owner;
REVOKE ALL ON FUNCTION kvvi_registry_private.lock_business_namespace(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvvi_registry_private.lock_business_namespace(uuid,text,text) TO kvvi_platform;

CREATE OR REPLACE FUNCTION kvvi_registry_private.reserve_business_identity(p_company uuid,p_app text,p_module text,p_asset text,
  p_code text,p_actor uuid,p_session uuid,p_trace text) RETURNS SETOF kvvi_registry_private.business_identities
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE old kvvi_registry_private.business_identities%ROWTYPE; identity_hash bytea; code_hash bytea;
BEGIN
  IF p_actor IS NULL OR p_session IS NULL
    OR current_setting('kvvi.user_id',true) IS DISTINCT FROM p_actor::text
    OR current_setting('kvvi.session_id',true) IS DISTINCT FROM p_session::text
    THEN RAISE EXCEPTION 'KVVI_REGISTRY_CONTEXT_REQUIRED'; END IF;
  PERFORM kvvi_registry_private.lock_business_namespace(p_company,p_app,p_module);
  IF p_asset IS NULL OR p_asset='' OR p_code IS NULL OR p_code!~'^[a-z][a-z0-9_]{2,63}$' OR p_code~'[^a-z0-9_]'
    OR p_trace IS NULL OR p_trace='' THEN RAISE EXCEPTION 'KVVI_REGISTRY_INPUT_INVALID'; END IF;
  identity_hash:=sha256(convert_to(jsonb_build_array(p_app,p_module,p_asset)::text,'UTF8'));
  code_hash:=sha256(convert_to(jsonb_build_array(p_app,p_module,p_code)::text,'UTF8'));
  SELECT * INTO old FROM kvvi_registry_private.business_identities WHERE company_id=p_company AND identity_key=identity_hash;
  IF FOUND THEN
    IF old.app_id IS DISTINCT FROM p_app COLLATE "C" OR old.module_id IS DISTINCT FROM p_module COLLATE "C"
      OR old.asset_id IS DISTINCT FROM p_asset COLLATE "C" OR old.schema_code IS DISTINCT FROM p_code COLLATE "C"
      THEN RAISE EXCEPTION 'KVVI_REGISTRY_IDENTITY_CONFLICT'; END IF;
    RETURN NEXT old; RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM kvvi_registry_private.business_identities WHERE company_id=p_company AND code_key=code_hash)
    THEN RAISE EXCEPTION 'KVVI_REGISTRY_CODE_CONFLICT'; END IF;
  INSERT INTO kvvi_registry_private.business_identities(company_id,app_id,module_id,asset_id,schema_code,
    identity_key,code_key,created_by,created_session_id,trace_id)
    VALUES(p_company,p_app,p_module,p_asset,p_code,identity_hash,code_hash,p_actor,p_session,p_trace) RETURNING * INTO old;
  RETURN NEXT old;
END $$;
ALTER FUNCTION kvvi_registry_private.reserve_business_identity(uuid,text,text,text,text,uuid,uuid,text) OWNER TO kvvi_registry_owner;
REVOKE ALL ON FUNCTION kvvi_registry_private.reserve_business_identity(uuid,text,text,text,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvvi_registry_private.reserve_business_identity(uuid,text,text,text,text,uuid,uuid,text) TO kvvi_platform;
COMMIT;
