# Run HRs Portal locally on Windows, macOS, or Linux

This setup runs the Node API, PostgreSQL, local resume storage, and Career Copilot on your computer. It does not send resumes to a paid AI service.

## Windows prerequisites

1. Install [Node.js 22 LTS](https://nodejs.org/) (the installer adds Node and npm to PowerShell).
2. Install PostgreSQL for Windows and create a local database named `hrs_portal_dev`.
3. Optional: install [Ollama for Windows](https://ollama.com/download/windows) only if you want the local Career Copilot features.
4. From PowerShell, open the real project folder — not `__MACOSX`:

```powershell
cd "C:\Users\Asus\Desktop\Projects\hr care\hr care"
npm --prefix backend install
npm run start:local
```

The app opens at [http://localhost:4173](http://localhost:4173). Press `Ctrl+C` in the same PowerShell window to stop it. The local launcher now uses Node for the web server, so Python is not required on Windows.

## Start on any supported operating system

The local `.env` file is already configured for the available PostgreSQL and Ollama services on this computer. Install the backend packages once, start PostgreSQL and Ollama if they are not already running, then run:

```sh
npm --prefix backend install
npm run start:local
```

Open [http://localhost:4173](http://localhost:4173). Use the normal candidate registration flow. In local mode, registration displays a verification link on screen because no email provider is configured. Upload a PDF or DOCX resume to the candidate profile before opening Career Copilot. The local demo needs a verified company and published listing to return job matches; public job posting stays restricted to approved company/recruiter access.

The local database is `hrs_portal_dev`. Resume files are stored under `.hrs-local/resumes/`, which is private and excluded from Git and the Netlify source archive. Stop the local services with Ctrl+C.

## Netlify deployment

The Netlify build creates `netlify-dist/` and points browser requests at the same-origin Node function. Netlify still needs production database, private object storage, email, and AI provider environment variables as documented in [NETLIFY_SETUP.md](NETLIFY_SETUP.md). The local Ollama endpoint and local resume folder are only for this computer; a hosted Netlify site cannot reach them. Keep real production secrets out of the source archive.
