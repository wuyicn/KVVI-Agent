-- Delivery identity is committed in the same independent audit transaction as its entry.
BEGIN;
CREATE TABLE IF NOT EXISTS audit_operation_receipts (
  operation_id uuid PRIMARY KEY,
  request_digest text NOT NULL,
  entry_hash text NOT NULL
);
REVOKE ALL ON audit_operation_receipts FROM PUBLIC;
DROP RULE IF EXISTS audit_receipt_no_update ON audit_operation_receipts;
CREATE RULE audit_receipt_no_update AS ON UPDATE TO audit_operation_receipts DO INSTEAD NOTHING;
DROP RULE IF EXISTS audit_receipt_no_delete ON audit_operation_receipts;
CREATE RULE audit_receipt_no_delete AS ON DELETE TO audit_operation_receipts DO INSTEAD NOTHING;

-- Put temporary schemas last even when the caller owns a same-named temporary table.
ALTER FUNCTION audit_append(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)
  SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION audit_append_once(
  p_operation_id uuid, p_company_id uuid, p_actor_kind text, p_actor_id uuid,
  p_gateway text, p_session_id uuid, p_action text, p_resource_kind text,
  p_resource_id text, p_outcome text, p_reason text, p_params_digest text,
  p_result_digest text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_digest text;
  v_old public.audit_operation_receipts%ROWTYPE;
  v_hash text;
BEGIN
  IF p_operation_id IS NULL THEN RAISE EXCEPTION 'KVVI_AUDIT_OPERATION_REQUIRED'; END IF;
  v_digest := encode(public.digest(jsonb_build_array(p_company_id,p_actor_kind,p_actor_id,
    p_gateway,p_session_id,p_action,p_resource_kind,p_resource_id,p_outcome,p_reason,
    p_params_digest,p_result_digest)::text,'sha256'),'hex');
  -- Same lock/order as legacy append, so both entry points share one chain.
  PERFORM pg_advisory_xact_lock(hashtext('kvvi_audit_chain'));
  SELECT * INTO v_old FROM public.audit_operation_receipts WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF v_old.request_digest <> v_digest THEN RAISE EXCEPTION 'KVVI_AUDIT_OPERATION_CONFLICT'; END IF;
    RETURN v_old.entry_hash;
  END IF;
  v_hash := public.audit_append(p_company_id,p_actor_kind,p_actor_id,p_gateway,p_session_id,
    p_action,p_resource_kind,p_resource_id,p_outcome,p_reason,p_params_digest,p_result_digest);
  INSERT INTO public.audit_operation_receipts(operation_id,request_digest,entry_hash)
    VALUES(p_operation_id,v_digest,v_hash);
  RETURN v_hash;
END $$;
REVOKE ALL ON FUNCTION audit_append_once(uuid,uuid,text,uuid,text,uuid,text,text,text,text,text,text,text) FROM PUBLIC;
COMMIT;
