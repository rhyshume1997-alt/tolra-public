-- Release 172. Inputs: purchase-order updates under browser database roles.
-- Output: reject a change from cancelled to another status. Preserve existing policies and triggers.
BEGIN;

CREATE OR REPLACE FUNCTION public.purchase_order_cancelled_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', true), 'none'), session_user::text)
       IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Cancelled purchase orders cannot change status.'
      USING ERRCODE = '23514', HINT = 'purchase_order_cancelled_terminal';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.purchase_order_cancelled_terminal() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER purchase_order_cancelled_terminal
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW
  WHEN (OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.purchase_order_cancelled_terminal();

COMMIT;
