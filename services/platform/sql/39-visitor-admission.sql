BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kvvi_visitor_owner') THEN
    CREATE ROLE kvvi_visitor_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE kvvi_visitor_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE kvvi_visitor_owner FROM kvvi_business;
CREATE SCHEMA IF NOT EXISTS kvvi_visitor_private AUTHORIZATION kvvi_visitor_owner;
ALTER SCHEMA kvvi_visitor_private OWNER TO kvvi_visitor_owner;
REVOKE ALL ON SCHEMA kvvi_visitor_private FROM PUBLIC,kvvi_business;
GRANT USAGE ON SCHEMA kvvi_visitor_private TO kvvi_business;
GRANT USAGE ON SCHEMA public TO kvvi_visitor_owner;
CREATE UNIQUE INDEX IF NOT EXISTS record_write_actor_operation ON public.record_write_operations(company_id,actor_id,operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS visitor_record_company ON public.business_records(company_id,record_id);

CREATE TABLE IF NOT EXISTS public.visitor_submissions(
  company_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  link_id uuid NOT NULL,
  issuer_id uuid NOT NULL,
  record_id uuid NOT NULL,
  admitted_at timestamptz NOT NULL,
  projection_payload jsonb NOT NULL CHECK(jsonb_typeof(projection_payload)='object'),
  projected_at timestamptz,
  projection_attempts integer NOT NULL DEFAULT 0,
  projection_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,operation_id),
  FOREIGN KEY(company_id,issuer_id,operation_id) REFERENCES public.record_write_operations(company_id,actor_id,operation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(company_id,record_id) REFERENCES public.business_records(company_id,record_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS visitor_projection_pending ON public.visitor_submissions(company_id,projection_next_attempt_at,admitted_at) WHERE projected_at IS NULL;
ALTER TABLE public.visitor_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visitor_submission_company ON public.visitor_submissions;
CREATE POLICY visitor_submission_company ON public.visitor_submissions
  USING(company_id=public.kvvi_guc_uuid('kvvi.company_id')) WITH CHECK(company_id=public.kvvi_guc_uuid('kvvi.company_id'));

CREATE TABLE IF NOT EXISTS kvvi_visitor_private.config(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  window_ms integer NOT NULL CHECK(window_ms>0),
  source_limit integer NOT NULL CHECK(source_limit>=0),
  company_limit integer NOT NULL CHECK(company_limit>=0),
  link_window_limit integer NOT NULL CHECK(link_window_limit>=0)
);
INSERT INTO kvvi_visitor_private.config(singleton,window_ms,source_limit,company_limit,link_window_limit)
  VALUES(true,3600000,30,2000,5) ON CONFLICT(singleton) DO NOTHING;
ALTER TABLE kvvi_visitor_private.config OWNER TO kvvi_visitor_owner;
REVOKE ALL ON kvvi_visitor_private.config FROM PUBLIC,kvvi_business;

CREATE TABLE IF NOT EXISTS kvvi_visitor_private.admissions(
  operation_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  issuer_id uuid NOT NULL,
  link_id uuid NOT NULL,
  max_submissions integer NOT NULL CHECK(max_submissions>0),
  binding_digest text NOT NULL CHECK(binding_digest~'^[a-f0-9]{64}$'),
  source_key text CHECK(source_key~'^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  admitted_at timestamptz NOT NULL,
  FOREIGN KEY(company_id,issuer_id,operation_id) REFERENCES public.record_write_operations(company_id,actor_id,operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS visitor_admissions_company ON kvvi_visitor_private.admissions(company_id,admitted_at);
CREATE INDEX IF NOT EXISTS visitor_admissions_source ON kvvi_visitor_private.admissions(source_key,admitted_at) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS visitor_admissions_link ON kvvi_visitor_private.admissions(company_id,link_id);
ALTER TABLE kvvi_visitor_private.admissions OWNER TO kvvi_visitor_owner;
REVOKE ALL ON kvvi_visitor_private.admissions FROM PUBLIC,kvvi_business;

CREATE OR REPLACE FUNCTION kvvi_visitor_private.admit(p_company uuid,p_issuer uuid,p_link uuid,p_operation uuid,
  p_max integer,p_binding text,p_source text,p_expires timestamptz) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog,kvvi_visitor_private,pg_temp AS $$
DECLARE
  cfg kvvi_visitor_private.config%ROWTYPE;
  old kvvi_visitor_private.admissions%ROWTYPE;
  accepted_at timestamptz;
  since_at timestamptz;
  lifetime bigint;
  recent bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'KVVI_VISITOR_ISOLATION_UNSUPPORTED'; END IF;
  IF p_company IS NULL OR p_issuer IS NULL OR current_setting('kvvi.company_id',true) IS DISTINCT FROM p_company::text
    OR current_setting('kvvi.user_id',true) IS DISTINCT FROM p_issuer::text THEN RAISE EXCEPTION 'KVVI_NOT_ALLOWED'; END IF;
  IF p_link IS NULL OR p_operation IS NULL OR p_max IS NULL OR p_max<1 OR p_expires IS NULL OR NOT isfinite(p_expires)
    OR p_binding IS NULL OR p_binding!~'^[a-f0-9]{64}$' OR (p_source IS NOT NULL AND p_source!~'^[a-f0-9]{64}$')
    THEN RAISE EXCEPTION 'KVVI_VISITOR_ADMISSION_INVALID'; END IF;
  -- All quota writers take the same locks before any quota reads. Separate
  -- VOLATILE statements under READ COMMITTED observe commits after waiting.
  IF p_source IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('visitor-source:'||p_source,0)); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('visitor-company:'||p_company::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('visitor-link:'||p_company::text||':'||p_link::text,0));
  SELECT * INTO cfg FROM kvvi_visitor_private.config WHERE singleton FOR SHARE;
  IF NOT FOUND OR NOT cfg.enabled THEN RAISE EXCEPTION 'KVVI_VISITOR_CUTOVER_REQUIRED'; END IF;
  accepted_at:=clock_timestamp();
  IF p_expires<=accepted_at THEN RAISE EXCEPTION 'KVVI_LINK_EXPIRED'; END IF;
  since_at:=accepted_at-(interval '1 millisecond'*cfg.window_ms);
  SELECT * INTO old FROM kvvi_visitor_private.admissions WHERE operation_id=p_operation;
  IF FOUND THEN
    IF old.company_id<>p_company OR old.issuer_id<>p_issuer OR old.link_id<>p_link OR old.max_submissions<>p_max
      OR old.binding_digest<>p_binding OR old.source_key IS DISTINCT FROM p_source OR old.expires_at<>p_expires
      THEN RAISE EXCEPTION 'KVVI_OPERATION_KEY_CONFLICT'; END IF;
    RETURN old.admitted_at;
  END IF;
  SELECT * INTO old FROM kvvi_visitor_private.admissions WHERE company_id=p_company AND link_id=p_link LIMIT 1;
  IF FOUND AND (old.issuer_id<>p_issuer OR old.max_submissions<>p_max OR old.binding_digest<>p_binding OR old.expires_at<>p_expires)
    THEN RAISE EXCEPTION 'KVVI_VISITOR_BINDING_CHANGED'; END IF;
  SELECT count(*),count(*) FILTER(WHERE admitted_at>since_at) INTO lifetime,recent
    FROM kvvi_visitor_private.admissions WHERE company_id=p_company AND link_id=p_link;
  IF lifetime>=p_max THEN RAISE EXCEPTION 'KVVI_RATE_LIMITED_LINK' USING DETAIL=json_build_object('limit',p_max)::text; END IF;
  IF recent>=cfg.link_window_limit THEN RAISE EXCEPTION 'KVVI_RATE_LIMITED_LINK_WINDOW' USING DETAIL=json_build_object('limit',cfg.link_window_limit)::text; END IF;
  IF p_source IS NOT NULL THEN
    SELECT count(*) INTO recent FROM kvvi_visitor_private.admissions WHERE source_key=p_source AND admitted_at>since_at;
    IF recent>=cfg.source_limit THEN RAISE EXCEPTION 'KVVI_RATE_LIMITED_SOURCE' USING DETAIL=json_build_object('limit',cfg.source_limit)::text; END IF;
  END IF;
  SELECT count(*) INTO recent FROM kvvi_visitor_private.admissions WHERE company_id=p_company AND admitted_at>since_at;
  IF recent>=cfg.company_limit THEN RAISE EXCEPTION 'KVVI_RATE_LIMITED_COMPANY' USING DETAIL=json_build_object('limit',cfg.company_limit)::text; END IF;
  INSERT INTO kvvi_visitor_private.admissions(operation_id,company_id,issuer_id,link_id,max_submissions,binding_digest,source_key,expires_at,admitted_at)
    VALUES(p_operation,p_company,p_issuer,p_link,p_max,p_binding,p_source,p_expires,accepted_at);
  RETURN accepted_at;
END $$;
ALTER FUNCTION kvvi_visitor_private.admit(uuid,uuid,uuid,uuid,integer,text,text,timestamptz) OWNER TO kvvi_visitor_owner;
REVOKE ALL ON FUNCTION kvvi_visitor_private.admit(uuid,uuid,uuid,uuid,integer,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvvi_visitor_private.admit(uuid,uuid,uuid,uuid,integer,text,text,timestamptz) TO kvvi_business;
COMMIT;
