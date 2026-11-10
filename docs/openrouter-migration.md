# OpenRouter document autofill migration

The active document app now sends intake text through Apps Script to
`https://openrouter.ai/api/v1/chat/completions`, using `openrouter/free`. Provider
prompt, completion, request and image price caps are all zero. JSON support is
required. Client payloads cannot override the model, routing, prompt or key.
No paid fallback or automatic retry loop is configured.

PDF/text uploads and pastes use the same extraction schema and job-field mapping
as before. AI-extracted fields are marked OpenRouter for review. Existing field
validation, authentication, document-only context and failure handling are retained.
The older workspace snapshot under `docaoppp/` is not the active app and is unchanged.

## Activation

1. In the existing Apps Script project's **Project Settings > Script Properties**,
   set `OPENROUTER_API_KEY` to your OpenRouter key. The old DeepSeek property is no
   longer read. Never put the key in frontend source or a `VITE_` variable.
2. Update `Code.gs` from `src/apps-script/Code.gs` (or the generated
   `PASTE-INTO-APPS-SCRIPT.txt`). Keep `appsscript.json` and existing properties.
3. Publish a new version of the existing web-app deployment, preserving its URL
   and access settings. Rebuild/deploy the frontend to update extraction labels.
4. Upload a test document while signed in and review the populated form.

The ignored `.env.openrouter.local` file is for the local `npm run ai:check`
command only. It is not sent to GitHub or deployed to Apps Script.

## Validation on November 10, 2026

- Production build passed.
- Active app and root scripts passed TypeScript checking with the bundled older
  `docaoppp/` project excluded in a temporary check config; committed tsconfig unchanged.
- All 13 customer-reference/backend tests passed, including free-only routing,
  malicious client overrides, input bounds and safe API errors.
- Intake parser and current draft-backend checks passed.
- All six browser intake tests passed, including PDF/text uploads and delayed
  success/failure while editing or clearing a job. Browser API responses were stubbed.
- A separate live request through the actual backend request/response code and
  client mapping extracted eight fields from fictional document text, preserved
  manually entered instructions and reported `$0` cost. No real customer data was sent.
- Paste payload and chunks were regenerated and verified byte-identical to Code.gs.

Existing repository-wide failures remain: `npm run lint` includes an older nested
project whose `@pdf-lib/fontkit` dependency is absent from the root install;
`apps:test` and `apps:register` call superseded backend helpers; one of the 24
database tests asserts an outdated deployment-error message (the other 23 pass).
The files responsible for these failures are unchanged by this migration.

Live Apps Script was not updated: local Google CLI authentication is not configured.
Source publication to GitHub does not activate the deployed backend.
