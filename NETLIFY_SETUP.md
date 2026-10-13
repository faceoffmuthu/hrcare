# HRs Portal on Netlify

This repository is prepared to deploy the static portal and its Node.js/Express API as a Netlify Function. Deploy the repository through Netlify's Git import so the function is built and published; a static drag-and-drop upload of `dist/` does not deploy the API.

## Deploy the code

1. Push this repository to GitHub, GitLab, or Bitbucket.
2. In Netlify, choose **Add new project → Import an existing project** and select the repository.
3. Keep the build settings from `netlify.toml`. It builds the function, publishes the portal, and rewrites `/api/*` to the function.
4. Create the PostgreSQL database and private S3-compatible bucket described below. Add the environment variables in **Project configuration → Environment variables**. Never commit secret values.
5. Set `APP_ORIGIN` to the exact primary HTTPS hostname Netlify assigned to the site, then trigger a new deploy. If you later attach a custom domain, set `APP_ORIGIN` to that hostname and redeploy.
6. Run the database migration once against the production database:

   ```sh
   cd backend
   DATABASE_URL='your-postgres-connection-string' DATABASE_SSL=true npm run db:migrate
   ```

7. Open `https://YOUR_NETLIFY_HOST/api/health`. A successful response is `{"status":"ok","service":"hrs-portal-api"}`.
8. Register and verify the owner's account. Assign Super Admin access from the repository root:

   ```sh
   cd backend
   DATABASE_URL='your-postgres-connection-string' DATABASE_SSL=true npm run admin:bootstrap -- owner@example.com
   ```

   The account uses its own password and must enroll an authenticator at first admin sign-in. This command does not create or print a password.

## Required Netlify environment variables

Set these for production functions. Use Netlify's protected environment-variable UI, not `netlify.toml`, and make sure the variables are available to the Functions scope.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production`. |
| `APP_ORIGIN` | Exact HTTPS hostname used by visitors. |
| `DATABASE_URL` | PostgreSQL connection string. |
| `DATABASE_SSL` | Set to `true` for managed PostgreSQL with TLS. |
| `SESSION_SECRET` | Random secret with at least 32 characters. |
| `EMAIL_FROM` | Verified sender address, for example `HRs Portal <no-reply@your-domain.com>`. |
| `RESEND_API_KEY` | Email delivery key; required unless SMTP is configured. |
| `S3_BUCKET` | Private bucket for candidate resumes. |
| `S3_REGION` | S3 region; use the value from the storage provider. |
| `S3_ENDPOINT` | S3-compatible endpoint, if the provider requires one. |
| `S3_ACCESS_KEY_ID` | Private bucket access key. |
| `S3_SECRET_ACCESS_KEY` | Private bucket secret. |

Optional variables: `PG_POOL_MAX=2`, `S3_PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `AI_API_KEY`, `AI_MODEL`, and `AI_BASE_URL`. Google and LinkedIn buttons remain disabled until their OAuth applications are configured. OAuth callback URLs are `https://YOUR_NETLIFY_HOST/api/oauth/google/callback` and `https://YOUR_NETLIFY_HOST/api/oauth/linkedin/callback`.

## Career Copilot

Career Copilot is a separate candidate-only chat workspace. Candidates can ask questions about a private uploaded PDF or DOCX resume, find verified published jobs ranked against their profile, tailor an editable draft to one job, and apply from the chat. Candidates enter expected annual CTC in LPA; the Copilot filters jobs whose listed maximum is below that preference. It does not apply to external job boards. Every AI run requires the candidate's explicit consent, and every application requires a second, per-job confirmation. Resume sharing with the employer is a separate unchecked choice. The generated resume is stored only with the application when the candidate chooses to submit; the platform does not retain raw extracted resume text from an AI analysis. Chat history stays in the browser session and is not persisted by the platform.

AI is disabled by default. To enable it, set `AI_API_KEY` and `AI_MODEL` in Netlify's protected environment variables. `AI_BASE_URL` defaults to `https://api.openai.com/v1/chat/completions` and can point to another OpenAI-compatible chat completions endpoint. Provider usage may incur charges under that provider's terms. Do not set these variables until the site owner has selected a provider and reviewed its privacy and billing terms. Without the key, resume analysis returns a clear disabled message and does not send resume text outside the application. Scanned-image PDFs and legacy `.doc` files are not parsed; use a text-based PDF or DOCX.

After adding these columns/routes, run the normal one-time database migration before using the Copilot. The existing `candidate_profiles` and `job_applications` columns are updated idempotently by `db:migrate`.

Netlify hosts the site and API function; this application still needs a PostgreSQL database, private resume storage, and an email provider. Choose free tiers if available and monitor their quotas. A Netlify deploy alone does not provision these services or create user accounts.

## Local preview

For a complete no-cost local run with PostgreSQL, Ollama, and private disk resume storage, follow [LOCAL_SETUP.md](LOCAL_SETUP.md). Opening `dist/index.html` directly with `file://` only previews the interface; use `http://localhost:4173` with the local services for sign-in and Career Copilot. Netlify's build creates a separate `netlify-dist/` copy that points to its same-origin `/api` function.
