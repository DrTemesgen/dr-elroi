# Dr. Elroi — setup & reproduction

This repo contains only the Africa Digital Health Academy product layer. The third-party stack
(Medplum, PostgreSQL, Redis, the AI models) is installed/cloned separately. These steps rebuild a
working machine from a fresh clone.

## 1. Prerequisites (install locally)

- **Node.js 24.16.0** (the project was built/tested against it).
- **PostgreSQL 15+** — create a `medplum` database and `medplum` user.
- **Redis** (or **Memurai** on Windows) — copy `config-examples/dr-elroi.conf.example` to
  `Memurai/dr-elroi.conf` and set a real `requirepass`.
- **Ollama** + the MedGemma model: `ollama pull alibayram/medgemma:4b`.
- **Kokoro TTS** — create the Python venv under `Kokoro/` and download its model files
  (`kokoro-v1.0.onnx`, `voices-v1.0.bin`).

## 2. Medplum (the EMR engine)

The Medplum monorepo is **not vendored** in this repo. Clone it from upstream and apply the
Dr. Elroi customizations:

```
git clone https://github.com/medplum/medplum.git
```

Then re-apply the local edits (branding, MedGemma wiring, the EMR app port, intake/Spaces UI).
The touched files are:

- `packages/app/` — `vite.config.ts` (dev server **port 3002**), `src/SignInPage.tsx`, `src/App.tsx`,
  `src/index.tsx`, `index.html`, `src/DrElroiLogo.tsx` (branding).
- `examples/medplum-provider/` — the doctor-facing clinic app (port 3001): `App.tsx`, `SignInPage.tsx`,
  intake form pages/utils, `DrElroiLogo.tsx`, `ChatInput.tsx`.
- `packages/server/src/fhir/operations/ai.ts` — MedGemma wiring.
- `packages/server/medplum.config.json` — copy from `config-examples/medplum.config.example.json`
  and fill in real DB / Redis / reCAPTCHA values. **`appBaseUrl` must be `http://localhost:3002/`.**
- `examples/medplum-demo-bots/src/spaces-bots/fhir-summary-bot.ts` — Spaces summary bot.

> Tip: capture these as patches once stabilised (`git -C medplum diff > patches/<area>.patch`),
> **excluding** any secret-bearing files (`medplum.config.json`, `test.config.json`,
> `docker-compose.full-stack.yml`, `values-local.yaml`).

## 3. Secrets

Copy `connector/.env.example` → `connector/.env` and fill in:

- `MEDPLUM_CLIENT_ID` / `MEDPLUM_CLIENT_SECRET` — create a ClientApplication in the Medplum admin UI.
- `ELROI_PROJECT_ID` — your normal (non-super-admin) Medplum project.
- `ELROI_EMAIL` / `ELROI_PASSWORD` — an admin login used by the seed/loader scripts.

`connector/.env` is git-ignored. Never commit real secrets.

## 4. Run

```
./Start-DrElroi.ps1
```

Brings the stack up in order (database → cache → AI → EMR API → EMR app → clinic → connector):

- Chat (Dr. Elroi): http://localhost:3300
- EMR (records/admin + patient portal): http://localhost:3002
- Clinic (doctors): http://localhost:3001

Stop everything with `./Stop-DrElroi.ps1` (stops only Dr. Elroi's ports — it will not touch other
apps you run on this machine).

## 5. Seed data (optional)

With the stack running and `connector/.env` filled in:

- `python connector/load-icd10cm.py` — load the ICD-10-CM code system.
- `python connector/deploy-spaces-bots.py` — deploy the Spaces AI bots.
- `python connector/seed-africa-care-templates.py` / `seed-us-care-templates.py` — care templates.
- `python seed-sample-data.py` — a few sample patients (synthetic).
