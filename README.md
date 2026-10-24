# Garmin Vercel OAuth wrapper

A Node.js/Vercel MCP proxy that preserves the upstream Garmin Personal API MCP tools and adds three Garmin Connect web-session tools:

- `get_vo2_max`
- `get_cycling_ftp`
- `get_training_status`

It also exposes `garmin_connect_login` and `garmin_connect_verify_mfa`. Personal API access and Garmin Connect access are separate authentication systems. This wrapper keeps the Personal API MCP upstream and uses a separate Garmin Connect session for the metrics that are not available through the Personal API.

> **Safety rule:** Set up and validate Preview first. Do not enable Production storage variables or deploy to Production until the Preview checklist passes and you explicitly decide to proceed.

## Architecture at a glance

```text
MCP client
  -> https://<wrapper-host>/<URL_SECRET>/mcp
  -> this wrapper (checks URL_SECRET)
       -> local Garmin Connect tools (Redis-backed encrypted session)
       -> all other MCP calls -> UPSTREAM_URL with Authorization: Bearer MCP_BEARER_TOKEN
```

The wrapper is a Node.js function, not an Edge function. The secret path is checked on every request. The wrapper adds the upstream bearer token server-side; do not put that token into your MCP client configuration.

## One-time setup

You need two Vercel projects/deployments:

1. The existing **garmin-personal-mcp** service, which provides the Garmin Personal API tools at `/mcp`.
2. This **garmin-vercel-oauth-wrapper** service, which adds the Garmin Connect metrics and forwards the other tools.

### 1. Configure the upstream Personal API MCP

In the Personal API project's Vercel settings, set the following for **Preview first**:

| Variable | Value |
|---|---|
| `GARMIN_PERSONAL_API_KEY` | Your Garmin Personal API key. Keep it private. |
| `MCP_BEARER_TOKEN` | A long random secret used to protect the upstream MCP endpoint. |

Use the same `MCP_BEARER_TOKEN` value in the wrapper project. It must match exactly. Do not send it to the MCP client. Redeploy the upstream Preview after changing environment variables.

The upstream endpoint should be the full MCP endpoint, normally `https://<personal-api-preview-host>/mcp`.

### 2. Create persistent storage through Vercel

In the wrapper project, open **Storage** or **Marketplace** in the Vercel dashboard and provision the native **Upstash Redis** integration. Follow Vercel's current UI to connect it to this project. The integration may inject either set of REST variables below; the code supports both:

| Preferred variable | Compatible Vercel KV variable |
|---|---|
| `UPSTASH_REDIS_REST_URL` | `KV_REST_API_URL` |
| `UPSTASH_REDIS_REST_TOKEN` | `KV_REST_API_TOKEN` |

Both a REST URL and its matching REST token are required. `REDIS_URL`, `KV_URL`, or a read-only token alone are **not** substitutes for the REST URL/token pair used by this code.

Enable the storage variables for **Preview only** while testing. If Vercel offers environment selection, do not enable Production yet.

### 3. Configure the wrapper environment variables

In the wrapper project's **Settings → Environment Variables**, add the following to **Preview**. Use the same values for all Preview deployments of this project.

| Variable | What it is / where it comes from |
|---|---|
| `URL_SECRET` | A long random secret used as the URL path. Generate one with a password manager or a cryptographically secure random generator. Do not reuse the upstream bearer token. |
| `UPSTREAM_URL` | The upstream Personal API MCP Preview URL, including `/mcp`. |
| `MCP_BEARER_TOKEN` | The exact same value as the upstream Personal API project's `MCP_BEARER_TOKEN`. |
| `GARMIN_CONNECT_EMAIL` | Your Garmin Connect account email. |
| `GARMIN_CONNECT_PASSWORD` | Your Garmin Connect password. |
| `GARMIN_SESSION_ENCRYPTION_KEY` | A private random secret of at least 32 characters. Keep it stable; changing it makes existing encrypted Redis sessions unreadable. |
| `UPSTASH_REDIS_REST_URL` or `KV_REST_API_URL` | REST URL from the Vercel-managed Redis integration. |
| `UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_TOKEN` | Matching write-capable REST token from the integration. |

Never commit or paste these values into source code, chat, MCP tool arguments, or the README. The login tool takes no credentials as arguments; it reads the email/password from private environment variables.

**Important:** Vercel environment variables are attached to a deployment at build/deploy time. After changing them, redeploy the relevant Preview deployment and confirm that the deployment uses the intended commit. Do not assume an already-running deployment has picked up new values.

### 4. Deploy and construct the MCP endpoint

Deploy the wrapper branch to a **Preview** deployment. The existing `vercel.json` rewrite maps:

```text
https://<wrapper-host>/<URL_SECRET>/mcp
    -> /api/mcp?s=<URL_SECRET>
```

Use the exact Preview hostname assigned by Vercel and your configured `URL_SECRET`. Treat the full endpoint URL as a secret: anyone who obtains it can reach the proxy. Do not add the upstream `MCP_BEARER_TOKEN` to the client; the wrapper injects it when forwarding upstream requests.

## How Garmin Connect login and MFA work

The wrapper's MCP tools provide a two-step flow:

1. Call `garmin_connect_login`. The server reads `GARMIN_CONNECT_EMAIL` and `GARMIN_CONNECT_PASSWORD` from Vercel's private environment variables.
2. If Garmin accepts the login without MFA, the result is `authenticated`; no code is needed.
3. If Garmin requests MFA, the result is `mfa_required`. The assistant/client should ask you for the one-time code Garmin sent you, then call `garmin_connect_verify_mfa` with that code.
4. After verification, call the metric tools normally.

