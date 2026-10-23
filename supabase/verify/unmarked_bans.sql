-- READ ONLY (platform owner). Logins that are banned from signing in without the app's deactivation marker.
-- Reactivating such a person in a company no longer lifts the ban
-- automatically. Bans the app set before the marker existed look the same as platform bans: review each row and,
-- if it was an ordinary deactivation, lift it in Authentication > Users (or mark it so a reactivation lifts it).
SELECT u.id, u.email, u.banned_until,
       (SELECT count(*) FROM public.organization_members m WHERE m.user_id = u.id AND m.active) AS active_memberships
FROM auth.users u
WHERE u.banned_until > now()
  AND coalesce(u.raw_app_meta_data ->> 'deactivation_ban', '') <> 'true'
ORDER BY u.email;
