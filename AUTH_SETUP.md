# HRs Portal Node.js backend

Authentication, account data, the Super Admin API, MFA, and private resume operations now live in `backend/`, a Node.js 22 + Express service backed by PostgreSQL. The browser calls only the API; database credentials, OAuth secrets, email credentials, and S3 credentials stay on the server.

## Zero-cost pilot deployment

The Render Blueprint provisions only a Free Node web service. It does not create a Render database or any paid services. Use free-tier Neon Postgres and a private S3-compatible Neon Object Storage bucket for durable database and resume data. Set a strict $0 spend limit or do not add a payment method to the provider accounts.

1. Create a Neon Free project and a **private** bucket. Neon currently includes 1 GB of Postgres storage and 5 GB of object storage per project on its Free plan.
2. Create a Render Blueprint from the repository root using `render.yaml`. It creates a Free web service rooted at `backend` and asks you to provide `DATABASE_URL`, the Neon bucket's S3 endpoint/access keys, and a Resend API key as secrets.
3. Set `APP_ORIGIN` to `https://hrs-portal.lemony-badge-5690.chatgpt.site`, use the Neon connection string for `DATABASE_URL`, and keep `DATABASE_SSL=true`.
4. Use Resend's free email API (HTTPS) rather than SMTP, because Render Free blocks outbound SMTP ports. Add `RESEND_API_KEY` and `EMAIL_FROM`. To send verification and reset email to all users, the sender domain must be one you control and have verified in Resend. Resend Free currently includes 3,000 emails/month with a 100/day limit.
5. Enter the Neon Object Storage S3 endpoint, region, bucket name, access key, and secret key in Render's environment settings. Keep the bucket private.
6. Google and LinkedIn login remain disabled until you create OAuth apps and add their client IDs/secrets. Use callbacks `https://<render-api-host>/api/oauth/google/callback` and `https://<render-api-host>/api/oauth/linkedin/callback`.
7. The service runs the idempotent database migration at startup. After deployment, check `/api/health`, then set `dist/auth-config.js`'s `apiUrl` to the API origin and publish the Site.
8. Register and verify the owner's account. Run `npm run admin:bootstrap -- owner@example.com` locally with `DATABASE_URL` pointing to Neon to assign Super Admin to that verified account. There is no shared or hard-coded password; the account uses its own password and must enroll an authenticator.

This is a prototype setup, not a production guarantee: Render Free sleeps after 15 minutes without traffic and may take about a minute to wake; its free outbound/network limits can also suspend a service. Neon and Resend have free quotas. Do not store real candidate resumes until the owner has confirmed the privacy, retention, backup, and quota requirements for the free providers.

The API uses secure, HTTP-only session cookies, email verification, scrypt password hashes, optional Google/LinkedIn OIDC with PKCE, encrypted TOTP secrets for Super Admin access, role-gated account management, an append-only admin audit log, and short-lived signed resume URLs. Recruiters start pending and can hire only after approval and verified company membership. Public registration cannot select an admin role.

## Local development

```sh
cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

Set local PostgreSQL and SMTP/S3 credentials in `.env` before exercising account creation and resume uploads. Configure `APP_ORIGIN` to the address serving `dist/`, and set `dist/auth-config.js`'s `apiUrl` to `http://localhost:3000`.

## Existing data and launch state

The Node database schema is a clean target schema. No Supabase project credentials or database export are present in this workspace, so existing users, records, and files have not been copied. Do not point the Site at the new API until required records are migrated and validated. Existing password hashes are not reusable by the new login; migrated users should complete a password reset. Resume objects must be copied into the configured private bucket and their keys updated before enabling account access.

The Free Render service, Neon project/bucket, and Resend account still need to be provisioned and connected. Provider credentials and a verified email-sending domain are not in this workspace. Until those steps are complete, `apiUrl` remains blank so the current Site does not send authentication traffic to a missing service.
