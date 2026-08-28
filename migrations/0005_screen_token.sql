-- Screen-role authorization for real lab rooms. openLabSession mints a
-- random token per open; the leader's shared screen presents it as a
-- query parameter on the WebSocket upgrade, and SessionDO validates it
-- before granting the screen role (leader actions). NULL = room opened
-- before this migration or an ad-hoc session: the DO treats NULL as
-- "no token required" only for non-"lab-" keys, so real rooms opened
-- before deploying this always re-open (minting a token) first.
ALTER TABLE lab_session ADD COLUMN screen_token TEXT;
