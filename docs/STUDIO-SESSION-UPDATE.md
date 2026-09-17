# Studio session update

This document supersedes the initial session-encryption setup paragraph in STUDIO.md. New sessions no longer require MOLT_SESSION_SECRET or any extra hosting setup.

The browser receives only a cryptographically random 384-bit opaque session identifier in an HttpOnly, Secure, SameSite=Strict cookie. The corresponding GitHub credential is held in private server-side Netlify Blobs storage under a hash of that identifier, never returned by the API, never put in source code, and never written to browser storage. These session records require the same strict backend access controls as any server-side credential store.

Sessions expire after eight hours. Expired records are removed when accessed; logout deletes the server record. Each login receives a separate key, so concurrent logins do not rely on last-write-wins global secret initialization. Legacy encrypted cookies can be read only when their preexisting deployment secret is configured, but all new logins use opaque server-side sessions.

Session readiness performs an actual private storage read. Storage errors do not return ready. The production and deploy-preview data stores remain separate. API model keys continue to be stored as encrypted GitHub Actions Secrets, not session records.

This change removes the deployment environment-variable dependency found during real Netlify verification. It does not bypass GitHub authentication, create test users, or supply model credentials. The owner still connects GitHub and enters an authorized API key inside Connections.
