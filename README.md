# Garmin Vercel OAuth wrapper

A secret-path MCP proxy that preserves the existing Personal API bearer-token bridge and adds three Garmin Connect performance metrics tools:

- `get_vo2_max`
- `get_cycling_ftp`
- `get_training_status`

The metrics use the unofficial Garmin Connect web-session client, separate from the upstream Garmin Personal API. Other MCP requests are forwarded to `UPSTREAM_URL`.

## Vercel environment variables

- `URL_SECRET`: long random secret used in the public URL path.
- `UPSTREAM_URL`: upstream Personal API MCP endpoint, e.g. `https://your-personal-mcp.vercel.app/mcp`.
- `MCP_BEARER_TOKEN`: same bearer token configured on the upstream MCP service.
- `GARMIN_CONNECT_EMAIL`: Garmin Connect account email.
- `GARMIN_CONNECT_PASSWORD`: Garmin Connect password.
- `GARMIN_SESSION_ENCRYPTION_KEY`: a long random secret (at least 32 characters) used to encrypt Garmin tokens and pending MFA state before storage.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: supplied by the native Upstash Redis integration provisioned from the Vercel Marketplace.

Keep every variable private; never put credentials in tool arguments or client configuration. Do not commit the encryption key, Redis token, Garmin credentials, or stored session data.

The public endpoint remains `https://<wrapper>/<URL_SECRET>/mcp`. The existing rewrite maps it to the proxy handler.

## Garmin Connect login

Call `garmin_connect_login`. If Garmin requires MFA, call `garmin_connect_verify_mfa` with the one-time code. Then call the metric tools.

**Persistent session storage:** Garmin OAuth tokens and pending MFA state are encrypted with AES-256-GCM and stored in Redis through Vercel's native Upstash Marketplace integration. Pending MFA challenges expire after 10 minutes. The storage keys are separated between Preview and Production environments. Garmin passwords are not stored in Redis; they are read from private Vercel environment variables only when login is needed.

**Vercel setup (Preview first):**
1. In the Vercel project, open **Storage** / **Marketplace** and add the native **Upstash Redis** integration. Provision it from the Vercel dashboard; the native integration can be managed and billed through Vercel without creating a separate provider account.
2. Enable the injected `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` variables for **Preview only** while testing. Do not enable Production for this test.
3. Add `GARMIN_SESSION_ENCRYPTION_KEY` as a private Preview environment variable. Generate a long random secret (at least 32 characters) and keep it stable; changing it makes previously stored sessions unreadable.
4. Redeploy the Preview deployment so it receives the storage variables, then test login, MFA, metric calls across separate requests, and a fresh Preview deployment.

The stored tokens are reused and refreshed automatically when possible. Garmin can still require a new login/MFA if its session is revoked or expires.

Metric tools support latest values by default, `date` for one day, or inclusive `from_date` and `to_date` ranges up to 366 days. The Personal API tools continue to be handled by the upstream service.

## Do not deploy to production until verified

Test on a preview deployment first. Confirm the upstream MCP tools still appear, the three metric tools appear exactly once, non-metric calls still forward, login/MFA works in the same warm instance, and the metric responses match Garmin Connect.
