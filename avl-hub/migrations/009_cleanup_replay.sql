-- Round-2 review: replay rows for credential-bearing routes could be stored when the URL's letter case differed (e.g. /API/users).
-- Remove any that exist. (LIKE is case-insensitive for ASCII.) The code no longer stores them.
DELETE FROM idempotency WHERE path LIKE '/api/auth%' OR path LIKE '/api/users%' OR path LIKE '/api/roles%' OR path LIKE '/api/admin%';
