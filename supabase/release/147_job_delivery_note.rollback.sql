-- Post-144 rollback of release 147. Review first: removes the no-order delivery note function, its request-key guard, index and column.
-- Every delivery note and item is kept as it is, including notes 147 made (they keep job_id, customer_id, job_ref and number); only their
-- request key goes, so a resend after a rollback is no longer recognised as a repeat. Existing triggers, policies and functions untouched.
BEGIN;
DROP FUNCTION public.create_job_delivery_note(uuid, uuid, uuid, date, date, text, text, jsonb);
DROP TRIGGER delivery_notes_request_guard ON public.delivery_notes;
DROP FUNCTION public.delivery_notes_request_guard();
DROP INDEX public.delivery_notes_org_request_uniq;
ALTER TABLE public.delivery_notes DROP COLUMN request_id;
COMMIT;