**MFA prompting is conversational, not a native MCP popup.** The server reports that a code is required and provides a verification tool; the AI assistant using the MCP must ask you for the code and call that tool. If a client does not follow tool descriptions, you may need to ask it to complete the MFA step explicitly.

The one-time code is passed only to the verification tool and is not written to Redis by this wrapper. The pending MFA state is sensitive, encrypted before storage, and expires after 10 minutes. It is deleted after successful verification. If it expires, call `garmin_connect_login` again.

## What is persisted, and how it is protected

- Garmin OAuth tokens are stored in Redis as an AES-256-GCM encrypted JSON envelope.
- Pending MFA state is encrypted the same way and expires in Redis after 600 seconds.
- The encryption key is derived from `GARMIN_SESSION_ENCRYPTION_KEY`; keep that key stable and private.
- Preview and Production use different Redis key prefixes, so their sessions do not overlap.
- The Garmin password is read from environment variables only when logging in; it is not stored in Redis.
- Token refresh is handled by `garminconnect-js` and saved through the token-store interface.
- A Garmin session can still expire or be revoked. If the metric tool reports that no valid session exists, run the login/MFA flow again.

The Redis key is currently scoped per Vercel environment, not per individual user. This design is for your own single-account deployment; do not use it as a multi-user hosted service.

## Preview verification checklist

Run all of these against Preview before considering Production:

- [ ] The deployment is on the expected latest commit and reports **Ready**.
- [ ] `tools/list` succeeds and includes the upstream Personal API tools.
- [ ] The three metric tools appear exactly once.
- [ ] Call a harmless upstream Personal API tool to verify forwarding and bearer-token injection.
- [ ] Call `garmin_connect_login`; complete MFA if requested.
- [ ] Verify `get_vo2_max`, `get_cycling_ftp`, and `get_training_status` return plausible Garmin Connect data.
- [ ] Test a single `date` query and a short `from_date`/`to_date` range.
- [ ] Trigger a fresh **Preview** deployment and call a metric without logging in again. This checks that tokens survive across deployments.
- [ ] Review Vercel logs for storage/configuration errors. Never copy secrets or token payloads into issue comments.

Do not run these tests against Production during setup.

## Metric tool inputs

All three metric tools accept one of these forms:

- No arguments: latest available value/history (search windows are tool-specific).
- `{"date":"YYYY-MM-DD"}`: one calendar date.
- `{"from_date":"YYYY-MM-DD","to_date":"YYYY-MM-DD"}`: inclusive date range, maximum 366 days.

Do not combine `date` with a range. Both range endpoints are required, dates must be real calendar dates, and the start must not be after the end.

## Maintenance notes for future you

### If you change environment variables

1. Edit the variable in the correct Vercel project and environment (Preview vs Production).
2. Redeploy that environment; existing deployments do not gain new values retroactively.
3. Confirm the deployment commit and status before testing.
4. Never change `GARMIN_SESSION_ENCRYPTION_KEY` casually. If it must be rotated, expect to sign in to Garmin Connect again after the new deployment; old stored sessions cannot be decrypted with the new key.

### If login/MFA stops working

1. Check that the deployment has the correct Preview environment variables, without exposing their values.
2. Check that both Redis REST URL and matching write-capable REST token are configured.
3. Check that `GARMIN_SESSION_ENCRYPTION_KEY` exists, is at least 32 characters, and has not changed since the session was saved.
4. Call `garmin_connect_login` again. If MFA is requested, complete it within 10 minutes.
5. If Garmin rejects the login or revokes the session, resolve the Garmin account issue first; a redeploy alone does not refresh credentials.

### If a metric call says there is no saved session

Call `garmin_connect_login` and, if needed, `garmin_connect_verify_mfa`. Do not clear Redis or rotate the encryption key as the first troubleshooting step.

### If Redis reports a storage/configuration error

Confirm the Vercel Marketplace integration is connected to the **wrapper** project and enabled for the environment of the deployment you are testing. Check the supported REST variable pair and redeploy. Do not use a read-only token for writes.

### Production setup (only after Preview is fully verified)

Production requires its own correct values for `URL_SECRET`, `UPSTREAM_URL`, `MCP_BEARER_TOKEN`, Garmin credentials, `GARMIN_SESSION_ENCRYPTION_KEY`, and Redis REST variables. The upstream bearer token must match the upstream project's Production token. Keep Preview and Production secrets separate where appropriate. Enable Production storage variables and deploy only after you have deliberately approved that change.

## Troubleshooting quick reference

| Symptom | Likely cause / next step |
|---|---|
| `Proxy is not configured` | One of `URL_SECRET`, `UPSTREAM_URL`, or `MCP_BEARER_TOKEN` is missing in that deployment environment. |
| HTTP 404 / `Not found` | The URL path does not contain the correct `URL_SECRET`, or the URL path is malformed. |
| Upstream 401/403 | Wrapper and upstream `MCP_BEARER_TOKEN` values do not match, or the upstream credential is invalid. |
| Storage not configured | Redis REST URL/token or `GARMIN_SESSION_ENCRYPTION_KEY` is missing; verify Preview scope and redeploy. |
| No pending MFA login | The challenge expired after 10 minutes or was already consumed; start login again. |
| Stored session cannot be decrypted | `GARMIN_SESSION_ENCRYPTION_KEY` changed, or stored data is corrupt. Sign in again after confirming the intended key. |
| Metric returns no data | Garmin may have no value for that date/range. Try latest or a wider valid range. |

## Security and deployment policy

- Keep credentials, Redis tokens, encryption keys, and the full secret-path endpoint private.
- Do not log raw Garmin tokens, MFA state, or passwords.
- Test in Preview first; keep Production untouched until the Preview checklist passes.
- This wrapper does not replace Garmin's official Personal API access or change its terms.
