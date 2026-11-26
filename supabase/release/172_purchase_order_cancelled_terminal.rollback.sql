-- Remove only release 172's guard. Restores the earlier browser transition behavior.
BEGIN;
DROP TRIGGER IF EXISTS purchase_order_cancelled_terminal ON public.purchase_orders;
DROP FUNCTION IF EXISTS public.purchase_order_cancelled_terminal();
COMMIT;
