-- Post-144 rollback of release 147. Review first: removes the no-order delivery note function, the request key (and hash) guard, index
-- and columns, the numbering guard and the hold table. Every delivery note and item is kept as it is, including notes 147 made (they keep
-- job_id, customer_id, job_ref and number); only their request key and hash go, so a resend after a rollback is no longer recognised as a
-- repeat. With the hold table gone, a company whose cutover counter step has not run is no longer held, and browser-made notes may again
-- carry a typed number: a rollback before the counter step needs Rhys's decision on numbering first. Existing triggers, policies and
-- functions from before 147 are untouched.
BEGIN;
DROP FUNCTION public.create_job_delivery_note(uuid, uuid, uuid, date, date, text, text, jsonb);
DROP TRIGGER delivery_notes_numbering_guard ON public.delivery_notes;
DROP FUNCTION public.delivery_notes_numbering_guard();
DROP TABLE public.dln_numbering_pending;
DROP TRIGGER delivery_notes_request_guard ON public.delivery_notes;
DROP FUNCTION public.delivery_notes_request_guard();
DROP INDEX public.delivery_notes_org_request_uniq;
ALTER TABLE public.delivery_notes DROP COLUMN request_hash;
ALTER TABLE public.delivery_notes DROP COLUMN request_id;
COMMIT;
