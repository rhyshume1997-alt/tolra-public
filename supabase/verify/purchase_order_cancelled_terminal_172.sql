-- Prove the installed trigger on temporary rows. Run as the release operator with SET ROLE permission.
-- The transaction rolls back all fixtures and leaves purchasing records untouched.
BEGIN;
SET LOCAL search_path = pg_catalog;

CREATE TEMP TABLE po_172_probe (id integer PRIMARY KEY, status text NOT NULL);
INSERT INTO po_172_probe VALUES (1, 'cancelled'), (2, 'issued');
GRANT SELECT, UPDATE ON po_172_probe TO authenticated;

DO $attach$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_triggerdef(oid) INTO STRICT definition
  FROM pg_trigger
  WHERE tgrelid = 'public.purchase_orders'::regclass
    AND tgname = 'purchase_order_cancelled_terminal'
    AND tgfoid = 'public.purchase_order_cancelled_terminal()'::regprocedure
    AND tgenabled IN ('O', 'A');
  EXECUTE replace(definition, ' ON public.purchase_orders ', ' ON pg_temp.po_172_probe ');
END
$attach$;

SET LOCAL ROLE authenticated;

DO $verify$
DECLARE
  attempted_status text;
  refusal_hint text;
BEGIN
  FOREACH attempted_status IN ARRAY ARRAY['received', 'issued', 'draft', 'sent', 'confirmed', 'partial_received']
  LOOP
    BEGIN
      UPDATE pg_temp.po_172_probe SET status = attempted_status WHERE id = 1;
      RAISE EXCEPTION '172 verification failed: cancelled order moved to %', attempted_status;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS refusal_hint = PG_EXCEPTION_HINT;
      IF refusal_hint IS DISTINCT FROM 'purchase_order_cancelled_terminal' THEN
        RAISE;
      END IF;
    END;
  END LOOP;

  BEGIN
    UPDATE pg_temp.po_172_probe SET status = 'received' WHERE id IN (1, 2);
    RAISE EXCEPTION '172 verification failed: mixed batch accepted a cancelled order';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS refusal_hint = PG_EXCEPTION_HINT;
    IF refusal_hint IS DISTINCT FROM 'purchase_order_cancelled_terminal' THEN
      RAISE;
    END IF;
  END;
  IF (SELECT status FROM pg_temp.po_172_probe WHERE id = 2) <> 'issued' THEN
    RAISE EXCEPTION '172 verification failed: mixed batch was not atomic';
  END IF;

  UPDATE pg_temp.po_172_probe SET status = 'received' WHERE id = 2;
  IF (SELECT status FROM pg_temp.po_172_probe WHERE id = 1) <> 'cancelled'
     OR (SELECT status FROM pg_temp.po_172_probe WHERE id = 2) <> 'received' THEN
    RAISE EXCEPTION '172 verification failed: incorrect final status';
  END IF;
END
$verify$;

SELECT 'cancelled status is terminal for authenticated updates and ordinary receipt succeeds' AS check_name,
       true AS ok;
ROLLBACK;
