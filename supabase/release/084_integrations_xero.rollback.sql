-- 084 rollback: ONLY with Rhys's approval. Drops what 084 added: the enqueue trigger on invoices and credit notes, 084's functions and its
-- six tables. What they held goes with them: the connection to Xero (and its encrypted tokens), the mappings, the contact matches and the
-- send log. Their history stays in the activity trail (every change to the connection, mappings, contacts and send log was audited; the
-- tokens never were). Nothing in Xero is changed: disconnect in Admin > Integrations first (or remove the connection in Xero) so no
-- token is left valid there. Invoices, credit notes and imports are untouched; issuing works exactly as before 084. Run the whole text as
-- one transaction, then the release preflight (084 shows "not applied").
BEGIN;
DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.invoices;
DROP TRIGGER IF EXISTS zz_integration_enqueue ON public.credit_notes;
DROP FUNCTION IF EXISTS public.integration_overview(TEXT);
DROP FUNCTION IF EXISTS public.integration_resolve_contact(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_contact_record(UUID, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_retry_send(UUID);
DROP FUNCTION IF EXISTS public.integration_set_mapping(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_record_result(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.integration_claim_next(UUID, TEXT, INTEGER, TEXT, UUID);
DROP FUNCTION IF EXISTS public.integration_token_release(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.integration_token_store(UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.integration_token_lease(UUID, TEXT, UUID, INTEGER);
DROP FUNCTION IF EXISTS public.integration_mark_needs_reconnect(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_disconnect(TEXT);
DROP FUNCTION IF EXISTS public.integration_store_connection(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.integration_oauth_consume(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_oauth_begin(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_enqueue();
DROP FUNCTION IF EXISTS public.integration_unmapped(UUID, TEXT);
DROP FUNCTION IF EXISTS public.integration_document(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.integration_carriage_vat_key(BOOLEAN, BOOLEAN, NUMERIC);
DROP FUNCTION IF EXISTS public.integration_vat_key(BOOLEAN, BOOLEAN, NUMERIC);
DROP TABLE IF EXISTS public.integration_sends;
DROP TABLE IF EXISTS public.integration_contacts;
DROP TABLE IF EXISTS public.integration_mappings;
DROP TABLE IF EXISTS public.integration_oauth_states;
DROP TABLE IF EXISTS public.integration_secrets;
DROP TABLE IF EXISTS public.integration_connections;
COMMIT;
