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

Keep every variable private; never put credentials in tool arguments or client configuration.

The public endpoint remains `https://<wrapper>/<URL_SECRET>/mcp`. The existing rewrite maps it to the proxy handler.

## Garmin Connect login

Call `garmin_connect_login`. If Garmin requires MFA, call `garmin_connect_verify_mfa` with the one-time code. Then call the metric tools.

**Session limitation:** Garmin Connect tokens and pending MFA state are held only in process memory. Vercel serverless instances can be recycled or route requests to different instances, so login/MFA/session continuity is not guaranteed. This implementation deliberately does not persist Garmin credentials, tokens, or MFA state to a database, KV store, or disk. For reliable multi-request MFA/session continuity, a persistent encrypted session store or a single long-lived server would be required.

Metric tools support latest values by default, `date` for one day, or inclusive `from_date` and `to_date` ranges up to 366 days. The Personal API tools continue to be handled by the upstream service.

## Do not deploy to production until verified

Test on a preview deployment first. Confirm the upstream MCP tools still appear, the three metric tools appear exactly once, non-metric calls still forward, login/MFA works in the same warm instance, and the metric responses match Garmin Connect.
