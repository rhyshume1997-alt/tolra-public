-- 075 rollback: ONLY with Rhys's approval, and only while no clock action has been checked and no refused action reported (both are
-- records about pay: once either exists, forward-fix instead). Run the whole text as one transaction, then
-- `notify pgrst, 'reload schema';` and the release preflight (075 shows "not applied"). 050's attendance_events_immutable() stays (050's).
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.attendance_event_networks) OR EXISTS (SELECT 1 FROM public.time_sync_rejections) THEN
    RAISE EXCEPTION '075 holds clock checks or refused-action reports: do not roll back; forward-fix instead';
  END IF;
END $$;
DROP TRIGGER IF EXISTS zz_attendance_events_network ON public.attendance_events;
DROP FUNCTION IF EXISTS public.resolve_time_sync_rejection(uuid, text);
DROP FUNCTION IF EXISTS public.report_time_sync_rejection(uuid, text, text, timestamptz, text, text, text, text);
DROP FUNCTION IF EXISTS public.time_sync_rejection_answer(public.time_sync_rejections, boolean);
DROP FUNCTION IF EXISTS public.my_request_network();
DROP FUNCTION IF EXISTS public.set_member_on_site_only(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.remove_site_network(uuid, uuid);
DROP FUNCTION IF EXISTS public.add_site_network(uuid, text, text);
DROP FUNCTION IF EXISTS public.set_site_network_check(uuid, text);
DROP FUNCTION IF EXISTS public.site_network_replay(uuid, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.site_network_admin_org();
DROP FUNCTION IF EXISTS public.attendance_events_network();
DROP FUNCTION IF EXISTS public.site_network_matches(uuid, inet);
DROP FUNCTION IF EXISTS public.request_client_ip();
DROP FUNCTION IF EXISTS public.site_network_parse(text);
DROP FUNCTION IF EXISTS public.site_network_private(inet);
DROP FUNCTION IF EXISTS public.site_network_host(text);
DROP TABLE IF EXISTS public.attendance_event_networks;
DROP TABLE IF EXISTS public.time_sync_rejections;
DROP TABLE IF EXISTS public.site_network_ops;
DROP TABLE IF EXISTS public.site_network_members;
DROP TABLE IF EXISTS public.site_networks;
DROP TABLE IF EXISTS public.site_network_settings;
COMMIT;
