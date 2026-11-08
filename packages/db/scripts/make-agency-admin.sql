-- Make an existing user the Owner (sees and edits every workspace, manages the whole "Who can sign in" list). Normally the Owner is
-- named on the sign-in list (a rule with role 'owner') or in ACCESS_ADMIN_EMAILS and the flag is set at sign-in; use this only to
-- set it by hand. An Owner needs no membership: the flag passes every policy.
--
-- The user must have signed in once so they exist in auth.users. Replace the email, run it with psql, then have the user sign out
-- and back in so their session picks up the new app_metadata.

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"agency_admin": true}'::jsonb
where email = 'you@example.com';
