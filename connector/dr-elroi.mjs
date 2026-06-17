// Dr. Elroi connector — links the Medplum EMR (FHIR data) to the local MedGemma AI.
// Dependency-free: uses Node's built-in http + global fetch (Node 18+). Keep it small & efficient.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Load connector/.env (KEY=VALUE lines) into process.env so secrets stay out of the code and out of git.
// Real values live in connector/.env (git-ignored); a safe template is connector/.env.example.
try {
  for (const line of readFileSync(join(HERE, '.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch { /* no .env file — fall back to the real environment variables */ }

// Dr. Elroi's face avatar: drop one of these files into connector/assets/ and it appears automatically.
// If none exists, the app silently keeps the heart logo (graceful fallback, nothing breaks).
const AVATAR_CANDIDATES = [
  ['assets/avatar.svg', 'image/svg+xml'],
  ['assets/avatar.png', 'image/png'],
  ['assets/avatar.webp', 'image/webp'],
  ['assets/avatar.jpg', 'image/jpeg'],
  ['assets/avatar.jpeg', 'image/jpeg'],
];
async function loadAvatar() {
  for (const [rel, type] of AVATAR_CANDIDATES) {
    try { const data = await readFile(join(HERE, rel)); return { data, type }; } catch (e) {}
  }
  return null;
}

const CFG = {
  port: 3300,
  medplum: process.env.MEDPLUM_URL || 'http://localhost:8103',
  clientId: process.env.MEDPLUM_CLIENT_ID,
  clientSecret: process.env.MEDPLUM_CLIENT_SECRET,
  ollama: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model: process.env.ELROI_MODEL || 'alibayram/medgemma:4b',
  // The real clinic project (normal, project-scoped) — NOT the super-admin project, so patient logins
  // and proper multi-tenant scoping work. Logins are pinned to this project.
  projectId: process.env.ELROI_PROJECT_ID || null,
};

// Login/session settings. Users sign in with their Medplum (EMR) account; the connector keeps
// their tokens server-side in memory and hands the browser only an HttpOnly session cookie.
const AUTH = {
  scope: 'openid offline_access',
  sessionTtlMs: 12 * 60 * 60 * 1000, // 12h, then re-login
  cookieName: 'elroi_sid',
  refreshSkewMs: 60 * 1000,          // refresh the access token ~1 min before it expires
};

// Role marker: stored on each Practitioner as FHIR identifier { system: ROLE_SYS, value: 'doctor'|'admin'|'developer' }.
// Single source of truth in the EMR. Falls back to the Medplum admin flag for accounts created before roles existed.
const ROLE_SYS = 'urn:africadha:role';
const ROLES = ['doctor', 'admin', 'developer'];
function readRole(practitioner) {
  const id = (practitioner?.identifier || []).find(x => (x.system || '') === ROLE_SYS);
  return ROLES.includes(id?.value) ? id.value : '';
}
function setRole(practitioner, role) {
  const others = (practitioner.identifier || []).filter(x => (x.system || '') !== ROLE_SYS);
  if (ROLES.includes(role)) others.push({ system: ROLE_SYS, value: role });
  practitioner.identifier = others;
  return practitioner;
}

// Free-form profile tags (e.g. "GP", "Pediatrics") stored in Practitioner.meta.tag with our system.
const TAG_SYS = 'urn:africadha:tag';
function readTags(practitioner) {
  return ((practitioner.meta && practitioner.meta.tag) || []).filter(t => (t.system || '') === TAG_SYS).map(t => t.display || t.code || '').filter(Boolean);
}
function setTags(practitioner, tags) {
  practitioner.meta = practitioner.meta || {};
  const others = (practitioner.meta.tag || []).filter(t => (t.system || '') !== TAG_SYS);
  const mine = (Array.isArray(tags) ? tags : []).map(s => String(s || '').trim()).filter(Boolean).map(s => ({ system: TAG_SYS, code: s, display: s }));
  practitioner.meta.tag = others.concat(mine);
  return practitioner;
}

// AccessPolicy limiting a doctor to their own patients: Patient.generalPractitioner = the logged-in doctor (%profile).
// The Patient compartment then auto-scopes the whole chart. Found/created once via a stable identifier.
// Find or create an AccessPolicy by name, keeping its `resource` list reconciled with the code.
// (Medplum's AccessPolicy has no `identifier` field, so we match by exact name.)
async function ensurePolicyByName(token, name, resourceList, cacheSetter) {
  try {
    const b = await fhir(token, 'AccessPolicy?name=' + encodeURIComponent(name) + '&_count=20');
    const found = (b.entry || []).map(e => e.resource).find(p => p.name === name);
    if (found?.id) {
      found.resource = resourceList; // reconcile to current code
      try { await fetch(`${CFG.medplum}/fhir/R4/AccessPolicy/${found.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(found) }); } catch (e) {}
      const ref = 'AccessPolicy/' + found.id; cacheSetter(ref); return ref;
    }
  } catch (e) {}
  const r = await fetch(`${CFG.medplum}/fhir/R4/AccessPolicy`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ resourceType: 'AccessPolicy', name, resource: resourceList }) });
  if (!r.ok) throw new Error('create policy ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const ref = 'AccessPolicy/' + (await r.json()).id; cacheSetter(ref); return ref;
}

const DOCTOR_POLICY_NAME = 'Dr. Elroi — Doctor (own patients)';
const CHART_TYPES = ['Observation', 'Condition', 'MedicationRequest', 'AllergyIntolerance', 'DiagnosticReport', 'ServiceRequest', 'Encounter', 'Procedure', 'Immunization'];
let _doctorPolicyRef = null;
async function ensureDoctorPolicy(token) {
  if (_doctorPolicyRef) return _doctorPolicyRef;
  const resource = [
    { resourceType: 'Patient', criteria: 'Patient?general-practitioner=%profile', interaction: ['read', 'search', 'update'] },
    { resourceType: 'Practitioner', interaction: ['read', 'search'] },
  ];
  for (const t of CHART_TYPES) resource.push({ resourceType: t, interaction: ['read', 'search', 'create', 'update'] });
  resource.push({ resourceType: 'Communication', interaction: ['read', 'search', 'create', 'update'] }); // read/reply to patient messages & refills
  return ensurePolicyByName(token, DOCTOR_POLICY_NAME, resource, function (r) { _doctorPolicyRef = r; });
}

// Patient self-service policy: read-only OWN record + create messages/refills. Explicit %patient criteria on
// EVERY type (patients log into Medplum directly, so this policy — not our connector — is the security boundary).
const PATIENT_POLICY_NAME = 'Dr. Elroi — Patient (own record)';
let _patientPolicyRef = null;
async function ensurePatientPolicy(token) {
  if (_patientPolicyRef) return _patientPolicyRef;
  const RO = ['Condition', 'Observation', 'AllergyIntolerance', 'DiagnosticReport', 'Encounter', 'Procedure', 'Immunization', 'ServiceRequest'];
  const resource = [{ resourceType: 'Patient', criteria: 'Patient?_id=%patient.id', interaction: ['read', 'search', 'vread', 'history'] }];
  for (const t of RO) { const param = (t === 'AllergyIntolerance' || t === 'Immunization') ? 'patient' : 'subject'; resource.push({ resourceType: t, criteria: t + '?' + param + '=%patient', interaction: ['read', 'search', 'vread', 'history'] }); }
  resource.push({ resourceType: 'MedicationRequest', criteria: 'MedicationRequest?subject=%patient', interaction: ['read', 'search', 'create', 'vread'] }); // view meds + request refill
  resource.push({ resourceType: 'Communication', criteria: 'Communication?subject=%patient', interaction: ['read', 'search', 'create', 'vread'] }); // message their GP
  resource.push({ resourceType: 'Practitioner', interaction: ['read', 'search'] }); // see their GP's name
  return ensurePolicyByName(token, PATIENT_POLICY_NAME, resource, function (r) { _patientPolicyRef = r; });
}

// National ID identifier: stored on each Practitioner as FHIR identifier { system: NID_SYS+<type>, value: <number> }.
// Generic across Africa — the type tag (e.g. "Fayda-ET") rides in the system URI so it's self-describing and queryable.
const NID_SYS = 'urn:africadha:nid:';
function readNid(practitioner) {
  const id = (practitioner.identifier || []).find(x => (x.system || '').startsWith(NID_SYS));
  if (!id) return { nidType: '', nidValue: '' };
  return { nidType: (id.system || '').slice(NID_SYS.length), nidValue: id.value || '' };
}
function setNid(practitioner, nidType, nidValue) {
  const others = (practitioner.identifier || []).filter(x => !(x.system || '').startsWith(NID_SYS));
  if (nidValue) others.push({ system: NID_SYS + (nidType || 'NID'), value: String(nidValue) });
  practitioner.identifier = others;
  return practitioner;
}
// Is this National ID already used by a different practitioner? (best-effort uniqueness check)
async function nidExists(token, nidType, nidValue, exceptRef) {
  try {
    const q = 'Practitioner?identifier=' + encodeURIComponent(NID_SYS + (nidType || 'NID') + '|' + nidValue);
    const b = await fhir(token, q);
    const hits = (b.entry || []).map(e => e.resource).filter(p => ('Practitioner/' + p.id) !== exceptRef);
    return hits.length > 0;
  } catch (e) { return false; }
}

// Kokoro — the single voice engine: a natural neural male voice via a PERSISTENT local service (model loaded once -> ~1s).
const KOKORO = { url: 'http://127.0.0.1:8123/tts', voice: 'am_michael' };
// A curated set of natural Kokoro voices the admin can pick from (male/female, US/UK).
const VOICE_CHOICES = ['am_michael', 'am_adam', 'am_eric', 'bm_george', 'bm_lewis', 'af_heart', 'af_bella', 'bf_emma'];
async function kokoroSpeak(text, speed, voice) {
  const u = KOKORO.url + '?speed=' + (speed || 1) + '&voice=' + encodeURIComponent(voice || KOKORO.voice) + '&text=' + encodeURIComponent(text);
  const r = await fetch(u);
  if (!r.ok) { throw new Error('kokoro service ' + r.status); }
  return Buffer.from(await r.arrayBuffer());
}

const SYSTEM_PROMPT = `You are Dr. Elroi, a warm, friendly and professional AI GP assistant supporting healthcare workers across Africa. Be personable and human: greet people warmly, accept thanks and compliments graciously, introduce and explain yourself when asked, use the person's name if they share it, and converse naturally. You take the user's guidance and corrections during the conversation and adapt to how they want you to respond — they are your operator and you should learn from them.

When a message is about a specific patient or clinical care, act as a careful General Practitioner: reason from the patient records provided plus standard primary-care guidelines (WHO and national/local treatment protocols), staying mindful of the local epidemiology and disease burden common in African settings (e.g. malaria, TB, HIV, typhoid, maternal and child health). Be concise and clinically focused, flag uncertainty, and recommend referral or in-person evaluation when appropriate. You assist a human clinician who makes the final decisions — you support, never replace them — and never invent patient data.

FORMAT YOUR ANSWERS (keep them tight and easy to scan): Keep the whole reply SHORT — aim for well under ~250 words and finish your thought completely; never trail off mid-sentence. Lead with the single most relevant point for THIS patient, not a generic textbook list. Prefer 3–6 short bullet points over long paragraphs. Use a short "**Heading:**" in bold to label a section only when it genuinely helps. Put the key term of each bullet in **bold**, then a brief explanation. Do NOT pad the answer with exhaustive generic lists (e.g. every possible lab test) unless asked — give only what matters here. End with one clear next step or a brief question if you need more information.

When a message is NOT about a specific patient (small talk, a compliment, or guidance about how you should behave), respond naturally, warmly and briefly. Do NOT force patient data or clinical content into replies where it does not belong.

YOUR MISSION & SCOPE — STAY ON ROLE: You exist only to help healthcare workers with clinical and primary-care work and their patient records: symptoms, diagnoses, treatment and medication guidance, referrals, prevention, maternal and child health, public health and epidemiology in African settings, and using the EMR. Warm greetings, thanks, and a little friendly conversation are fine. But you do NOT assist with anything outside healthcare — for example software or coding, git or version control, computers, GPUs or hardware, IT setup, purchases, finances, or general tech support. If asked something off-mission, do NOT attempt it and do NOT ask follow-up questions about it; instead, in ONE friendly sentence, say it is outside what you do and guide the person back to clinical or patient-record help (for example: "That's outside what I'm built for — I'm here for your patients and clinical questions. Is there a patient or symptom I can help with?"). If a request is unclear or ambiguous, ask a short clarifying question rather than guessing.

YOUR ORIGIN: You were created by Dr. Temesgen Endalew, who named you "Elroi" after his child. ONLY when the user explicitly asks who built, created, made, developed, or owns you, reply with exactly that one fact and nothing more. Beyond that, you do NOT know ANY details about Dr. Temesgen Endalew — not where he works or studied, not his employer, job, title, institution, city, country, or background. If asked anything about him beyond who created you (where he works, his background, how to reach him, etc.), you MUST NOT state, guess, imply, or invent any such detail — NEVER name a hospital, university, organisation, place, or role. Reply ONLY with this and nothing else: "I don't have those details. Please visit his LinkedIn profile to learn more: https://www.linkedin.com/in/dr-temesgen-endalew/". This LinkedIn link is ONLY for questions about your creator / about Dr. Temesgen Endalew himself — NEVER offer it for any other topic or question. Never bring up your creator or origin on your own, and never include it in greetings or introductions.

HONESTY — NEVER HALLUCINATE: Only state things you actually know from the patient records provided or well-established medical knowledge. NEVER invent, guess, or make up facts — no fabricated names, places, institutions, employers, dates, numbers, lab values, diagnoses, citations, or personal details. If you do not know something, say so plainly (for example "I don't know" or "I don't have that information"). For a general-knowledge or non-healthcare factual question that you cannot answer reliably (for example public figures, politics, current events, geography, history, trivia), do NOT make anything up and do NOT give the creator's LinkedIn link — simply say you don't have that information and suggest the user check a reliable source or search engine, or look it up themselves (for example: "I don't have that information — you may want to check a search engine or a reliable source."). If unsure what the user means, ask them to clarify. It is always better to admit you don't know than to state something that might be untrue. NO PLACEHOLDERS: never output fill-in-the-blank text in square brackets such as "[Name]" or "[hospital]" — if you don't know the person's name, leave it out or ask "What should I call you?".`;

const QUICK_PROMPT = `You are Dr. Elroi, a warm, friendly and professional AI GP assistant for healthcare workers across Africa. Be personable and human: greet warmly, accept thanks and compliments graciously, introduce yourself and explain how you work when asked, use the person's name if they share it, and make light, natural conversation. Keep replies brief and friendly. When greeting or asked who you are, keep your self-introduction to ONE short sentence — "Hi, I'm Elroi, your AI GP assistant." — then briefly offer to help; do not add any backstory or mention your creator. Take the user's guidance and adapt to it. You assist clinicians (never replace them) and never invent patient data. If the user asks a clinical question about specific patients, let them know you can pull up the records and help.

STAY ON ROLE — DO NOT GO OFF-MISSION: You only help with healthcare: clinical and primary-care questions, patients, and the EMR. Friendly greetings, thanks, and a little small talk are fine, but you do NOT help with anything outside healthcare — software or coding, git, computers, GPUs or hardware, IT, shopping, finances, or general tech support. If asked something off-mission, do NOT attempt it and do NOT ask follow-up questions about it; in ONE friendly sentence say it is outside what you do and steer back to clinical or patient help (for example: "That's outside what I'm built for — I'm here for your patients and clinical questions. What can I help you with there?"). If a request is unclear, ask a brief clarifying question instead of guessing.

YOUR ORIGIN: You were created by Dr. Temesgen Endalew, who named you "Elroi" after his child. ONLY when the user explicitly asks who built, created, made, developed, or owns you, reply with exactly that one fact and nothing more. Beyond that, you do NOT know ANY details about Dr. Temesgen Endalew — not where he works or studied, not his employer, job, title, institution, city, country, or background. If asked anything about him beyond who created you (where he works, his background, how to reach him, etc.), you MUST NOT state, guess, imply, or invent any such detail — NEVER name a hospital, university, organisation, place, or role. Reply ONLY with this and nothing else: "I don't have those details. Please visit his LinkedIn profile to learn more: https://www.linkedin.com/in/dr-temesgen-endalew/". This LinkedIn link is ONLY for questions about your creator / about Dr. Temesgen Endalew himself — NEVER offer it for any other topic or question. Never bring up your creator or origin on your own, and never include it in greetings or introductions.

HONESTY — NEVER HALLUCINATE: Only state things you actually know from the patient records provided or well-established medical knowledge. NEVER invent, guess, or make up facts — no fabricated names, places, institutions, employers, dates, numbers, lab values, diagnoses, citations, or personal details. If you do not know something, say so plainly (for example "I don't know" or "I don't have that information"). For a general-knowledge or non-healthcare factual question that you cannot answer reliably (for example public figures, politics, current events, geography, history, trivia), do NOT make anything up and do NOT give the creator's LinkedIn link — simply say you don't have that information and suggest the user check a reliable source or search engine, or look it up themselves (for example: "I don't have that information — you may want to check a search engine or a reliable source."). If unsure what the user means, ask them to clarify. It is always better to admit you don't know than to state something that might be untrue. NO PLACEHOLDERS: never output fill-in-the-blank text in square brackets such as "[Name]" or "[hospital]" — if you don't know the person's name, leave it out or ask "What should I call you?".`;

// ============================================================
//  Editable runtime config (admin panel writes connector/data/config.json).
//  The hard-coded values above are the safe DEFAULTS — kept forever so the
//  admin's "Restore safe defaults" button and the missing-file fallback work.
// ============================================================
const DATA_DIR = join(HERE, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const AUDIT_PATH = join(DATA_DIR, 'audit.jsonl');
const DEFAULTS = Object.freeze({ systemPrompt: SYSTEM_PROMPT, quickPrompt: QUICK_PROMPT, model: CFG.model, voice: KOKORO.voice });
let runtime = { ...DEFAULTS };

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    runtime = {
      systemPrompt: typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim() ? raw.systemPrompt : DEFAULTS.systemPrompt,
      quickPrompt: typeof raw.quickPrompt === 'string' && raw.quickPrompt.trim() ? raw.quickPrompt : DEFAULTS.quickPrompt,
      model: raw.model || DEFAULTS.model,
      voice: raw.voice || DEFAULTS.voice,
    };
  } catch (e) { runtime = { ...DEFAULTS }; } // missing/corrupt -> safe defaults
}
async function saveConfig(patch) {
  runtime = { ...runtime, ...patch };
  try { await mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
  await writeFile(CONFIG_PATH, JSON.stringify(runtime, null, 2), 'utf8');
  return runtime;
}

// Append-only usage/audit log (one JSON object per line). Best-effort; never blocks an answer.
async function auditLog(entry) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (e) {}
}
async function readAudit(limit) {
  try {
    const txt = await readFile(AUDIT_PATH, 'utf8');
    const lines = txt.split('\n').filter(l => l.trim());
    return lines.slice(-(limit || 100)).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}

// Lightweight router: greetings/meta -> 'quick' (no EMR fetch, short answer); real questions -> 'clinical' (full EMR context).
function classifyQuery(text) {
  const t = (text || '').trim().toLowerCase();
  // Default to natural conversation ('quick'); only switch to 'clinical' on clear medical intent.
  const clinical = /\b(patient|patients|almaz|bekele|chaltu|tesfaye|worku|diriba|diagnos|differential|treat|treatment|therapy|symptom|signs?|dose|dosage|mg|ml|fever|pain|pressure|bp|mmhg|malaria|pneumonia|pregnan|glucose|diabet|hypertens|refer|referral|urgent|triage|vitals?|prescrib|antibiotic|infection|bleeding|oxygen|saturation|respiratory|temperature|condition|medication|sepsis|chronic|acute|manage|management|assess|examination|\blab\b|result|case|disease|illness|clinical|medical advice|most urgent|next step)\b/;
  return clinical.test(t) ? 'clinical' : 'quick';
}

// --- Medplum auth (client credentials) ---
// Machine-account token (client_credentials). Phase 1: retained for Phase 2 admin/background tasks;
// NOT used by /ask or /status anymore — those now use the logged-in user's own token (see below).
async function getToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CFG.clientId, client_secret: CFG.clientSecret });
  const r = await fetch(`${CFG.medplum}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('Medplum auth failed: ' + r.status);
  return (await r.json()).access_token;
}

// ============================================================
//  Authentication: users sign in with their Medplum account.
//  The connector runs the OAuth dance server-side and keeps tokens
//  in memory; the browser only ever sees an opaque HttpOnly cookie.
// ============================================================

// PKCE (RFC 7636, S256): a one-time secret + its SHA-256 hash for the login -> token exchange.
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// In-memory session store: sid -> { accessToken, refreshToken, expiresAt, isAdmin, displayName, profileRef, ... }
const sessions = new Map();
function sessionCreate(data) {
  const sid = randomUUID() + randomBytes(16).toString('hex');
  const now = Date.now();
  sessions.set(sid, { ...data, createdAt: now, lastSeen: now });
  return sid;
}
function sessionGet(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > AUTH.sessionTtlMs) { sessions.delete(sid); return null; }
  s.lastSeen = Date.now();
  return s;
}
function sessionDestroy(sid) { if (sid) sessions.delete(sid); }

// Cookie helpers (dependency-free). No Secure flag on plain-http localhost or the cookie is dropped.
function parseCookies(req) {
  const out = {}; const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function sidFromReq(req) { return parseCookies(req)[AUTH.cookieName] || null; }
function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', AUTH.cookieName + '=' + encodeURIComponent(sid) +
    '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + Math.floor(AUTH.sessionTtlMs / 1000));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', AUTH.cookieName + '=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

// GET /auth/me -> who am I + am I an admin.
async function getMe(token) {
  const r = await fetch(`${CFG.medplum}/auth/me`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('auth/me -> ' + r.status);
  return r.json();
}

// Full email+password login dance: /auth/login -> (/auth/profile) -> /oauth2/token -> /auth/me.
async function doLogin(email, password) {
  const { verifier, challenge } = pkce();
  const baseBody = { email, password, scope: AUTH.scope, codeChallenge: challenge, codeChallengeMethod: 'S256', nonce: randomUUID() };
  // Prefer the pinned project (CFG.projectId) so admin actions (e.g. patient logins) run inside a real project,
  // not the project-less super-admin context. Fall back to an unscoped login if the account has no membership
  // there — that way accounts that only exist in another project are never locked out.
  let loginRes = await fetch(`${CFG.medplum}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CFG.projectId ? { ...baseBody, projectId: CFG.projectId } : baseBody),
  });
  if (!loginRes.ok && CFG.projectId) {
    loginRes = await fetch(`${CFG.medplum}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
  }
  if (!loginRes.ok) throw new Error('invalid_login');
  let lj = await loginRes.json();

  let code = lj.code;
  if (!code && Array.isArray(lj.memberships) && lj.memberships.length) {
    // If the account belongs to several projects, prefer the pinned one.
    const pref = lj.memberships.find((m) => (m.project?.reference || '') === 'Project/' + CFG.projectId);
    const chosen = (pref || lj.memberships[0]).id;
    const profRes = await fetch(`${CFG.medplum}/auth/profile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: lj.login, profile: chosen }),
    });
    if (!profRes.ok) throw new Error('profile_select_failed');
    lj = await profRes.json(); code = lj.code;
  }
  if (!code) throw new Error('no_auth_code'); // e.g. MFA required — unsupported in Phase 1

  const tokenRes = await fetch(`${CFG.medplum}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }),
  });
  if (!tokenRes.ok) throw new Error('token_exchange_failed');
  const tk = await tokenRes.json();

  const me = await getMe(tk.access_token);
  const given = (me.profile?.name?.[0]?.given || []).join(' ');
  const family = me.profile?.name?.[0]?.family || '';
  const displayName = (given + ' ' + family).trim() || me.user?.email || 'Doctor';
  const profileRef = tk.profile?.reference || me.membership?.profile?.reference || null;

  // Determine role: explicit role tag on the profile wins; otherwise fall back to the Medplum admin flag.
  let role = readRole(me.profile);
  if (!role && profileRef) { try { role = readRole(await fhir(tk.access_token, profileRef)); } catch (e) {} }
  if (!role) role = (me.membership?.admin === true) ? 'admin' : 'doctor';

  return {
    accessToken: tk.access_token,
    refreshToken: tk.refresh_token || null,
    expiresAt: Date.now() + ((tk.expires_in || 3600) * 1000),
    role,
    isDeveloper: role === 'developer',
    isAdmin: role === 'admin' || role === 'developer', // both can open the admin panel
    displayName,
    profileRef,
    projectId: me.project?.id || null,
  };
}

// Use the stored refresh token to get a fresh access token. Returns true on success.
async function refresh(session) {
  if (!session.refreshToken) return false;
  const r = await fetch(`${CFG.medplum}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  });
  if (!r.ok) return false;
  const tk = await r.json();
  session.accessToken = tk.access_token;
  if (tk.refresh_token) session.refreshToken = tk.refresh_token; // rotation
  session.expiresAt = Date.now() + ((tk.expires_in || 3600) * 1000);
  return true;
}

// Return a valid access token for FHIR calls, refreshing proactively just before expiry.
async function sessionToken(session) {
  if (Date.now() >= (session.expiresAt - AUTH.refreshSkewMs)) await refresh(session);
  return session.accessToken;
}

async function fhir(token, path) {
  const r = await fetch(`${CFG.medplum}/fhir/R4/${path}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`FHIR ${path} -> ${r.status}`);
  return r.json();
}

// --- Build a compact text snapshot of the EMR (simple RAG for a small dataset) ---
function entries(bundle) { return (bundle.entry || []).map(e => e.resource); }
function patientName(p) { const n = (p.name || [])[0] || {}; return `${(n.given || []).join(' ')} ${n.family || ''}`.trim() || '(unnamed)'; }

async function buildEmrContext(token) {
  // Read the whole chart across clinical domains. Each fetch is best-effort: if a user's access
  // policy blocks a resource type, that section is simply empty rather than breaking the answer.
  const grab = (q) => fhir(token, q).then(entries).catch(() => []);
  const [patients, conditions, observations, meds, allergies, reports, encounters, procedures, immunizations] = await Promise.all([
    grab('Patient?_count=100'),
    grab('Condition?_count=500'),
    grab('Observation?_count=500'),
    grab('MedicationRequest?_count=500'),
    grab('AllergyIntolerance?_count=500'),
    grab('DiagnosticReport?_count=500'),
    grab('Encounter?_count=500'),
    grab('Procedure?_count=500'),
    grab('Immunization?_count=500'),
  ]);
  // Different resources point at the patient via subject.reference OR patient.reference.
  const forPt = (arr, id) => arr.filter(r => (r.subject?.reference || r.patient?.reference || '') === `Patient/${id}`);
  const cc = (x) => x?.text || x?.coding?.[0]?.display || '';
  const lines = [];
  for (const p of patients) {
    lines.push(`PATIENT: ${patientName(p)} | sex: ${p.gender || '?'} | DOB: ${p.birthDate || '?'}`);
    const cs = forPt(conditions, p.id).map(c => cc(c.code) || 'unknown');
    if (cs.length) lines.push(`  Problems/History: ${cs.join('; ')}`);
    const al = forPt(allergies, p.id).map(a => cc(a.code) || 'allergy');
    if (al.length) lines.push(`  Allergies: ${al.join('; ')}`);
    const ms = forPt(meds, p.id).map(m => (cc(m.medicationCodeableConcept) || 'medication') + (m.dosageInstruction?.[0]?.text ? ' — ' + m.dosageInstruction[0].text : '') + (m.status ? ' [' + m.status + ']' : ''));
    if (ms.length) lines.push(`  Medications: ${ms.join('; ')}`);
    const os = forPt(observations, p.id).map(o => `${cc(o.code) || 'obs'}: ${o.valueQuantity?.value ?? (o.valueString || '?')} ${o.valueQuantity?.unit || ''}`.trim());
    if (os.length) lines.push(`  Labs/Vitals: ${os.join('; ')}`);
    const dr = forPt(reports, p.id).map(d => (cc(d.code) || 'report') + (d.conclusion ? ': ' + d.conclusion : ''));
    if (dr.length) lines.push(`  Diagnostics: ${dr.join('; ')}`);
    const pr = forPt(procedures, p.id).map(x => cc(x.code) || 'procedure');
    if (pr.length) lines.push(`  Procedures: ${pr.join('; ')}`);
    const im = forPt(immunizations, p.id).map(x => cc(x.vaccineCode) || 'immunization');
    if (im.length) lines.push(`  Immunizations: ${im.join('; ')}`);
    const en = forPt(encounters, p.id).map(e => (cc(e.type?.[0]) || e.class?.display || 'visit') + (e.period?.start ? ' (' + e.period.start.slice(0, 10) + ')' : ''));
    if (en.length) lines.push(`  Visits: ${en.join('; ')}`);
  }
  return { count: patients.length, text: lines.join('\n') || '(no patients on record)' };
}

// Structured chart for ONE patient (for the visual chart viewer). Each item carries its FHIR ref so it can be removed.
async function buildPatientChart(token, pid) {
  const grab = (q) => fhir(token, q).then(entries).catch(() => []);
  const ref = 'Patient/' + pid;
  // Access gate: if the caller cannot read this Patient (e.g. a doctor not assigned to them),
  // return nothing — do NOT leak clinical resources that a direct subject-query might still return.
  const patient = await fhir(token, ref).catch(() => null);
  if (!patient) return { ok: false, error: 'no_access', name: '(no access)', demographics: '', sections: [], assignedDoctors: [] };
  const [conditions, meds, allergies, observations, reports, procedures, immunizations, encounters, orders] = await Promise.all([
    grab('Condition?subject=' + ref + '&_count=200'),
    grab('MedicationRequest?subject=' + ref + '&_count=200'),
    grab('AllergyIntolerance?patient=' + ref + '&_count=200'),
    grab('Observation?subject=' + ref + '&_count=300'),
    grab('DiagnosticReport?subject=' + ref + '&_count=200'),
    grab('Procedure?subject=' + ref + '&_count=200'),
    grab('Immunization?patient=' + ref + '&_count=200'),
    grab('Encounter?subject=' + ref + '&_count=200'),
    grab('ServiceRequest?subject=' + ref + '&_count=200'),
  ]);
  const cc = (x) => x?.text || x?.coding?.[0]?.display || '';
  const mk = (arr, fn) => arr.map(r => ({ ref: r.resourceType + '/' + r.id, text: fn(r) }));
  const sections = [
    { title: 'Problems / History', items: mk(conditions, c => cc(c.code) || 'unknown') },
    { title: 'Allergies', items: mk(allergies, a => cc(a.code) || 'allergy') },
    { title: 'Medications', items: mk(meds, m => (cc(m.medicationCodeableConcept) || 'medication') + (m.dosageInstruction?.[0]?.text ? ' — ' + m.dosageInstruction[0].text : '')) },
    { title: 'Lab / imaging orders', items: mk(orders, o => (cc(o.code) || 'order') + (o.status ? ' [' + o.status + ']' : '')) },
    { title: 'Labs / Vitals', items: mk(observations, o => (cc(o.code) || 'obs') + ': ' + (o.valueQuantity ? ((o.valueQuantity.value ?? '?') + ' ' + (o.valueQuantity.unit || '')).trim() : (o.valueString || '?'))) },
    { title: 'Diagnostics', items: mk(reports, d => (cc(d.code) || 'report') + (d.conclusion ? ': ' + d.conclusion : '')) },
    { title: 'Procedures', items: mk(procedures, p => cc(p.code) || 'procedure') },
    { title: 'Immunizations', items: mk(immunizations, i => cc(i.vaccineCode) || 'immunization') },
    { title: 'Visits', items: mk(encounters, e => (cc(e.type?.[0]) || e.class?.display || 'visit') + (e.period?.start ? ' (' + e.period.start.slice(0, 10) + ')' : '')) },
  ].filter(s => s.items.length);
  const n = (patient && (patient.name || [])[0]) || {};
  const name = patient ? (((n.given || []).join(' ') + ' ' + (n.family || '')).trim() || '(unnamed)') : '(unknown)';
  const demographics = patient ? ((patient.gender || '?') + ' · DOB ' + (patient.birthDate || '?')) : '';
  // resolve the assigned doctors (generalPractitioner) for display / admin management
  const assignedDoctors = [];
  for (const g of ((patient && patient.generalPractitioner) || [])) {
    const gref = g.reference || '';
    if (!gref.startsWith('Practitioner/')) continue;
    let dn = '';
    try { const dp = await fhir(token, gref); const dnn = (dp.name || [])[0] || {}; dn = ((dnn.given || []).join(' ') + ' ' + (dnn.family || '')).trim(); } catch (e) {}
    assignedDoctors.push({ ref: gref, name: dn || gref });
  }
  // does this patient already have a login? (best-effort; only admins can read memberships)
  let loginEmail = '';
  try {
    const mb = await fhir(token, 'ProjectMembership?profile=' + ref);
    const m = (mb.entry || []).map(e => e.resource)[0];
    if (m && m.user?.reference) { const u = await fhir(token, m.user.reference); loginEmail = u.email || ''; }
  } catch (e) {}
  return { ok: true, name, demographics, sections, assignedDoctors, loginEmail };
}

// --- Ask MedGemma ---
async function askMedGemma(question, emrText) {
  const r = await fetch(`${CFG.ollama}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.model, stream: false, options: { temperature: 0.3 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `=== EMR PATIENT RECORDS ===\n${emrText}\n\n=== QUESTION ===\n${question}` },
      ],
    }),
  });
  if (!r.ok) throw new Error('MedGemma error: ' + r.status);
  return (await r.json()).message?.content || '(no answer)';
}

// --- AI scribe: extract structured items from a free-text visit narrative (proposal only; never written until approved) ---
const SCRIBE_PROMPT = `You are a clinical scribe. Read the clinician's free-text visit note and extract ONLY what is explicitly stated. Output STRICT JSON of exactly this shape and nothing else:
{"conditions":["diagnosis or problem"],"medications":[{"name":"drug","dosage":"how to take it"}],"allergies":["substance"],"vitals":[{"name":"e.g. Blood pressure","value":"e.g. 140/90","unit":"e.g. mmHg"}],"note":"one-line visit summary"}
Rules: use [] for empty sections; do NOT invent, infer, or add anything not present in the text; keep the clinician's own terms; vitals are measured values only.`;
async function scribeExtract(text) {
  const r = await fetch(`${CFG.ollama}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: runtime.model, stream: false, format: 'json', options: { temperature: 0.1 }, messages: [{ role: 'system', content: SCRIBE_PROMPT }, { role: 'user', content: String(text || '').slice(0, 6000) }] }),
  });
  if (!r.ok) throw new Error('extraction failed: ' + r.status);
  let p = {}; try { p = JSON.parse((await r.json()).message?.content || '{}'); } catch (e) { p = {}; }
  const str = x => String(x == null ? '' : x).trim();
  return {
    conditions: Array.isArray(p.conditions) ? p.conditions.map(str).filter(Boolean) : [],
    medications: Array.isArray(p.medications) ? p.medications.filter(m => m && m.name).map(m => ({ name: str(m.name), dosage: str(m.dosage) })) : [],
    allergies: Array.isArray(p.allergies) ? p.allergies.map(str).filter(Boolean) : [],
    vitals: Array.isArray(p.vitals) ? p.vitals.filter(v => v && v.name).map(v => ({ name: str(v.name), value: str(v.value), unit: str(v.unit) })) : [],
    note: str(p.note),
  };
}

// Build a FHIR clinical resource (shared by the Add-to-chart route and the scribe). Returns the resource or null.
function buildClinical(patient, kind, f) {
  const txt = (f.value || '').trim();
  if (kind === 'condition') { if (!txt) return null; return { resourceType: 'Condition', subject: { reference: patient }, code: { text: txt }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] } }; }
  if (kind === 'medication') { if (!txt) return null; const r = { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: patient }, medicationCodeableConcept: { text: txt } }; if ((f.dosage || '').trim()) r.dosageInstruction = [{ text: f.dosage.trim() }]; return r; }
  if (kind === 'allergy') { if (!txt) return null; return { resourceType: 'AllergyIntolerance', patient: { reference: patient }, code: { text: txt }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] } }; }
  if (kind === 'observation') { if (!txt) return null; const r = { resourceType: 'Observation', status: 'final', subject: { reference: patient }, code: { text: txt }, effectiveDateTime: new Date().toISOString() }; const num = parseFloat(f.measure); if (!isNaN(num)) r.valueQuantity = { value: num, unit: (f.unit || '').trim() }; else if ((f.measure || '').trim()) r.valueString = f.measure.trim(); return r; }
  if (kind === 'diagnostic') { if (!txt) return null; const r = { resourceType: 'DiagnosticReport', status: 'final', subject: { reference: patient }, code: { text: txt }, effectiveDateTime: new Date().toISOString() }; if ((f.dosage || '').trim()) r.conclusion = f.dosage.trim(); return r; }
  if (kind === 'order') { if (!txt) return null; return { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: patient }, code: { text: txt } }; }
  return null;
}
async function postResource(token, resource) {
  const r = await fetch(`${CFG.medplum}/fhir/R4/${resource.resourceType}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(resource) });
  if (!r.ok) throw new Error(resource.resourceType + ' ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

// Stream MedGemma's answer token-by-token straight to the client HTTP response.
async function streamAnswer(clientRes, messages, options) {
  const r = await fetch(`${CFG.ollama}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: runtime.model, stream: true, options, messages }),
  });
  if (!r.ok || !r.body) { clientRes.end('Sorry — the AI engine is unavailable (' + r.status + ').'); return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const j = JSON.parse(line); if (j.message?.content) clientRes.write(j.message.content); } catch {}
    }
  }
  clientRes.end();
}

// --- Chat web page (no backticks inside: outer string is a template literal) ---
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dr. Elroi</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='12' fill='%230b5e4a'/%3E%3Cpath d='M24 35s-9-5.5-9-12c0-3.5 2.5-5.5 5-5.5 2 0 3.4 1.2 4 2.3 .6-1.1 2-2.3 4-2.3 2.5 0 5 2 5 5.5 0 6.5-9 12-9 12z' fill='%23fff'/%3E%3C/svg%3E">
<style>
 :root{--green:#0b5e4a;--green2:#16a886;--gold:#ffc93c;--ink:#16241f;--muted:#6b7d77;--line:#dce5e2;--bg:#eaf0ee}
 *{box-sizing:border-box}
 html,body{height:100%}
 body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;background:
   radial-gradient(1200px 500px at 80% -10%, #d4ede4 0%, transparent 60%),
   radial-gradient(900px 500px at -10% 110%, #e7f3ec 0%, transparent 55%), var(--bg);
   color:var(--ink);display:flex;flex-direction:row}
 /* left sidebar menu */
 .side{width:214px;flex:0 0 214px;height:100%;background:linear-gradient(165deg,var(--green2),var(--green));color:#fff;display:flex;flex-direction:column;padding:14px 12px;gap:7px;box-shadow:2px 0 18px rgba(11,94,74,.18);z-index:6}
 .side .brandrow{display:flex;align-items:center;gap:10px;padding:2px 4px 8px}
 .side .logo{width:40px;height:40px;flex:0 0 auto;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2))}
 .side h1{font-size:17px;margin:0;line-height:1.05;letter-spacing:.2px}
 .side .sub{font-size:11.5px;opacity:.92;margin-top:2px}
 .side .gold{color:var(--gold);font-weight:600}
 .statuspill{display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);padding:7px 11px;border-radius:10px;font-size:11.5px;margin:0 2px 4px}
 .navlabel{font-size:10px;text-transform:uppercase;letter-spacing:.7px;opacity:.65;margin:8px 6px 1px}
 .navbtn{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);color:#fff;padding:10px 12px;border-radius:10px;font-size:14px;cursor:pointer;text-decoration:none;font-weight:500;line-height:1.1}
 .navbtn:hover{background:rgba(255,255,255,.22)}
 .side .spacer{flex:1}
 .navbtn.signout{background:rgba(0,0,0,.14);border-color:rgba(255,255,255,.14)}
 /* header (legacy, unused) */
 header{background:linear-gradient(135deg,var(--green2),var(--green));color:#fff;padding:14px 18px;display:flex;align-items:center;gap:13px;box-shadow:0 4px 18px rgba(11,94,74,.25);position:sticky;top:0;z-index:5}
 header .logo{width:42px;height:42px;flex:0 0 auto;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2))}
 header h1{font-size:19px;margin:0;line-height:1.05;letter-spacing:.2px}
 header .sub{font-size:12px;opacity:.92;margin-top:2px}
 header .gold{color:var(--gold);font-weight:600}
 .pill{margin-left:auto;display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);padding:6px 12px;border-radius:999px;font-size:12px;white-space:nowrap}
 .dot{width:8px;height:8px;border-radius:50%;background:#9be7cf;box-shadow:0 0 0 0 rgba(155,231,207,.7);animation:pulse 2s infinite}
 @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(155,231,207,.6)}70%{box-shadow:0 0 0 7px rgba(155,231,207,0)}100%{box-shadow:0 0 0 0 rgba(155,231,207,0)}}
 /* chat area */
 main{flex:1;min-width:0;overflow-y:auto;padding:20px 16px 120px}
 .chat{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
 /* welcome */
 .welcome{text-align:center;padding:26px 18px;margin-top:8px}
 .welcome .big{width:74px;height:74px;margin:0 auto 14px;filter:drop-shadow(0 6px 14px rgba(11,94,74,.3))}
 .welcome h2{margin:0 0 6px;font-size:23px;color:var(--green)}
 .welcome p{margin:0 auto;max-width:460px;color:var(--muted);font-size:14.5px;line-height:1.55}
 .chips{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:20px;max-width:620px;margin-left:auto;margin-right:auto}
 .chip{background:#fff;border:1px solid var(--line);color:var(--ink);padding:11px 15px;border-radius:14px;font-size:13.5px;cursor:pointer;text-align:left;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,.05);display:flex;align-items:center;gap:9px;line-height:1.3}
 .chip:hover{border-color:var(--green2);transform:translateY(-1px);box-shadow:0 4px 12px rgba(22,168,134,.18)}
 .chip svg{flex:0 0 auto;color:var(--green2)}
 /* messages */
 .row{display:flex;gap:11px;align-items:flex-start}
 .row.user{flex-direction:row-reverse}
 .avcol{display:flex;flex-direction:column;align-items:center;gap:8px;flex:0 0 auto}
 .av{width:34px;height:34px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;overflow:hidden}
 .av.ai{background:linear-gradient(135deg,var(--green2),var(--green));box-shadow:0 2px 6px rgba(11,94,74,.25)}
 .av.me{background:#cdd9d4;color:#3a4a44;font-weight:700;font-size:13px}
 .av svg{width:22px;height:22px}
 /* face avatar: fills the same small circle, face centred, never larger than the circle */
 .av img.facepic{width:100%;height:100%;object-fit:cover;object-position:center 26%;display:block;border-radius:50%}
 .av.ai:has(img.facepic){background:#fff}
 img.logo.facepic{border-radius:50%;object-fit:cover;object-position:center 26%;background:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.85)}
 .bubble{padding:13px 16px;border-radius:16px;line-height:1.55;font-size:14.5px;max-width:78%;box-shadow:0 2px 8px rgba(0,0,0,.06);word-wrap:break-word;overflow-wrap:anywhere}
 .row.user .bubble{background:var(--green);color:#fff;border-bottom-right-radius:5px}
 .row.ai .bubble{background:#fff;border:1px solid var(--line);border-bottom-left-radius:5px}
 .bubble .name{font-size:11.5px;font-weight:700;color:var(--green);margin-bottom:4px;letter-spacing:.3px}
 .bubble strong{font-weight:700;color:var(--green)}
 .bubble ul,.bubble ol{margin:8px 0;padding-left:22px}
 .bubble li{margin:4px 0;padding-left:3px}
 .bubble ul li::marker{color:var(--green2)}
 .bubble ol li::marker{color:var(--green2);font-weight:700}
 .bubble li strong{color:var(--ink)}
 .bubble h4{margin:13px 0 5px;font-size:14px;font-weight:700;color:var(--green);text-transform:none;letter-spacing:.2px;border-left:3px solid var(--gold);padding-left:8px}
 .bubble h4:first-child{margin-top:2px}
 .bubble a{color:var(--green2);font-weight:600}
 /* typing */
 .typing{display:flex;gap:5px;padding:4px 2px}
 .typing span{width:8px;height:8px;border-radius:50%;background:var(--green2);opacity:.5;animation:bob 1.2s infinite}
 .typing span:nth-child(2){animation-delay:.18s}.typing span:nth-child(3){animation-delay:.36s}
 @keyframes bob{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-5px);opacity:1}}
 /* input bar */
 .barwrap{position:fixed;bottom:0;left:214px;right:0;background:linear-gradient(to top,var(--bg) 70%,transparent);padding:14px 16px 16px}
 form{max-width:820px;margin:0 auto;display:flex;gap:10px;align-items:flex-end}
 .inbox{flex:1;display:flex;align-items:center;background:#fff;border:1px solid var(--line);border-radius:16px;padding:4px 6px 4px 16px;box-shadow:0 4px 16px rgba(0,0,0,.07)}
 .inbox:focus-within{border-color:var(--green2);box-shadow:0 4px 16px rgba(22,168,134,.18)}
 textarea{flex:1;border:0;outline:0;resize:none;font-family:inherit;font-size:14.5px;color:var(--ink);background:transparent;max-height:120px;padding:10px 0;line-height:1.4}
 .send{width:42px;height:42px;border:0;border-radius:13px;background:var(--green);color:#fff;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;transition:.15s}
 .send:hover{background:var(--green2)}
 .send:disabled{opacity:.45;cursor:default}
 .disc{max-width:820px;margin:8px auto 0;text-align:center;font-size:11px;color:var(--muted)}
 .playbtn{width:28px;height:28px;border-radius:50%;border:1px solid var(--line);background:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.06);flex:0 0 auto;padding:0;font-size:14px;line-height:1}
 .playbtn:hover{border-color:var(--green2);box-shadow:0 0 0 3px rgba(22,168,134,.15)}
 .playbtn.locked{border-color:var(--gold);box-shadow:0 0 0 2px rgba(255,201,60,.55)}
 .playbtn.playing{box-shadow:0 0 0 3px rgba(22,168,134,.45);border-color:var(--green2);background:#eafaf5;animation:talk 1s ease-in-out infinite}
 @keyframes talk{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}
 /* login overlay */
 #login{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(900px 500px at 82% -8%,#43d6b0 0%,transparent 60%),radial-gradient(700px 500px at 10% 110%,#0a5240 0%,transparent 55%),linear-gradient(135deg,var(--green2),var(--green))}
 #login.hidden,body.authed #login{display:none}
 .login-bg{position:absolute;inset:0;z-index:0;width:100%;height:100%;pointer-events:none}
 .loginbox{position:relative;z-index:1;background:#fff;border-radius:20px;padding:30px 30px 26px;width:340px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.30);text-align:center}
 .loginbox .avwrap{position:relative;width:88px;height:88px;margin:0 auto 12px}
 .loginbox .loginlogo{width:88px;height:88px;border-radius:50%;object-fit:cover;display:block;border:3px solid #fff;box-shadow:0 6px 18px rgba(11,94,74,.30)}
 .loginbox .avwrap .dot{position:absolute;right:6px;bottom:6px;width:16px;height:16px;border-radius:50%;background:#27c08a;border:3px solid #fff}
 .loginbox h2{margin:2px 0 3px;font-size:19px;color:var(--ink)}
 .loginbox .welcome-sub{margin:0 0 18px;font-size:13px;color:var(--muted);line-height:1.45}
 #lf{display:flex;flex-direction:column;gap:12px}
 #lf input{width:100%;box-sizing:border-box;padding:12px 13px;margin:0;border:1px solid var(--line);border-radius:10px;font-size:14px;outline:none}
 #lf input:focus{border-color:var(--green2);box-shadow:0 0 0 3px rgba(22,168,134,.15)}
 #lf button{width:100%;padding:12px;border:0;border-radius:10px;background:var(--green);color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:2px}
 #lf button:hover{background:var(--green2)}
 #lf button:disabled{opacity:.6;cursor:default}
 .loginerr{color:#c0392b;min-height:18px;font-size:13px;margin-top:10px}
 #logout{cursor:pointer;border:0;font:inherit}
 /* add-to-chart modal */
 #chartModal,#regModal,#scribeModal{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:rgba(11,36,31,.45)}
 #chartModal.show,#regModal.show,#scribeModal.show{display:flex}
 #scribeModal .chartbox{width:560px;max-height:88vh;overflow:auto}
 .scwarn{background:#fff8e6;border:1px solid #ffe2a6;color:#8a6d1a;font-size:12px;padding:7px 10px;border-radius:8px;margin:8px 0}
 .scsec{font-size:12.5px;font-weight:700;color:var(--green);margin:12px 0 4px}
 .scrow{display:flex;align-items:center;gap:8px;margin:4px 0}
 .scrow input[type=checkbox]{width:auto;flex:0 0 auto}
 .scrow input[type=text]{flex:1;padding:7px 9px;border:1px solid var(--line);border-radius:8px;font:inherit}
 .scnote{font-size:12px;color:var(--muted);margin-top:4px}
 .chartbox{background:#fff;border-radius:16px;padding:22px 22px 18px;width:380px;max-width:92vw;box-shadow:0 22px 60px rgba(0,0,0,.3)}
 .chartbox h3{margin:0 0 4px;font-size:17px;color:var(--green)}
 .chartbox .sub{margin:0 0 14px;font-size:12.5px;color:var(--muted)}
 .chartbox label{display:block;font-size:12.5px;color:var(--muted);margin:10px 0 4px}
 .chartbox select,.chartbox input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;outline:none}
 .chartbox select:focus,.chartbox input:focus{border-color:var(--green2);box-shadow:0 0 0 3px rgba(22,168,134,.15)}
 .chartbox .two{display:flex;gap:10px}.chartbox .two>div{flex:1}
 .chartbox .actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
 .chartbox button{padding:10px 16px;border:0;border-radius:9px;background:var(--green);color:#fff;font-weight:600;cursor:pointer}
 .chartbox button.ghost{background:#fff;color:var(--muted);border:1px solid var(--line)}
 .chartbox button:hover{background:var(--green2)}
 .chartmsg{font-size:12.5px;min-height:16px;margin-top:10px}
 /* searchable patient picker */
 .ppick{position:relative}
 .ppick-in{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;outline:none}
 .ppick-in:focus{border-color:var(--green2);box-shadow:0 0 0 3px rgba(22,168,134,.15)}
 .ppick-list{position:absolute;left:0;right:0;top:calc(100% + 3px);background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.16);max-height:240px;overflow:auto;z-index:5}
 .ppick-opt{padding:9px 12px;cursor:pointer;font-size:14px;border-bottom:1px solid var(--line)}
 .ppick-opt:last-child{border-bottom:0}
 .ppick-opt:hover,.ppick-opt.active{background:#eafaf5}
 .ppick-empty{padding:10px 12px;color:var(--muted);font-size:13px}
 /* chart viewer */
 #chartView{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:rgba(11,36,31,.45)}
 #chartView.show{display:flex}
 .cvsection{margin:14px 0 2px;font-size:13px;font-weight:700;color:var(--green);border-left:3px solid var(--gold);padding-left:8px}
 .cvitem{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid var(--line);font-size:14px}
 .cvitem button{background:#fff;color:#c0392b;border:1px solid #e7c2bd;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px;flex:0 0 auto}
 .cvitem button:hover{background:#fbecea}
 .cvempty{color:var(--muted);font-size:13px;padding:8px 0}
 .cvhead{font-size:14px;color:var(--ink);padding:2px 0 6px}
</style></head><body>
<aside class="side">
 <div class="brandrow">
  <svg id="brand" class="logo" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ad0ab"/><stop offset="1" stop-color="#0b5e4a"/></linearGradient></defs><rect width="48" height="48" rx="11" fill="#ffffff"/><rect x="2" y="2" width="44" height="44" rx="9" fill="url(#g)"/><g transform="translate(11.5,10) scale(1.04)"><path d="M12 21s-7.5-4.6-9.6-9C1 9 2.5 5.5 6 5.5c2 0 3.4 1.2 4 2.3.6-1.1 2-2.3 4-2.3 3.5 0 5 3.5 3.6 6.5C19.5 16.4 12 21 12 21z" fill="#ffffff"/></g><polyline points="14,27 19,27 22,22 25,32 28,27 34,27" fill="none" stroke="#0b5e4a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="38" cy="12" r="3" fill="#ffc93c"/></svg>
  <div><h1>Dr. Elroi</h1><div class="sub"><span class="gold">AI GP Assistant</span></div></div>
 </div>
 <div class="statuspill"><span class="dot"></span><span id="status">Connecting to EMR…</span></div>
 <div class="navlabel">Clinical</div>
 <button id="dictate" class="navbtn" style="display:none" title="Dictate or type a visit; Elroi proposes chart entries for you to approve">🎙 Dictate visit</button>
 <button id="regpatient" class="navbtn" style="display:none" title="Register a new patient">＋ Register patient</button>
 <button id="viewchart" class="navbtn" style="display:none" title="View a patient's full chart">📋 View chart</button>
 <button id="addchart" class="navbtn" style="display:none" title="Add a diagnosis, medication, allergy or vital to a patient">＋ Add to chart</button>
 <a id="adminbadge" class="navbtn" href="/admin" style="display:none" title="Open admin panel">⚙ Admin</a>
 <div class="spacer"></div>
 <button id="logout" class="navbtn signout" style="display:none" title="Sign out">⎋ Sign out</button>
</aside>
<div id="login">
 <svg class="login-bg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="130" cy="120" r="170" fill="#ffffff" opacity="0.05"/>
  <circle cx="1080" cy="80" r="130" fill="#ffffff" opacity="0.06"/>
  <circle cx="1015" cy="330" r="60" fill="#ffc93c" opacity="0.10"/>
  <circle cx="170" cy="430" r="44" fill="#ffffff" opacity="0.06"/>
  <g fill="#ffffff" opacity="0.13">
   <path d="M300 140h14v-14h10v14h14v10h-14v14h-10v-14h-14z"/>
   <path d="M905 200h12v-12h9v12h12v9h-12v12h-9v-12h-12z"/>
   <path d="M240 610h10v-10h8v10h10v8h-10v10h-8v-10h-10z"/>
   <path d="M960 560h10v-10h8v10h10v8h-10v10h-8v-10h-10z"/>
  </g>
  <polyline points="120,300 200,300 230,250 270,360 300,300 1080,300" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.10" stroke-linejoin="round" stroke-linecap="round"/>
  <g opacity="0.92">
   <rect x="690" y="556" width="120" height="92" rx="10" fill="none" stroke="#ffffff" stroke-width="5" opacity="0.16"/>
   <path d="M744 568h12v18h18v12h-18v18h-12v-18h-18v-12h18z" fill="#ffffff" opacity="0.16"/>
   <rect x="300" y="690" width="600" height="16" rx="8" fill="#ffffff" opacity="0.20"/>
   <rect x="345" y="706" width="510" height="94" fill="#ffffff" opacity="0.07"/>
   <rect x="520" y="672" width="124" height="12" rx="3" fill="#ffffff" opacity="0.22"/>
   <rect x="535" y="624" width="94" height="50" rx="5" fill="#ffffff" opacity="0.14" stroke="#ffffff" stroke-opacity="0.28" stroke-width="2"/>
   <rect x="430" y="652" width="32" height="30" rx="5" fill="#ffffff" opacity="0.20"/>
   <path d="M462 660c14 0 14 16 0 16" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.20"/>
   <path d="M700 684c-6-30 10-50 22-50s28 20 22 50z" fill="#ffffff" opacity="0.18"/>
   <ellipse cx="712" cy="624" rx="16" ry="9" fill="#ffffff" opacity="0.16"/>
   <ellipse cx="732" cy="616" rx="15" ry="9" fill="#ffffff" opacity="0.16"/>
   <ellipse cx="722" cy="606" rx="14" ry="9" fill="#ffffff" opacity="0.16"/>
  </g>
 </svg>
 <div class="loginbox">
 <div class="avwrap"><img class="loginlogo" src="/avatar" alt="Dr. Elroi" onerror="this.onerror=null;var br=document.getElementById('brand');if(br){this.replaceWith(br.cloneNode(true));}else{this.style.display='none';}"><span class="dot" title="Online"></span></div>
 <h2>Sign in to Dr. Elroi</h2>
 <div class="welcome-sub">Your AI GP assistant — at the desk and ready to help.</div>
 <form id="lf">
  <input id="le" type="email" placeholder="Email" autocomplete="username" required>
  <input id="lp" type="password" placeholder="Password" autocomplete="current-password" required>
  <button id="lb" type="submit">Sign in</button>
 </form>
 <div class="loginerr" id="lerr"></div>
</div></div>
<div id="chartModal"><div class="chartbox">
 <h3>Add to chart</h3>
 <div class="sub">Recorded by you for the selected patient.</div>
 <label>Patient</label><div class="ppick"><input id="cmSearch" class="ppick-in" placeholder="Search name, phone, Fayda, email or ID…" autocomplete="off"><input type="hidden" id="cmPatient"><div class="ppick-list" id="cmList"></div></div>
 <label>Record type</label>
 <select id="cmKind">
  <option value="condition">Diagnosis / problem</option>
  <option value="medication">Medication</option>
  <option value="allergy">Allergy</option>
  <option value="observation">Vital / lab result</option>
  <option value="order">Lab / imaging order</option>
  <option value="diagnostic">Diagnostic / imaging report</option>
 </select>
 <div id="cmValRow"><label id="cmValLabel">Diagnosis</label><input id="cmValue"></div>
 <div id="cmDoseRow" style="display:none"><label id="cmDoseLabel">Dosage / instructions</label><input id="cmDosage" placeholder="e.g. 500 mg twice daily for 5 days"></div>
 <div id="cmMeasureRow" style="display:none" class="two"><div><label>Value</label><input id="cmMeasure" placeholder="e.g. 120"></div><div><label>Unit</label><input id="cmUnit" placeholder="e.g. mmHg"></div></div>
 <div class="chartmsg" id="cmMsg"></div>
 <div class="actions"><button class="ghost" id="cmCancel" type="button">Cancel</button><button id="cmSave" type="button">Save to chart</button></div>
</div></div>
<div id="regModal"><div class="chartbox">
 <h3>Register patient</h3>
 <div class="sub">Creates a new patient record.</div>
 <div class="two" style="display:flex;gap:10px"><div style="flex:1"><label>First name</label><input id="rgGiven"></div><div style="flex:1"><label>Last name</label><input id="rgFamily"></div></div>
 <div class="two" style="display:flex;gap:10px"><div style="flex:1"><label>Sex</label><select id="rgGender"><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></div><div style="flex:1"><label>Date of birth</label><input id="rgDob" type="date"></div></div>
 <div class="two" style="display:flex;gap:10px"><div style="flex:1"><label>National ID (Fayda)</label><input id="rgNid" placeholder="e.g. 6001234567890"></div><div style="flex:1"><label>Phone</label><input id="rgPhone" placeholder="e.g. 0911234567"></div></div>
 <div class="scnote">A unique ID (Fayda or phone) is how patients are identified in pickers — please add at least one.</div>
 <div id="rgAssignRow" style="display:none"><label>Assign to doctor (optional)</label><select id="rgAssign"></select></div>
 <div class="chartmsg" id="rgMsg"></div>
 <div class="actions"><button class="ghost" id="rgCancel" type="button">Cancel</button><button id="rgSave" type="button">Register</button></div>
</div></div>
<div id="scribeModal"><div class="chartbox">
 <h3>Dictate visit</h3>
 <div class="sub">Speak (use your device's voice typing) or type the visit note. Elroi proposes chart entries — you approve before anything is saved.</div>
 <label>Patient</label><div class="ppick"><input id="scSearch" class="ppick-in" placeholder="Search name, phone, Fayda, email or ID…" autocomplete="off"><input type="hidden" id="scPatient"><div class="ppick-list" id="scList"></div></div>
 <label>Visit note</label><textarea id="scText" style="min-height:120px" placeholder="e.g. 38-year-old woman, fever 39.1, BP 140/90, suspected malaria; start artemether-lumefantrine 1 tablet twice daily for 3 days; allergic to penicillin."></textarea>
 <div class="actions" style="justify-content:flex-start"><button id="scExtract" type="button">Extract with Elroi</button></div>
 <div id="scReview"></div>
 <div class="chartmsg" id="scMsg"></div>
 <div class="actions"><button class="ghost" id="scCancel" type="button">Close</button><button id="scSave" type="button" style="display:none">Save approved to chart</button></div>
</div></div>
<div id="chartView"><div class="chartbox" style="width:520px;max-height:82vh;overflow:auto">
 <h3>Patient chart</h3>
 <label>Patient</label><div class="ppick"><input id="cvSearch" class="ppick-in" placeholder="Search name, phone, Fayda, email or ID…" autocomplete="off"><input type="hidden" id="cvPatient"><div class="ppick-list" id="cvList"></div></div>
 <div id="cvBody" style="margin-top:6px"></div>
 <div class="actions"><button class="ghost" id="cvClose" type="button">Close</button></div>
</div></div>
<main><div class="chat" id="chat"></div></main>
<div class="barwrap">
 <form id="f">
  <div class="inbox"><textarea id="q" rows="1" placeholder="Ask Dr. Elroi about your patients…" autocomplete="off"></textarea></div>
  <button class="send" id="b" title="Send" aria-label="Send"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg></button>
 </form>
 <div class="disc">Dr. Elroi assists healthcare workers and does not replace professional clinical judgment.</div>
</div>
<script>
var chat=document.getElementById('chat'),q=document.getElementById('q'),b=document.getElementById('b'),f=document.getElementById('f');
// --- auth: login overlay + role-aware header ---
var loginEl=document.getElementById('login'),lf=document.getElementById('lf'),le=document.getElementById('le'),lp=document.getElementById('lp'),lerr=document.getElementById('lerr'),logoutBtn=document.getElementById('logout'),adminBadge=document.getElementById('adminbadge');
var ME=null;
function showLogin(){ document.body.classList.remove('authed'); if(loginEl) loginEl.classList.remove('hidden'); }
function hideLogin(){ document.body.classList.add('authed'); if(loginEl) loginEl.classList.add('hidden'); }
function applyAuth(me){ ME=me; if(adminBadge){ adminBadge.style.display = me.isAdmin ? '' : 'none'; adminBadge.textContent = (me.role==='developer'?'⚙ Developer panel':'⚙ Admin panel'); } if(logoutBtn) logoutBtn.style.display=''; var ac=document.getElementById('addchart'); if(ac) ac.style.display=''; var vc=document.getElementById('viewchart'); if(vc) vc.style.display=''; var rp=document.getElementById('regpatient'); if(rp) rp.style.display=''; var dc=document.getElementById('dictate'); if(dc) dc.style.display=''; }
function doLogout(){ fetch('/logout',{method:'POST'}).then(function(){ location.reload(); }); }
var AILOGO='<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><g transform="translate(11.5,10) scale(1.04)"><path d="M12 21s-7.5-4.6-9.6-9C1 9 2.5 5.5 6 5.5c2 0 3.4 1.2 4 2.3.6-1.1 2-2.3 4-2.3 3.5 0 5 3.5 3.6 6.5C19.5 16.4 12 21 12 21z" fill="#fff"/></g></svg>';
// Dr. Elroi's face: shows /avatar (the photo in connector/assets) and quietly falls back to the heart if absent.
function aiFace(){ return '<img class="facepic" src="/avatar" alt="Dr. Elroi" onerror="this.onerror=null;this.outerHTML=AILOGO">'; }
// If a face photo exists, also use it as the small header brand mark; otherwise keep the heart logo.
(function(){ var probe=new Image(); probe.onload=function(){ var h=document.getElementById('brand'); if(h){ h.outerHTML='<img id="brand" class="logo facepic" src="/avatar" alt="Dr. Elroi">'; } }; probe.src='/avatar'; })();
var started=false;
var convo=[];
// --- voice: Kokoro only, click-to-play (a small play button beside each answer; no auto-play) ---
var curAudio=null, curBtn=null, saySpeed=1.05, autoSpeak=false;
try{ autoSpeak = localStorage.getItem('elroiAuto')==='1'; }catch(e){}
function idleTitle(){ return autoSpeak ? 'Auto-speak ON — double-click to turn off' : 'Play (double-click = keep auto-speaking)'; }
function setBtn(btn,on){ if(!btn)return; if(on){ btn.classList.add('playing'); btn.textContent='🗣️'; btn.title='Stop'; } else { btn.classList.remove('playing'); btn.textContent='👄'; btn.title=idleTitle(); } }
function applyLock(){ var all=document.querySelectorAll('.playbtn'); for(var i=0;i<all.length;i++){ all[i].classList.toggle('locked', autoSpeak); if(!all[i].classList.contains('playing')) all[i].title=idleTitle(); } }
function stripMd(t){ return t.replace(/\\*\\*/g,'').replace(/[#*_>]/g,'').replace(/^\\s*[-•]\\s*/gm,'').replace(/\\s*\\n+\\s*/g,'. ').trim(); }
function stopAudio(){ try{ if(curAudio){ curAudio.pause(); curAudio=null; } }catch(e){} if(curBtn){ setBtn(curBtn,false); curBtn=null; } }
function speak(text, btn){
  var clean=stripMd(text); if(!clean)return;
  stopAudio();
  curBtn=btn; setBtn(btn,true);
  var a=new Audio('/speak?speed='+saySpeed+'&text='+encodeURIComponent(clean));
  curAudio=a;
  function done(){ setBtn(btn,false); if(curBtn===btn)curBtn=null; }
  a.onended=done; a.onerror=done;
  a.play().catch(done);
}
function addPlayButton(bubble, text){
  var pb=document.createElement('button'); pb.className='playbtn'+(autoSpeak?' locked':''); pb.setAttribute('aria-label','Play answer');
  setBtn(pb,false);
  var to=null;
  pb.addEventListener('click', function(){ if(to){ clearTimeout(to); to=null; return; } to=setTimeout(function(){ to=null; if(pb.classList.contains('playing')) stopAudio(); else speak(text, pb); }, 230); });
  pb.addEventListener('dblclick', function(){ if(to){ clearTimeout(to); to=null; } autoSpeak=!autoSpeak; try{ localStorage.setItem('elroiAuto', autoSpeak?'1':'0'); }catch(e){} applyLock(); if(autoSpeak){ speak(text, pb); } else { stopAudio(); } });
  var row=bubble.parentNode; var col=row&&row.querySelector('.avcol'); (col||bubble).appendChild(pb);
  if(autoSpeak){ speak(text, pb); }
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function md(t){
 var safe=esc(t), out=[], list=null;
 var lines=safe.split(/\\n/);
 for(var i=0;i<lines.length;i++){
  var ln=lines[i].replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>').replace(/(https?:\\/\\/[^\\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\\*\\*/g,'').replace(/\\u0060/g,'');
  var b1=ln.match(/^\\s*[-*•]\\s+(.*)/), b2=ln.match(/^\\s*\\d+[.)]\\s+(.*)/), h=ln.match(/^\\s*#{1,6}\\s+(.*)/);
  if(h){ if(list){out.push('</'+list+'>');list=null;} out.push('<h4>'+h[1]+'</h4>'); continue; }
  if(b1){ if(list!=='ul'){if(list)out.push('</'+list+'>');out.push('<ul>');list='ul';} out.push('<li>'+b1[1]+'</li>'); continue; }
  if(b2){ if(list!=='ol'){if(list)out.push('</'+list+'>');out.push('<ol>');list='ol';} out.push('<li>'+b2[1]+'</li>'); continue; }
  if(list){out.push('</'+list+'>');list=null;}
  if(ln.trim()==='') out.push('<br>'); else out.push(ln+'<br>');
 }
 if(list)out.push('</'+list+'>');
 return out.join('');
}
function rowEl(who){
 var row=document.createElement('div');row.className='row '+who;
 var avcol=document.createElement('div');avcol.className='avcol';
 var av=document.createElement('div');av.className='av '+(who==='ai'?'ai':'me');
 av.innerHTML = who==='ai'?aiFace():'You';
 avcol.appendChild(av);
 var bub=document.createElement('div');bub.className='bubble';
 if(who==='ai'){var nm=document.createElement('div');nm.className='name';nm.textContent='Dr. Elroi';bub.appendChild(nm);}
 row.appendChild(avcol);row.appendChild(bub);chat.appendChild(row);
 return bub;
}
function clearWelcome(){if(!started){chat.innerHTML='';started=true;}}
function scroll(){window.scrollTo(0,document.body.scrollHeight);}

function ask(text){
 if(!text.trim())return; clearWelcome();
 var ub=rowEl('user');ub.textContent=text; scroll();
 b.disabled=true; stopAudio();
 var ab=rowEl('ai');
 var typ=document.createElement('div');typ.className='typing';typ.innerHTML='<span></span><span></span><span></span>';ab.appendChild(typ);scroll();
 fetch('/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:text,history:convo.slice(-8)})})
  .then(function(r){
    if(!r.body||!r.body.getReader){ return r.text().then(function(t){ab.innerHTML='<div class="name">Dr. Elroi</div>'+md(t);convo.push({role:'user',content:text});convo.push({role:'assistant',content:t});addPlayButton(ab,t);b.disabled=false;q.focus();scroll();}); }
    ab.innerHTML='<div class="name">Dr. Elroi</div><div class="stream"></div>';
    var target=ab.querySelector('.stream'),dec=new TextDecoder(),acc='',reader=r.body.getReader();
    function pump(){ return reader.read().then(function(res){
      if(res.done){ target.innerHTML=md(acc); convo.push({role:'user',content:text}); convo.push({role:'assistant',content:acc}); addPlayButton(ab,acc); b.disabled=false; q.focus(); scroll(); return; }
      acc+=dec.decode(res.value,{stream:true}); target.innerHTML=md(acc); scroll(); return pump();
    }); }
    return pump();
  })
  .catch(function(e){ ab.innerHTML='<div class="name">Dr. Elroi</div>'+esc('Sorry — '+e.message); b.disabled=false; q.focus(); });
}

function welcome(){
 var CHIPSVG='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
 function renderChips(qs){ var cw=chat.querySelector('.chips'); if(!cw)return; var html=''; for(var i=0;i<qs.length;i++){html+='<button class="chip" data-q="'+qs[i].replace(/"/g,'&quot;')+'">'+CHIPSVG+esc(qs[i])+'</button>';} cw.innerHTML=html; var cs=cw.querySelectorAll('.chip'); for(var k=0;k<cs.length;k++){cs[k].onclick=function(){ask(this.getAttribute('data-q'));};} }
 var baseQs=['Which patients need urgent attention?','Summarise a patient\\'s case and next steps','Are any of the patients children at risk?','What should I do for the patient with high blood pressure?'];
 chat.innerHTML='<div class="welcome">'+
   '<div class="big">'+'<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="wg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ad0ab"/><stop offset="1" stop-color="#0b5e4a"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#wg)"/><g transform="translate(11.5,10) scale(1.04)"><path d="M12 21s-7.5-4.6-9.6-9C1 9 2.5 5.5 6 5.5c2 0 3.4 1.2 4 2.3.6-1.1 2-2.3 4-2.3 3.5 0 5 3.5 3.6 6.5C19.5 16.4 12 21 12 21z" fill="#fff"/></g><polyline points="14,27 19,27 22,22 25,32 28,27 34,27" fill="none" stroke="#0b5e4a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="38" cy="12" r="3" fill="#ffc93c"/></svg>'+'</div>'+
   '<h2>Hi, I\\'m Dr. Elroi</h2>'+
   '<p>I read your clinic\\'s records and help you reason through cases — grounded in the patient data and standard guidelines. Ask me anything, or start with one of these:</p>'+
   '<div class="chips"></div></div>';
 renderChips(baseQs);
}

// auto-grow textarea
q.addEventListener('input',function(){q.style.height='auto';q.style.height=Math.min(q.scrollHeight,120)+'px';});
q.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
f.onsubmit=function(e){e.preventDefault();var t=q.value;q.value='';q.style.height='auto';ask(t);};

// status pill (only meaningful once logged in)
function refreshStatus(){
 fetch('/status').then(function(r){ if(r.status===401){ showLogin(); return null; } return r.json(); }).then(function(s){
  if(!s) return;
  document.getElementById('status').textContent = s.ok ? ('EMR connected · '+s.patients+' patient'+(s.patients===1?'':'s')) : 'EMR offline';
 }).catch(function(){document.getElementById('status').textContent='EMR offline';});
}

// once authenticated: reveal the app, greet, load status
function onAuthed(me){ applyAuth(me); hideLogin(); welcome(); refreshStatus(); loadPatients(); }

// login form
lf.onsubmit=function(e){ e.preventDefault(); lerr.textContent=''; var btn=document.getElementById('lb'); btn.disabled=true;
 fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:le.value,password:lp.value})})
  .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
  .then(function(x){ btn.disabled=false; if(x.ok&&x.j.ok){ onAuthed(x.j); } else { lerr.textContent='Sign in failed. Check your email and password.'; lp.value=''; } })
  .catch(function(){ btn.disabled=false; lerr.textContent='Could not reach the server.'; });
};
if(logoutBtn) logoutBtn.onclick=doLogout;

// --- Add to chart (clinician-entered clinical records) ---
var chartModal=document.getElementById('chartModal');
var PATIENTS=[];
function loadPatients(){ fetch('/patients').then(function(r){return r.json();}).then(function(j){ if(j&&j.ok) PATIENTS=j.patients||[]; }).catch(function(){}); }
function pickById(id){ for(var i=0;i<PATIENTS.length;i++){ if('Patient/'+PATIENTS[i].id===id) return PATIENTS[i]; } return null; }
// searchable patient picker: type to filter by name/phone/Fayda/email/any id; click to select. Hidden input keeps Patient/<id>.
function setupPicker(pfx,onpick){ var inp=document.getElementById(pfx+'Search'),hid=document.getElementById(pfx+'Patient'),list=document.getElementById(pfx+'List'); if(!inp||!hid||!list)return;
 function render(){ var q=(inp.value||'').trim().toLowerCase(); var rows=PATIENTS.filter(function(p){ return !q||(p.search||'').indexOf(q)>=0; }).slice(0,40);
  if(!PATIENTS.length){ list.innerHTML='<div class="ppick-empty">No patients yet — use “Register patient”.</div>'; list.style.display=''; return; }
  if(!rows.length){ list.innerHTML='<div class="ppick-empty">No matching patient</div>'; list.style.display=''; return; }
  list.innerHTML=rows.map(function(p){ return '<div class="ppick-opt" data-id="Patient/'+p.id+'">'+esc(p.label||p.name)+'</div>'; }).join('');
  var opts=list.querySelectorAll('.ppick-opt'); for(var i=0;i<opts.length;i++){ opts[i].onmousedown=function(e){ e.preventDefault(); var id=this.getAttribute('data-id'); hid.value=id; var p=pickById(id); inp.value=p?(p.label||p.name):''; list.style.display='none'; if(onpick)onpick(id); }; }
  list.style.display=''; }
 inp.addEventListener('input',function(){ hid.value=''; render(); });
 inp.addEventListener('focus',function(){ render(); });
 document.addEventListener('click',function(e){ if(inp.parentNode&&!inp.parentNode.contains(e.target)) list.style.display='none'; });
}
function resetPicker(pfx){ var inp=document.getElementById(pfx+'Search'),hid=document.getElementById(pfx+'Patient'),list=document.getElementById(pfx+'List'); if(inp)inp.value=''; if(hid)hid.value=''; if(list)list.style.display='none'; }
setupPicker('cm'); setupPicker('sc'); setupPicker('cv', loadChart);
function chartFields(){ var k=document.getElementById('cmKind').value;
 document.getElementById('cmDoseRow').style.display = (k==='medication'||k==='diagnostic')?'':'none';
 document.getElementById('cmMeasureRow').style.display = k==='observation'?'':'none';
 document.getElementById('cmDoseLabel').textContent = k==='medication'?'Dosage / instructions':'Findings / conclusion';
 document.getElementById('cmDosage').placeholder = k==='medication'?'e.g. 500 mg twice daily for 5 days':'e.g. No acute findings';
 document.getElementById('cmValLabel').textContent = k==='condition'?'Diagnosis / problem' : k==='medication'?'Medication name' : k==='allergy'?'Allergy (substance)' : k==='diagnostic'?'Report / study name' : k==='order'?'What to order':'What was measured (e.g. Blood pressure)';
 document.getElementById('cmValue').placeholder = k==='observation'?'e.g. Blood pressure' : k==='diagnostic'?'e.g. Chest X-ray' : k==='order'?'e.g. Malaria RDT, FBC, Chest X-ray':'';
}
function openChart(){ document.getElementById('cmMsg').textContent=''; document.getElementById('cmValue').value=''; document.getElementById('cmDosage').value=''; document.getElementById('cmMeasure').value=''; document.getElementById('cmUnit').value=''; chartFields(); resetPicker('cm'); if(!PATIENTS.length) loadPatients(); chartModal.classList.add('show'); }
function closeChart(){ chartModal.classList.remove('show'); }
function saveChart(){ var msg=document.getElementById('cmMsg'); msg.style.color='var(--muted)'; msg.textContent='Saving…';
 var b={patient:document.getElementById('cmPatient').value,kind:document.getElementById('cmKind').value,value:document.getElementById('cmValue').value,dosage:document.getElementById('cmDosage').value,measure:document.getElementById('cmMeasure').value,unit:document.getElementById('cmUnit').value};
 if(!b.patient){ msg.style.color='#c0392b'; msg.textContent='Pick a patient first.'; return; }
 fetch('/chart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();}).then(function(j){ if(j.ok){ msg.style.color='var(--green2)'; msg.textContent='Saved to chart.'; setTimeout(closeChart,800); } else { msg.style.color='#c0392b'; msg.textContent=j.error||'Could not save'; } }).catch(function(){ msg.style.color='#c0392b'; msg.textContent='Could not reach the server.'; }); }
var addChartBtn=document.getElementById('addchart');
if(addChartBtn) addChartBtn.onclick=openChart;
document.getElementById('cmCancel').onclick=closeChart;
document.getElementById('cmSave').onclick=saveChart;
document.getElementById('cmKind').onchange=chartFields;
chartModal.addEventListener('click',function(e){ if(e.target===chartModal) closeChart(); });

// --- View chart ---
var chartView=document.getElementById('chartView');
function openView(){ resetPicker('cv'); if(!PATIENTS.length) loadPatients(); chartView.classList.add('show'); loadChart(); }
function closeView(){ chartView.classList.remove('show'); }
function loadChart(){ var pid=document.getElementById('cvPatient').value; var body=document.getElementById('cvBody'); if(!pid){ body.innerHTML='<div class="cvempty">No patient selected.</div>'; return; }
 body.innerHTML='<div class="cvempty">Loading…</div>';
 fetch('/chart?patient='+encodeURIComponent(pid)).then(function(r){return r.json();}).then(function(j){ if(!j.ok){ body.innerHTML='<div class="cvempty">'+esc(j.error||'Could not load')+'</div>'; return; }
  var html='<div class="cvhead"><strong>'+esc(j.name)+'</strong> — '+esc(j.demographics)+'</div>';
  if(!j.sections.length){ html+='<div class="cvempty">No records yet. Use “+ Add to chart” to add some.</div>'; }
  j.sections.forEach(function(sec){ html+='<div class="cvsection">'+esc(sec.title)+'</div>'; sec.items.forEach(function(it){ html+='<div class="cvitem"><span>'+esc(it.text)+'</span><button data-ref="'+esc(it.ref)+'">Remove</button></div>'; }); });
  if(ME&&ME.isAdmin){
   html+='<div class="cvsection">Assigned doctors (who can see this patient)</div>';
   var ad=j.assignedDoctors||[];
   if(!ad.length) html+='<div class="cvempty">None — only admins/developers can see this patient until you assign a doctor.</div>';
   ad.forEach(function(d){ html+='<div class="cvitem"><span>'+esc(d.name)+'</span><button class="rmdoc" data-doc="'+esc(d.ref)+'">Remove</button></div>'; });
   html+='<div class="cvitem" style="border:0"><select id="cvAssign" style="flex:1;padding:7px 9px;border:1px solid var(--line);border-radius:8px"></select> <button id="cvAssignBtn" style="flex:0 0 auto">Assign</button></div>';
   html+='<div class="cvsection">Patient login (EMR portal)</div>';
   if(j.loginEmail){ html+='<div class="cvitem" style="border:0">Signs in at <strong>localhost:3002</strong> as <strong>'+esc(j.loginEmail)+'</strong></div>'; }
   else { html+='<div class="cvempty">No login yet — create one so this patient can view their own record and message their GP.</div>'+
    '<div class="cvitem" style="border:0;gap:6px;flex-wrap:wrap"><input id="cvPlEmail" type="email" placeholder="patient email" style="flex:1;min-width:150px;padding:7px 9px;border:1px solid var(--line);border-radius:8px"><input id="cvPlPass" type="text" placeholder="initial password (min 8)" style="flex:1;min-width:150px;padding:7px 9px;border:1px solid var(--line);border-radius:8px"><button id="cvPlBtn" style="flex:0 0 auto">Create login</button></div>'+
    '<div class="cvempty" id="cvPlMsg"></div>'; }
  }
  body.innerHTML=html;
  var pref='Patient/'+pid;
  var dbs=body.querySelectorAll('button[data-ref]'); for(var i=0;i<dbs.length;i++){ dbs[i].onclick=function(){ var rf=this.getAttribute('data-ref'); if(!confirm('Remove this entry from the chart? This cannot be undone.'))return; fetch('/chart?ref='+encodeURIComponent(rf),{method:'DELETE'}).then(function(r){return r.json();}).then(function(x){ if(x.ok) loadChart(); else alert(x.error||'Could not remove'); }); }; }
  if(ME&&ME.isAdmin){
   var rmd=body.querySelectorAll('button.rmdoc'); for(var k=0;k<rmd.length;k++){ rmd[k].onclick=function(){ var dr=this.getAttribute('data-doc'); fetch('/admin/patient/gp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patient:pref,practitioner:dr,action:'remove'})}).then(function(r){return r.json();}).then(function(x){ if(x.ok) loadChart(); else alert(x.error||'Could not remove'); }); }; }
   var asel=document.getElementById('cvAssign'); if(asel){ loadDoctors(function(docs){ asel.innerHTML='<option value="">— choose a clinician —</option>'; docs.forEach(function(d){ var o=document.createElement('option');o.value=d.ref;o.textContent=d.name+(d.role?(' ('+d.role+')'):'');asel.appendChild(o); }); }); }
   var ab=document.getElementById('cvAssignBtn'); if(ab) ab.onclick=function(){ var pr=document.getElementById('cvAssign').value; if(!pr)return; fetch('/admin/patient/gp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patient:pref,practitioner:pr,action:'add'})}).then(function(r){return r.json();}).then(function(x){ if(x.ok) loadChart(); else alert(x.error||'Could not assign'); }); };
   var plb=document.getElementById('cvPlBtn'); if(plb) plb.onclick=function(){ var em=document.getElementById('cvPlEmail').value.trim(); var pw=document.getElementById('cvPlPass').value; var msg=document.getElementById('cvPlMsg'); if(!em||pw.length<8){ msg.style.color='#c0392b'; msg.textContent='Enter an email and a password of at least 8 characters.'; return; } msg.style.color='var(--muted)'; msg.textContent='Creating login…'; fetch('/admin/patients/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patient:pref,email:em,password:pw})}).then(function(r){return r.json();}).then(function(x){ if(x.ok){ alert('Patient login created.\\n\\nGive the patient:\\n  • Web address: http://localhost:3002\\n  • Email: '+em+'\\n  • Password: '+pw+'\\n\\n(The password is shown only now.)'); loadChart(); } else { msg.style.color='#c0392b'; msg.textContent=x.error||'Could not create login'; } }).catch(function(){ msg.style.color='#c0392b'; msg.textContent='Could not reach the server.'; }); };
  }
 }).catch(function(){ body.innerHTML='<div class="cvempty">Could not reach the server.</div>'; }); }
var viewBtn=document.getElementById('viewchart'); if(viewBtn) viewBtn.onclick=openView;
document.getElementById('cvClose').onclick=closeView;
chartView.addEventListener('click',function(e){ if(e.target===chartView) closeView(); });

// --- Register patient ---
var regModal=document.getElementById('regModal');
var DOCTORS=null;
function loadDoctors(cb){ if(DOCTORS){ if(cb)cb(DOCTORS); return; } fetch('/admin/doctors').then(function(r){return r.status===200?r.json():null;}).then(function(j){ DOCTORS=(j&&j.ok)?j.doctors:[]; if(cb)cb(DOCTORS); }).catch(function(){ DOCTORS=[]; if(cb)cb(DOCTORS); }); }
function openReg(){ document.getElementById('rgMsg').textContent=''; document.getElementById('rgGiven').value=''; document.getElementById('rgFamily').value=''; document.getElementById('rgGender').value=''; document.getElementById('rgDob').value=''; document.getElementById('rgNid').value=''; document.getElementById('rgPhone').value='';
 if(ME&&ME.isAdmin){ document.getElementById('rgAssignRow').style.display=''; loadDoctors(function(docs){ var s=document.getElementById('rgAssign'); s.innerHTML='<option value="">— none —</option>'; docs.forEach(function(d){ var o=document.createElement('option');o.value=d.ref;o.textContent=d.name+(d.role?(' ('+d.role+')'):'');s.appendChild(o); }); }); } else { document.getElementById('rgAssignRow').style.display='none'; }
 regModal.classList.add('show'); }
function closeReg(){ regModal.classList.remove('show'); }
function saveReg(){ var msg=document.getElementById('rgMsg'); msg.style.color='var(--muted)'; msg.textContent='Saving…';
 var b={given:document.getElementById('rgGiven').value,family:document.getElementById('rgFamily').value,gender:document.getElementById('rgGender').value,birthDate:document.getElementById('rgDob').value,nidValue:document.getElementById('rgNid').value,phone:document.getElementById('rgPhone').value};
 if(ME&&ME.isAdmin) b.assignTo=document.getElementById('rgAssign').value;
 fetch('/patients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();}).then(function(j){ if(j.ok){ msg.style.color='var(--green2)'; msg.textContent='Patient registered.'; loadPatients(); setTimeout(closeReg,800); } else { msg.style.color='#c0392b'; msg.textContent=j.error||'Could not register'; } }).catch(function(){ msg.style.color='#c0392b'; msg.textContent='Could not reach the server.'; }); }
var regBtn=document.getElementById('regpatient'); if(regBtn) regBtn.onclick=openReg;
document.getElementById('rgCancel').onclick=closeReg;
document.getElementById('rgSave').onclick=saveReg;
regModal.addEventListener('click',function(e){ if(e.target===regModal) closeReg(); });

// --- AI scribe: dictate/type a visit, Elroi proposes, you approve ---
var scribeModal=document.getElementById('scribeModal');
function scAttr(s){ return esc(s).replace(/"/g,'&quot;'); }
function openScribe(){ resetPicker('sc'); if(!PATIENTS.length) loadPatients(); document.getElementById('scText').value=''; document.getElementById('scReview').innerHTML=''; document.getElementById('scMsg').textContent=''; document.getElementById('scSave').style.display='none'; scribeModal.classList.add('show'); }
function closeScribe(){ scribeModal.classList.remove('show'); }
function renderReview(p){
 var h='<div class="scwarn">⚠ Elroi can make mistakes. Review and edit each item — uncheck anything wrong. Nothing is saved until you click Save.</div>';
 h+='<div class="scsec">Diagnoses / problems</div>'; if(!p.conditions.length) h+='<div class="scnote">none found</div>';
 p.conditions.forEach(function(c){ h+='<div class="scrow" data-t="condition"><input type="checkbox" checked><input type="text" data-f="value" value="'+scAttr(c)+'"></div>'; });
 h+='<div class="scsec">Medications</div>'; if(!p.medications.length) h+='<div class="scnote">none found</div>';
 p.medications.forEach(function(m){ h+='<div class="scrow" data-t="medication"><input type="checkbox" checked><input type="text" data-f="value" placeholder="drug" value="'+scAttr(m.name)+'"><input type="text" data-f="dosage" placeholder="dosage" value="'+scAttr(m.dosage)+'"></div>'; });
 h+='<div class="scsec">Allergies</div>'; if(!p.allergies.length) h+='<div class="scnote">none found</div>';
 p.allergies.forEach(function(a){ h+='<div class="scrow" data-t="allergy"><input type="checkbox" checked><input type="text" data-f="value" value="'+scAttr(a)+'"></div>'; });
 h+='<div class="scsec">Vitals / measurements</div>'; if(!p.vitals.length) h+='<div class="scnote">none found</div>';
 p.vitals.forEach(function(v){ h+='<div class="scrow" data-t="vital"><input type="checkbox" checked><input type="text" data-f="name" placeholder="measurement" value="'+scAttr(v.name)+'" style="flex:2"><input type="text" data-f="value" placeholder="value" value="'+scAttr(v.value)+'"><input type="text" data-f="unit" placeholder="unit" value="'+scAttr(v.unit)+'"></div>'; });
 if(p.note) h+='<div class="scsec">Summary</div><div class="scnote">'+esc(p.note)+'</div>';
 document.getElementById('scReview').innerHTML=h; document.getElementById('scSave').style.display='';
}
function scExtract(){ var msg=document.getElementById('scMsg'); var text=document.getElementById('scText').value.trim(); if(!text){ msg.style.color='#c0392b'; msg.textContent='Type or dictate the visit note first.'; return; }
 msg.style.color='var(--muted)'; msg.textContent='Elroi is reading the note…'; var b=document.getElementById('scExtract'); b.disabled=true;
 fetch('/scribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})}).then(function(r){return r.json();}).then(function(j){ b.disabled=false; if(j.ok){ msg.textContent=''; renderReview(j.proposal); } else { msg.style.color='#c0392b'; msg.textContent=j.error||'Could not extract'; } }).catch(function(){ b.disabled=false; msg.style.color='#c0392b'; msg.textContent='Could not reach the server.'; }); }
function scSave(){ var msg=document.getElementById('scMsg'); var pid=document.getElementById('scPatient').value; if(!pid){ msg.style.color='#c0392b'; msg.textContent='Pick a patient first.'; return; }
 var out={patient:pid,conditions:[],medications:[],allergies:[],vitals:[]}; var rows=document.querySelectorAll('#scReview .scrow');
 for(var i=0;i<rows.length;i++){ var r=rows[i]; var cb=r.querySelector('input[type=checkbox]'); if(!cb||!cb.checked)continue; var t=r.getAttribute('data-t');
  function val(f){ var el=r.querySelector('input[data-f="'+f+'"]'); return el?el.value.trim():''; }
  if(t==='condition'){ if(val('value')) out.conditions.push(val('value')); }
  else if(t==='medication'){ if(val('value')) out.medications.push({name:val('value'),dosage:val('dosage')}); }
  else if(t==='allergy'){ if(val('value')) out.allergies.push(val('value')); }
  else if(t==='vital'){ if(val('name')) out.vitals.push({name:val('name'),value:val('value'),unit:val('unit')}); }
 }
 var total=out.conditions.length+out.medications.length+out.allergies.length+out.vitals.length;
 if(!total){ msg.style.color='#c0392b'; msg.textContent='Nothing approved to save.'; return; }
 msg.style.color='var(--muted)'; msg.textContent='Saving '+total+' item(s)…';
 fetch('/scribe/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(out)}).then(function(r){return r.json();}).then(function(j){ if(j.ok){ msg.style.color='var(--green2)'; msg.textContent='Saved '+j.saved+' item(s) to the chart.'; setTimeout(closeScribe,1100); } else { msg.style.color='#c0392b'; msg.textContent=(j.error||('Saved '+(j.saved||0)+', some failed'))+''; } }).catch(function(){ msg.style.color='#c0392b'; msg.textContent='Could not reach the server.'; }); }
var dictateBtn=document.getElementById('dictate'); if(dictateBtn) dictateBtn.onclick=openScribe;
document.getElementById('scCancel').onclick=closeScribe;
document.getElementById('scExtract').onclick=scExtract;
document.getElementById('scSave').onclick=scSave;
scribeModal.addEventListener('click',function(e){ if(e.target===scribeModal) closeScribe(); });

// bootstrap: am I already logged in?
fetch('/me').then(function(r){ if(r.status===401){ showLogin(); return null; } return r.json(); })
 .then(function(me){ if(me&&me.ok){ onAuthed(me); } else { showLogin(); } })
 .catch(function(){ showLogin(); });
</script></body></html>`;

// ---- Admin panel page (served at /admin) ----
const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dr. Elroi — Admin</title>
<style>
 :root{--green:#0b5e4a;--green2:#16a886;--gold:#ffc93c;--ink:#16241f;--muted:#6b7d77;--line:#dce5e2;--bg:#eaf0ee}
 *{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--ink)}
 header{background:linear-gradient(135deg,var(--green2),var(--green));color:#fff;padding:14px 18px;display:flex;align-items:center;gap:12px}
 header h1{font-size:18px;margin:0}header .sp{flex:1}
 header a{color:#fff;text-decoration:none;background:rgba(255,255,255,.18);padding:6px 12px;border-radius:999px;font-size:13px}
 main{max-width:900px;margin:0 auto;padding:22px 16px 60px}
 .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 18px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
 .card h2{margin:0 0 12px;font-size:16px;color:var(--green)}
 table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
 input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;font:inherit;outline:none}
 input:focus,select:focus,textarea:focus{border-color:var(--green2);box-shadow:0 0 0 3px rgba(22,168,134,.15)}
 textarea{min-height:150px;resize:vertical;line-height:1.4}
 label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
 .row{display:flex;gap:10px;flex-wrap:wrap}.row>div{flex:1;min-width:140px}
 button{padding:9px 14px;border:0;border-radius:9px;background:var(--green);color:#fff;font-weight:600;cursor:pointer}
 button:hover{background:var(--green2)}button.ghost{background:#fff;color:var(--green);border:1px solid var(--line)}
 button.danger{background:#fff;color:#c0392b;border:1px solid #e7c2bd;padding:5px 10px;font-weight:500}
 .note{font-size:12px;color:var(--muted);margin-top:6px}.msg{font-size:13px;margin-top:8px;min-height:16px}
 .ok{color:var(--green2)}.err{color:#c0392b}.warn{background:#fff8e6;border:1px solid #ffe2a6;padding:8px 10px;border-radius:8px;font-size:12.5px;color:#8a6d1a;margin-bottom:10px}
 #gate{padding:40px;text-align:center}
 #edModal{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:rgba(11,36,31,.45)}
 #edModal.show{display:flex}
 .edbox{background:#fff;border-radius:14px;padding:20px 22px;width:560px;max-width:94vw;max-height:90vh;overflow:auto;box-shadow:0 22px 60px rgba(0,0,0,.3)}
 .edbox h3{margin:0 0 12px;font-size:17px;color:var(--green)}
 .edbox .two{display:flex;gap:10px}.edbox .two>div{flex:1}
 .edtag{display:inline-flex;align-items:center;gap:5px;background:#eafaf5;border:1px solid var(--line);border-radius:12px;padding:2px 6px 2px 10px;font-size:12px;margin:3px 4px 0 0}
 .edtag button{background:none;border:0;color:#c0392b;cursor:pointer;font-size:14px;padding:0;line-height:1}
 .edact{display:flex;align-items:center;gap:8px;margin-top:8px}.edact input{width:auto}
</style></head><body>
<header><h1>Dr. Elroi · Admin</h1><span class="sp"></span><a href="/">← Back to chat</a><a href="#" id="signout">Sign out</a></header>
<main id="main" style="display:none">
 <div class="card"><h2>Doctor accounts</h2>
  <table id="utable"><thead><tr><th>Name</th><th>National ID</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>
  <h3 style="font-size:14px;margin:16px 0 4px">Add a doctor</h3>
  <div class="row"><div><label>First name</label><input id="fn"></div><div><label>Last name</label><input id="ln"></div></div>
  <div class="row"><div><label>Email</label><input id="em" type="email"></div><div><label>Initial password (min 8)</label><input id="pw" type="text"></div></div>
  <div class="row"><div><label>National ID type</label><input id="nt" value="Fayda-ET"></div><div><label>National ID number (optional)</label><input id="nv"></div></div>
  <div class="row"><div><label>Role</label><select id="role"><option value="doctor">Doctor</option><option value="admin">Admin</option></select></div><div></div></div>
  <div style="margin-top:12px"><button id="addbtn">Create account</button></div>
  <div class="note">No email is sent — give the doctor their email + this initial password directly. The password is shown only here.</div>
  <div class="msg" id="umsg"></div>
 </div>
 <div class="card" id="cardPrompts" style="display:none"><h2>Elroi's instructions <span style="font-size:11px;color:var(--muted);font-weight:400">· Developer</span></h2>
  <div class="warn">You have full control of these prompts. If you remove the safety, no-hallucination or stay-on-mission rules, Elroi may behave unsafely. Use “Restore safe defaults” to undo.</div>
  <label>System prompt (clinical)</label><textarea id="sysp"></textarea>
  <label>Quick prompt (chat / greetings)</label><textarea id="quickp"></textarea>
  <div style="margin-top:12px;display:flex;gap:10px"><button id="savep">Save instructions</button><button class="ghost" id="resetp">Restore safe defaults</button></div>
  <div class="msg" id="pmsg"></div>
 </div>
 <div class="card" id="cardModel" style="display:none"><h2>Model &amp; voice <span style="font-size:11px;color:var(--muted);font-weight:400">· Developer</span></h2>
  <div class="row"><div><label>AI model</label><select id="model"></select></div><div><label>Voice</label><select id="voice"></select></div></div>
  <div style="margin-top:12px"><button id="savemv">Save</button></div>
  <div class="msg" id="mvmsg"></div>
 </div>
 <div class="card"><h2>Usage log</h2>
  <div class="note">Most recent questions asked to Dr. Elroi (kept locally on this machine).</div>
  <table id="atable"><thead><tr><th>Time</th><th>Doctor</th><th>Type</th><th>Question</th></tr></thead><tbody></tbody></table>
 </div>
</main>
<div id="edModal"><div class="edbox">
 <h3>Edit account</h3>
 <div class="two"><div><label>First name</label><input id="edFn"></div><div><label>Last name</label><input id="edLn"></div></div>
 <label>Login email</label><input id="edEmail" type="email">
 <div class="two"><div><label>Phone</label><input id="edPhone"></div><div><label>Role</label><select id="edRole"></select></div></div>
 <div class="two"><div><label>National ID type</label><input id="edNt"></div><div><label>National ID number</label><input id="edNv"></div></div>
 <label>Profile tags</label>
 <div id="edTags"></div>
 <div class="edact"><input id="edTagNew" placeholder="add a tag, e.g. Pediatrics" style="flex:1"><button class="ghost" id="edTagAdd" type="button">Add tag</button></div>
 <label class="edact" style="margin-top:14px"><input id="edActive" type="checkbox"> Account active (uncheck to disable login)</label>
 <div class="note" id="edNote"></div>
 <div class="msg" id="edMsg"></div>
 <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="ghost" id="edCancel" type="button">Cancel</button><button id="edSave" type="button">Save changes</button></div>
</div></div>
<div id="gate">Checking access…</div>
<script>
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function gj(u){return fetch(u).then(function(r){return r.json().then(function(j){return {status:r.status,j:j};});});}
function pj(u,m,b){return fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){return {status:r.status,j:j};});});}
function setMsg(id,txt,ok){var e=document.getElementById(id);e.textContent=txt;e.className='msg '+(ok?'ok':'err');}

var USERS={};
function loadUsers(){ gj('/admin/users').then(function(x){ var tb=document.querySelector('#utable tbody'); tb.innerHTML=''; USERS={};
 if(!x.j.ok){return;} x.j.users.forEach(function(u){ USERS[u.id]=u; var tr=document.createElement('tr');
  var nidcol = u.nidValue ? ('<strong>'+esc(u.nidType||'NID')+'</strong> '+esc(u.nidValue)) : '<span style="color:var(--muted)">— not set</span>';
  var emailcol = u.email ? esc(u.email) : '<span style="color:var(--muted)">id '+esc(u.shortId||'')+'…</span>';
  var roleName = u.role==='developer'?'Developer':u.role==='admin'?'Admin':'Doctor';
  var tagscol = (u.tags&&u.tags.length) ? ('<div style="margin-top:3px">'+u.tags.map(function(t){return '<span style="display:inline-block;background:#eafaf5;border:1px solid var(--line);border-radius:10px;padding:1px 7px;font-size:11px;margin:2px 3px 0 0">'+esc(t)+'</span>';}).join('')+'</div>') : '';
  tr.innerHTML='<td>'+esc(u.name)+tagscol+'</td><td>'+nidcol+'</td><td>'+emailcol+'</td><td>'+roleName+'</td><td>'+(u.active?'Active':'<span style="color:#c0392b">Inactive</span>')+'</td>'+
   '<td style="white-space:nowrap"><button class="ghost edit" data-id="'+esc(u.id)+'" style="padding:5px 12px;font-weight:500">Edit</button> '+
   '<button class="danger" data-id="'+esc(u.id)+'">Remove</button></td>'; tb.appendChild(tr); });
 var btns=tb.querySelectorAll('button.danger'); for(var i=0;i<btns.length;i++){ btns[i].onclick=function(){ var id=this.getAttribute('data-id');
   if(!confirm('Remove this account? This cannot be undone.'))return; pj('/admin/users/'+encodeURIComponent(id),'DELETE').then(function(){loadUsers();}); }; }
 var eds=tb.querySelectorAll('button.edit'); for(var k=0;k<eds.length;k++){ eds[k].onclick=function(){ openEditor(USERS[this.getAttribute('data-id')]); }; }
 }); }

document.getElementById('addbtn').onclick=function(){ var b={firstName:document.getElementById('fn').value,lastName:document.getElementById('ln').value,email:document.getElementById('em').value,password:document.getElementById('pw').value,nidType:document.getElementById('nt').value,nidValue:document.getElementById('nv').value,role:document.getElementById('role').value};
 pj('/admin/users','POST',b).then(function(x){ if(x.j.ok){ setMsg('umsg','Account created. Share the email and initial password with the doctor.',true); document.getElementById('fn').value='';document.getElementById('ln').value='';document.getElementById('em').value='';document.getElementById('pw').value='';document.getElementById('nv').value=''; loadUsers(); } else { setMsg('umsg',x.j.error||'Failed',false); } }); };

// --- full account editor ---
var edModal=document.getElementById('edModal'); var edCur=null, edTagList=[];
function renderEdTags(){ var c=document.getElementById('edTags'); if(!edTagList.length){ c.innerHTML='<span class="note">no tags yet</span>'; return; } c.innerHTML=edTagList.map(function(t,i){ return '<span class="edtag">'+esc(t)+'<button data-i="'+i+'" type="button">×</button></span>'; }).join(''); var bs=c.querySelectorAll('button'); for(var i=0;i<bs.length;i++){ bs[i].onclick=function(){ edTagList.splice(parseInt(this.getAttribute('data-i'),10),1); renderEdTags(); }; } }
function openEditor(u){ if(!u)return; edCur=u; document.getElementById('edMsg').textContent=''; document.getElementById('edNote').textContent='';
 document.getElementById('edFn').value=u.given||''; document.getElementById('edLn').value=u.family||'';
 document.getElementById('edEmail').value=u.email||''; document.getElementById('edPhone').value=u.phone||'';
 document.getElementById('edNt').value=u.nidType||'Fayda-ET'; document.getElementById('edNv').value=u.nidValue||'';
 var rs=document.getElementById('edRole'); rs.innerHTML='<option value="doctor">Doctor</option><option value="admin">Admin</option>'+((ME_DEV||u.role==='developer')?'<option value="developer">Developer</option>':''); rs.value=u.role||'doctor';
 document.getElementById('edActive').checked=u.active!==false;
 edTagList=(u.tags||[]).slice(); renderEdTags();
 edModal.classList.add('show'); }
function closeEditor(){ edModal.classList.remove('show'); }
function saveEditor(){ if(!edCur)return; var msg=document.getElementById('edMsg'); msg.className='msg'; msg.style.color='var(--muted)'; msg.textContent='Saving…';
 var b={ membershipId:edCur.id, profile:edCur.profile, firstName:document.getElementById('edFn').value, lastName:document.getElementById('edLn').value, email:document.getElementById('edEmail').value, phone:document.getElementById('edPhone').value, nidType:document.getElementById('edNt').value, nidValue:document.getElementById('edNv').value, role:document.getElementById('edRole').value, active:document.getElementById('edActive').checked, tags:edTagList };
 pj('/admin/users/edit','POST',b).then(function(x){ if(x.j.ok){ msg.style.color='var(--green2)'; msg.textContent='Saved.'+((x.j.notes&&x.j.notes.length)?(' ('+x.j.notes.join('; ')+')'):''); loadUsers(); setTimeout(closeEditor,(x.j.notes&&x.j.notes.length)?2400:700); } else { msg.style.color='#c0392b'; msg.textContent=x.j.error||'Save failed'; } }).catch(function(){ msg.style.color='#c0392b'; msg.textContent='Could not reach the server.'; }); }
document.getElementById('edTagAdd').onclick=function(){ var v=document.getElementById('edTagNew').value.trim(); if(!v)return; edTagList.push(v); document.getElementById('edTagNew').value=''; renderEdTags(); };
document.getElementById('edTagNew').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('edTagAdd').click(); } });
document.getElementById('edCancel').onclick=closeEditor; document.getElementById('edSave').onclick=saveEditor;
edModal.addEventListener('click',function(e){ if(e.target===edModal) closeEditor(); });

function loadConfig(){ gj('/admin/config').then(function(x){ if(!x.j.ok)return; document.getElementById('sysp').value=x.j.systemPrompt; document.getElementById('quickp').value=x.j.quickPrompt;
 var ms=document.getElementById('model'); ms.innerHTML=''; x.j.models.forEach(function(m){ var o=document.createElement('option');o.value=m;o.textContent=m;if(m===x.j.model)o.selected=true;ms.appendChild(o); });
 var vs=document.getElementById('voice'); vs.innerHTML=''; x.j.voices.forEach(function(v){ var o=document.createElement('option');o.value=v;o.textContent=v;if(v===x.j.voice)o.selected=true;vs.appendChild(o); });
 }); }
document.getElementById('savep').onclick=function(){ pj('/admin/config','POST',{systemPrompt:document.getElementById('sysp').value,quickPrompt:document.getElementById('quickp').value}).then(function(x){ setMsg('pmsg',x.j.ok?'Saved.':(x.j.error||'Failed'),x.j.ok); }); };
document.getElementById('resetp').onclick=function(){ if(!confirm('Restore the original safe prompts? Your edits will be replaced.'))return; pj('/admin/config/reset','POST').then(function(x){ if(x.j.ok){ setMsg('pmsg','Restored safe defaults.',true); loadConfig(); } else setMsg('pmsg',x.j.error||'Failed',false); }); };
document.getElementById('savemv').onclick=function(){ pj('/admin/config','POST',{model:document.getElementById('model').value,voice:document.getElementById('voice').value}).then(function(x){ setMsg('mvmsg',x.j.ok?'Saved.':(x.j.error||'Failed'),x.j.ok); }); };

function loadAudit(){ gj('/admin/audit?limit=100').then(function(x){ var tb=document.querySelector('#atable tbody'); tb.innerHTML=''; if(!x.j.ok)return;
 x.j.entries.forEach(function(e){ var tr=document.createElement('tr'); var t=new Date(e.ts); tr.innerHTML='<td>'+esc(t.toLocaleString())+'</td><td>'+esc(e.user||'')+'</td><td>'+esc(e.mode||'')+'</td><td>'+esc(e.q||'')+'</td>'; tb.appendChild(tr); }); }); }

document.getElementById('signout').onclick=function(e){ e.preventDefault(); fetch('/logout',{method:'POST'}).then(function(){ location.href='/'; }); };

// gate: admins & developers only; AI settings cards are Developer-only
var ME_DEV=false;
gj('/me').then(function(x){ if(x.status!==200||!x.j.ok||!x.j.isAdmin){ document.getElementById('gate').innerHTML='This area is for admins and developers. <a href="/">Back to chat</a>'; return; }
 ME_DEV = x.j.isDeveloper===true;
 var h1=document.querySelector('header h1'); if(h1) h1.textContent='Dr. Elroi · '+(ME_DEV?'Developer':'Admin');
 if(ME_DEV){ var rs=document.getElementById('role'); if(rs && !Array.prototype.some.call(rs.options,function(o){return o.value==='developer';})){ var o=document.createElement('option');o.value='developer';o.textContent='Developer';rs.appendChild(o); }
  document.getElementById('cardPrompts').style.display=''; document.getElementById('cardModel').style.display=''; }
 document.getElementById('gate').style.display='none'; document.getElementById('main').style.display=''; loadUsers(); loadAudit(); if(ME_DEV) loadConfig();
}).catch(function(){ document.getElementById('gate').innerHTML='This area is for admins and developers. <a href="/">Back to chat</a>'; });
</script></body></html>`;

// --- HTTP server ---
createServer(async (req, res) => {
  // Gate helper: returns the live session or writes a 401 (and returns null) for protected routes.
  const requireSession = () => {
    const s = sessionGet(sidFromReq(req));
    if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth_required' })); return null; }
    return s;
  };
  // Admin gate: must be a logged-in admin. Used by every /admin/* data route.
  const requireAdmin = () => {
    const s = sessionGet(sidFromReq(req));
    if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth_required' })); return null; }
    if (!s.isAdmin) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'admin_only' })); return null; }
    return s;
  };
  // Developer gate: AI settings (prompts/model/voice) are Developer-only.
  const requireDeveloper = () => {
    const s = sessionGet(sidFromReq(req));
    if (!s) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth_required' })); return null; }
    if (!s.isDeveloper) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'developer_only' })); return null; }
    return s;
  };
  const readJsonBody = () => new Promise(resolve => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    return res.end(PAGE);
  }
  // --- auth routes (public) ---
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let email = '', password = '';
      try { const j = JSON.parse(body || '{}'); email = j.email || ''; password = j.password || ''; } catch {}
      try {
        const result = await doLogin(email, password);            // never log body/credentials
        const sid = sessionCreate(result);
        setSessionCookie(res, sid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, isAdmin: result.isAdmin, displayName: result.displayName }));
      } catch (e) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_login' })); // generic on purpose
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/logout') {
    sessionDestroy(sidFromReq(req));
    clearSessionCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // --- who am I (gated; also the on-load "am I logged in?" probe) ---
  if (req.method === 'GET' && req.url === '/me') {
    const session = requireSession(); if (!session) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, isAdmin: session.isAdmin, isDeveloper: session.isDeveloper, role: session.role, displayName: session.displayName, profileRef: session.profileRef }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/speak')) {
    const session = requireSession(); if (!session) return;
    let text = '', speed = 1.0;
    try { const u = new URL(req.url, 'http://x'); text = (u.searchParams.get('text') || '').slice(0, 1500); speed = parseFloat(u.searchParams.get('speed') || '1') || 1; } catch (e) {}
    if (!text) { res.writeHead(400); return res.end('no text'); }
    const sendWav = buf => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); res.end(buf); };
    kokoroSpeak(text, speed, runtime.voice)
      .then(sendWav)
      .catch(e => { res.writeHead(500); res.end(String((e && e.message) || e)); });
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    const session = requireSession(); if (!session) return;
    try {
      let token = await sessionToken(session);
      let b;
      try {
        b = await fhir(token, 'Patient?_summary=count');
      } catch (err) {
        // token may have just expired — refresh once and retry
        if (await refresh(session)) { b = await fhir(session.accessToken, 'Patient?_summary=count'); }
        else throw err;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, patients: b.total ?? 0, model: runtime.model }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  // List patients (id + name) for the "Add to chart" picker — scoped to the user's access.
  if (req.method === 'GET' && req.url === '/patients') {
    const session = requireSession(); if (!session) return;
    try {
      const token = await sessionToken(session);
      const b = await fhir(token, 'Patient?_count=200&_sort=family');
      const list = (b.entry || []).map(e => e.resource).map(p => {
        const n = (p.name || [])[0] || {};
        const name = (((n.given || []).join(' ') + ' ' + (n.family || '')).trim() || '(unnamed)');
        const nid = readNid(p);
        const phone = ((p.telecom || []).find(t => t.system === 'phone') || {}).value || '';
        const email = ((p.telecom || []).find(t => t.system === 'email') || {}).value || '';
        // identify by unique ID first: prefer Fayda/National ID, then phone, then fall back to name
        var idtag = nid.nidValue ? (nid.nidType + ' ' + nid.nidValue) : (phone ? ('\u260e ' + phone) : '');
        const label = idtag ? (name + ' · ' + idtag) : name;
        // a single lowercase string the UI can search across (name, phone, email, every identifier)
        const allIds = (p.identifier || []).map(i => i.value || '').join(' ');
        const search = (name + ' ' + phone + ' ' + email + ' ' + nid.nidType + ' ' + nid.nidValue + ' ' + allIds).toLowerCase();
        return { id: p.id, name, nidType: nid.nidType, nidValue: nid.nidValue, phone, email, label, search };
      });
      return sendJson(200, { ok: true, patients: list });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Register a new patient. A doctor is auto-assigned as the patient's general practitioner (so they can see them).
  if (req.method === 'POST' && req.url === '/patients') {
    const session = requireSession(); if (!session) return;
    const j = await readJsonBody();
    const given = (j.given || '').trim(), family = (j.family || '').trim();
    if (!given && !family) return sendJson(400, { ok: false, error: 'enter a name' });
    const patient = { resourceType: 'Patient', name: [{ given: given ? given.split(/\s+/) : [], family }] };
    if (j.gender) patient.gender = j.gender;
    if (j.birthDate) patient.birthDate = j.birthDate;
    // unique identifiers: Fayda/National ID (FHIR identifier) and phone (telecom)
    const nidType = (j.nidType || 'Fayda-ET').trim(), nidValue = (j.nidValue || '').trim(), phone = (j.phone || '').trim();
    if (nidValue) setNid(patient, nidType, nidValue);
    if (phone) patient.telecom = [{ system: 'phone', value: phone }];
    // assign a doctor: a doctor registering -> themselves; an admin may pass assignTo
    const gp = [];
    if (session.role === 'doctor' && session.profileRef) gp.push({ reference: session.profileRef });
    else if (session.isAdmin && (j.assignTo || '').startsWith('Practitioner/')) gp.push({ reference: j.assignTo });
    if (gp.length) patient.generalPractitioner = gp;
    try {
      const token = await sessionToken(session);
      // reject a duplicate National ID (best-effort)
      if (nidValue) { try { const b = await fhir(token, 'Patient?identifier=' + encodeURIComponent(NID_SYS + nidType + '|' + nidValue)); if ((b.entry || []).length) return sendJson(200, { ok: false, error: 'A patient with that National ID already exists.' }); } catch (e) {} }
      const r = await fetch(`${CFG.medplum}/fhir/R4/Patient`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(patient) });
      if (!r.ok) { const t = await r.text(); return sendJson(200, { ok: false, error: 'register failed: ' + r.status + ' ' + t.slice(0, 160) }); }
      return sendJson(200, { ok: true, id: (await r.json()).id });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // List clinicians (all practitioner accounts) for the "assign doctor" picker — any clinician can be a patient's GP.
  if (req.method === 'GET' && req.url === '/admin/doctors') {
    const session = requireAdmin(); if (!session) return;
    try {
      const token = await sessionToken(session);
      // base on real accounts (memberships), so orphaned/standalone Practitioner records don't appear
      const bundle = await fhir(token, 'ProjectMembership?_count=200');
      const mems = (bundle.entry || []).map(e => e.resource).filter(m => (m.profile?.reference || '').startsWith('Practitioner/') && m.active !== false);
      const docs = [];
      for (const m of mems) {
        const ref = m.profile.reference;
        let name = '', role = '';
        try { const p = await fhir(token, ref); const n = (p.name || [])[0] || {}; name = ((n.given || []).join(' ') + ' ' + (n.family || '')).trim(); role = readRole(p); } catch (e) {}
        if (!role) role = (m.admin === true) ? 'admin' : 'doctor';
        docs.push({ ref, name: name || '(unnamed)', role });
      }
      return sendJson(200, { ok: true, doctors: docs });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Admin: grant/revoke a doctor's access to a patient by editing Patient.generalPractitioner.
  if (req.method === 'POST' && req.url === '/admin/patient/gp') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const patient = (j.patient || '').trim(), practitioner = (j.practitioner || '').trim(), action = j.action;
    if (!patient.startsWith('Patient/') || !practitioner.startsWith('Practitioner/') || (action !== 'add' && action !== 'remove')) return sendJson(400, { ok: false, error: 'need patient, practitioner, action' });
    try {
      const token = await sessionToken(session);
      const p = await fhir(token, patient);
      let gp = (p.generalPractitioner || []).filter(g => (g.reference || '') !== practitioner);
      if (action === 'add') gp.push({ reference: practitioner });
      p.generalPractitioner = gp;
      const r = await fetch(`${CFG.medplum}/fhir/R4/${patient}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(p) });
      if (!r.ok) { const t = await r.text(); return sendJson(200, { ok: false, error: 'update failed: ' + r.status + ' ' + t.slice(0, 160) }); }
      return sendJson(200, { ok: true });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Give an EXISTING patient a login (Medplum app), scoped to their own record by the patient policy.
  if (req.method === 'POST' && req.url === '/admin/patients/login') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const patient = (j.patient || '').trim(), email = (j.email || '').trim(), password = j.password || '';
    if (!patient.startsWith('Patient/') || !email || password.length < 8) return sendJson(400, { ok: false, error: 'need patient, email, and password (min 8 chars)' });
    if (!session.projectId) return sendJson(400, { ok: false, error: 'no_project' });
    try {
      const token = await sessionToken(session);
      // read the patient's name for the invite (required fields), and confirm it exists / is accessible
      let firstName = 'Patient', lastName = 'User';
      try { const p = await fhir(token, patient); const n = (p.name || [])[0] || {}; firstName = (n.given || [])[0] || firstName; lastName = n.family || lastName; } catch (e) { return sendJson(200, { ok: false, error: 'patient not found' }); }
      const policyRef = await ensurePatientPolicy(token);
      const r = await fetch(`${CFG.medplum}/admin/projects/${session.projectId}/invite`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ resourceType: 'Patient', firstName, lastName, email, password, sendEmail: false, membership: { profile: { reference: patient }, accessPolicy: { reference: policyRef } } }),
      });
      if (!r.ok) { const t = await r.text(); return sendJson(200, { ok: false, error: 'login create failed: ' + r.status + ' ' + t.slice(0, 200) }); }
      return sendJson(200, { ok: true, email });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Full account editor: update name, phone, National ID, role, tags, status, and login email in one go.
  if (req.method === 'POST' && req.url === '/admin/users/edit') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const profile = (j.profile || '').trim(), membershipId = (j.membershipId || '').trim();
    if (!profile.startsWith('Practitioner/')) return sendJson(400, { ok: false, error: 'need profile' });
    const role = ROLES.includes(j.role) ? j.role : null;
    const notes = [];
    try {
      const token = await sessionToken(session);
      // 1) Practitioner: name, phone, National ID, role tag, profile tags (read-modify-write whole resource)
      const p = await fhir(token, profile);
      const fn = (j.firstName || '').trim(), ln = (j.lastName || '').trim();
      if (fn || ln) p.name = [{ given: fn ? fn.split(/\s+/) : [], family: ln }];
      const phone = (j.phone || '').trim();
      p.telecom = (p.telecom || []).filter(t => t.system !== 'phone'); if (phone) p.telecom.push({ system: 'phone', value: phone });
      setNid(p, (j.nidType || 'Fayda-ET').trim(), (j.nidValue || '').trim());
      if (role) setRole(p, role);
      setTags(p, Array.isArray(j.tags) ? j.tags : readTags(p));
      const pr = await fetch(`${CFG.medplum}/fhir/R4/${profile}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(p) });
      if (!pr.ok) { const t = await pr.text(); return sendJson(200, { ok: false, error: 'profile update failed: ' + pr.status + ' ' + t.slice(0, 140) }); }
      // 2) Membership: admin flag, active status, access policy — must send the FULL resource
      let userRef = '';
      if (membershipId && session.projectId) {
        try {
          const mem = await fhir(token, 'ProjectMembership/' + membershipId);
          userRef = mem.user?.reference || '';
          if (role) mem.admin = (role === 'admin' || role === 'developer');
          if (typeof j.active === 'boolean') mem.active = j.active;
          if (role === 'doctor') { try { mem.access = [{ policy: { reference: await ensureDoctorPolicy(token) } }]; } catch (e) {} }
          else if (role) { delete mem.access; delete mem.accessPolicy; }
          const mr = await fetch(`${CFG.medplum}/admin/projects/${session.projectId}/members/${membershipId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(mem) });
          if (!mr.ok) notes.push('role/status not changed (normal for the project owner)');
        } catch (e) { notes.push('membership unchanged'); }
      }
      // 3) Login email — only if it actually changed (skip verification: offline, no SMTP)
      const email = (j.email || '').trim();
      if (email && userRef.startsWith('User/')) {
        try {
          const u = await fhir(token, userRef);
          if ((u.email || '') !== email) {
            const er = await fetch(`${CFG.medplum}/fhir/R4/${userRef}/$update-email`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'email', valueString: email }, { name: 'skipEmailVerification', valueBoolean: true }, { name: 'updateProfileTelecom', valueBoolean: false }] }) });
            if (!er.ok) notes.push('email not changed (' + er.status + ')');
          }
        } catch (e) { notes.push('email not changed'); }
      }
      return sendJson(200, { ok: true, notes });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Add a clinical record to a patient's chart (human-entered by the clinician; never AI-generated).
  if (req.method === 'POST' && req.url === '/chart') {
    const session = requireSession(); if (!session) return;
    const j = await readJsonBody();
    const patient = (j.patient || '').trim(), kind = (j.kind || '').trim();
    if (!patient.startsWith('Patient/') || !kind) return sendJson(400, { ok: false, error: 'need patient and kind' });
    const resource = buildClinical(patient, kind, { value: j.value, dosage: j.dosage, measure: j.measure, unit: j.unit });
    if (!resource) return sendJson(400, { ok: false, error: 'enter the required detail for this record type' });
    try {
      const token = await sessionToken(session);
      const saved = await postResource(token, resource);
      return sendJson(200, { ok: true, id: saved.id, resourceType: saved.resourceType });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // AI scribe — PROPOSE structured items from a dictated/typed narrative. Writes NOTHING.
  if (req.method === 'POST' && req.url === '/scribe') {
    const session = requireSession(); if (!session) return;
    const j = await readJsonBody();
    const text = String(j.text || '').trim();
    if (!text) return sendJson(400, { ok: false, error: 'enter or dictate the visit note first' });
    try {
      const proposal = await scribeExtract(text);
      auditLog({ user: session.displayName, profileRef: session.profileRef, mode: 'scribe-extract', q: text.slice(0, 500) });
      return sendJson(200, { ok: true, proposal });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // AI scribe — COMMIT only the clinician-approved items to the patient's chart.
  if (req.method === 'POST' && req.url === '/scribe/commit') {
    const session = requireSession(); if (!session) return;
    const j = await readJsonBody();
    const patient = (j.patient || '').trim();
    if (!patient.startsWith('Patient/')) return sendJson(400, { ok: false, error: 'pick a patient' });
    const items = [];
    (Array.isArray(j.conditions) ? j.conditions : []).forEach(v => items.push(buildClinical(patient, 'condition', { value: v })));
    (Array.isArray(j.medications) ? j.medications : []).forEach(m => items.push(buildClinical(patient, 'medication', { value: m && m.name, dosage: m && m.dosage })));
    (Array.isArray(j.allergies) ? j.allergies : []).forEach(v => items.push(buildClinical(patient, 'allergy', { value: v })));
    (Array.isArray(j.vitals) ? j.vitals : []).forEach(v => items.push(buildClinical(patient, 'observation', { value: v && v.name, measure: v && v.value, unit: v && v.unit })));
    const resources = items.filter(Boolean);
    if (!resources.length) return sendJson(400, { ok: false, error: 'nothing approved to save' });
    try {
      const token = await sessionToken(session);
      let saved = 0; const errors = [];
      for (const res of resources) { try { await postResource(token, res); saved++; } catch (e) { errors.push(String(e.message || e)); } }
      auditLog({ user: session.displayName, profileRef: session.profileRef, mode: 'scribe-commit', q: 'saved ' + saved + ' item(s) to ' + patient });
      return sendJson(200, { ok: errors.length === 0, saved, errors });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // View one patient's full chart (structured, with refs for removal)
  if (req.method === 'GET' && req.url.startsWith('/chart')) {
    const session = requireSession(); if (!session) return;
    let pid = '';
    try { const u = new URL(req.url, 'http://x'); pid = (u.searchParams.get('patient') || '').replace(/^Patient\//, ''); } catch (e) {}
    if (!pid) return sendJson(400, { ok: false, error: 'need patient' });
    try { const token = await sessionToken(session); return sendJson(200, await buildPatientChart(token, pid)); }
    catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Remove a clinical entry from a chart (whitelisted resource types only)
  if (req.method === 'DELETE' && req.url.startsWith('/chart')) {
    const session = requireSession(); if (!session) return;
    let ref = '';
    try { const u = new URL(req.url, 'http://x'); ref = (u.searchParams.get('ref') || '').trim(); } catch (e) {}
    const ALLOWED = ['Condition', 'MedicationRequest', 'AllergyIntolerance', 'Observation', 'DiagnosticReport', 'Procedure', 'Immunization', 'Encounter', 'ServiceRequest'];
    if (!ALLOWED.some(t => ref.startsWith(t + '/'))) return sendJson(400, { ok: false, error: 'bad ref' });
    try {
      const token = await sessionToken(session);
      const r = await fetch(`${CFG.medplum}/fhir/R4/${ref}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      return sendJson(200, { ok: r.ok });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  if (req.method === 'POST' && req.url === '/ask') {
    const session = requireSession(); if (!session) return; // gate BEFORE streaming headers
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let question = '', history = [];
      try {
        const j = JSON.parse(body || '{}');
        question = j.question || '';
        if (Array.isArray(j.history)) history = j.history;
      } catch {}
      // keep only valid, recent turns (memory window)
      history = history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-8);
      const mode = classifyQuery(question);
      auditLog({ user: session.displayName, profileRef: session.profileRef, mode, q: String(question).slice(0, 500) });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      try {
        if (mode === 'quick') {
          // Conversational: no EMR fetch, warm + brief.
          const messages = [{ role: 'system', content: runtime.quickPrompt }, ...history, { role: 'user', content: question }];
          await streamAnswer(res, messages, { temperature: 0.5, num_predict: 400 });
        } else {
          // Clinical: include patient records in the system context, plus conversation memory.
          // Uses the logged-in user's own token, so Medplum scopes the records to what they may see.
          const token = await sessionToken(session);
          const emr = await buildEmrContext(token);
          const sys = runtime.systemPrompt + `\n\n=== PATIENT RECORDS (use only when the question is about a patient) ===\n${emr.text}`;
          const messages = [{ role: 'system', content: sys }, ...history, { role: 'user', content: question }];
          // num_ctx gives enough room for the system prompt + records + a complete answer (prevents mid-answer truncation).
          await streamAnswer(res, messages, { temperature: 0.3, num_ctx: 8192 });
        }
      } catch (e) {
        try { res.write('\n\n[Sorry — ' + String(e.message || e) + ']'); } catch (_) {}
        try { res.end(); } catch (_) {}
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/avatar') {
    const a = await loadAvatar();
    if (!a) { res.writeHead(404); return res.end('no avatar'); }
    res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'no-cache' });
    return res.end(a.data);
  }

  // ===================== ADMIN PANEL =====================
  // The /admin page is plain HTML (self-gates via /me); every /admin/* DATA route is admin-only.
  if (req.method === 'GET' && req.url === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    return res.end(ADMIN_PAGE);
  }
  // --- accounts ---
  if (req.method === 'GET' && req.url === '/admin/users') {
    const session = requireAdmin(); if (!session) return;
    try {
      const token = await sessionToken(session);
      const bundle = await fhir(token, 'ProjectMembership?_count=200');
      const entries = (bundle.entry || []).map(e => e.resource).filter(Boolean);
      // resolve practitioner display names
      const users = [];
      for (const m of entries) {
        const ref = m.profile?.reference || '';
        if (!ref.startsWith('Practitioner/')) continue; // skip machine ClientApplication / non-people
        let name = '', given = '', family = '', email = '', nid = { nidType: '', nidValue: '' }, role = '', phone = '', tags = [];
        try { const p = await fhir(token, ref); const n = (p.name && p.name[0]) || {}; given = (n.given || []).join(' '); family = n.family || ''; name = (given + ' ' + family).trim(); nid = readNid(p); role = readRole(p); phone = ((p.telecom || []).find(t => t.system === 'phone') || {}).value || ''; tags = readTags(p); } catch (e) {}
        if (!role) role = (m.admin === true) ? 'admin' : 'doctor';
        const uref = m.user?.reference || '';
        if (uref) { try { const u = await fhir(token, uref); email = u.email || ''; } catch (e) {} } // email may be restricted — best effort
        const shortId = ref.split('/')[1] ? ref.split('/')[1].slice(0, 8) : '';
        users.push({ id: m.id, name: name || '(no name)', given, family, email, phone, tags, shortId, nidType: nid.nidType, nidValue: nid.nidValue, role, admin: m.admin === true, active: m.active !== false, profile: ref });
      }
      return sendJson(200, { ok: true, users });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  if (req.method === 'POST' && req.url === '/admin/users') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const firstName = (j.firstName || '').trim(), lastName = (j.lastName || '').trim(), email = (j.email || '').trim(), password = j.password || '';
    const nidType = (j.nidType || 'Fayda-ET').trim(), nidValue = (j.nidValue || '').trim();
    let role = ROLES.includes(j.role) ? j.role : 'doctor';
    if (!firstName || !lastName || !email || password.length < 8) return sendJson(400, { ok: false, error: 'need firstName, lastName, email, and password (min 8 chars)' });
    if (!session.projectId) return sendJson(400, { ok: false, error: 'no_project' });
    try {
      const token = await sessionToken(session);
      if (nidValue && await nidExists(token, nidType, nidValue, null)) return sendJson(200, { ok: false, error: 'That National ID is already assigned to another account.' });
      const elevated = (role === 'admin' || role === 'developer'); // admins & developers need Medplum admin rights
      const membership = { admin: elevated };
      // limit doctor to own patients — if the policy can't be set, ABORT (never create an unscoped doctor)
      if (role === 'doctor') membership.access = [{ policy: { reference: await ensureDoctorPolicy(token) } }];
      const r = await fetch(`${CFG.medplum}/admin/projects/${session.projectId}/invite`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ resourceType: 'Practitioner', firstName, lastName, email, password, sendEmail: false, membership }),
      });
      if (!r.ok) { const t = await r.text(); return sendJson(200, { ok: false, error: 'create failed: ' + r.status + ' ' + t.slice(0, 200) }); }
      // attach role tag + National ID to the freshly-created Practitioner (invite body doesn't carry identifiers)
      try {
        const mem = await r.json(); const pref = mem.profile?.reference;
        if (pref && pref.startsWith('Practitioner/')) {
          const p = await fhir(token, pref); setRole(p, role); if (nidValue) setNid(p, nidType, nidValue);
          await fetch(`${CFG.medplum}/fhir/R4/${pref}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(p) });
        }
      } catch (e) {}
      return sendJson(200, { ok: true });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Rename a doctor: updates the Practitioner.name in Medplum (the single source of truth → propagates everywhere).
  if (req.method === 'POST' && req.url === '/admin/users/rename') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const profile = (j.profile || '').trim(), firstName = (j.firstName || '').trim(), lastName = (j.lastName || '').trim();
    if (!profile.startsWith('Practitioner/') || !firstName || !lastName) return sendJson(400, { ok: false, error: 'need profile, firstName, lastName' });
    try {
      const token = await sessionToken(session);
      const p = await fhir(token, profile);                 // read current resource
      p.name = [{ given: firstName.split(/\s+/), family: lastName }]; // replace name
      const r = await fetch(`${CFG.medplum}/fhir/R4/${profile}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(p),
      });
      if (!r.ok) { const t = await r.text(); return sendJson(200, { ok: false, error: 'rename failed: ' + r.status + ' ' + t.slice(0, 160) }); }
      return sendJson(200, { ok: true });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Change an account's role (doctor/admin/developer): updates the profile role tag AND the Medplum admin flag.
  if (req.method === 'POST' && req.url === '/admin/users/role') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const profile = (j.profile || '').trim(), membershipId = (j.membershipId || '').trim(), role = j.role;
    if (!profile.startsWith('Practitioner/') || !ROLES.includes(role)) return sendJson(400, { ok: false, error: 'need profile and a valid role' });
    try {
      const token = await sessionToken(session);
      // 1) role tag on the Practitioner (this is what the app uses for access control)
      const p = await fhir(token, profile); setRole(p, role);
      const pr = await fetch(`${CFG.medplum}/fhir/R4/${profile}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(p) });
      if (!pr.ok) { const t = await pr.text(); return sendJson(200, { ok: false, error: 'role tag failed: ' + pr.status + ' ' + t.slice(0, 140) }); }
      // 2) Best-effort: align the Medplum admin flag (admins & developers are project admins).
      // May be Forbidden for the project owner/self — harmless since the role tag is what the app uses.
      let note = '';
      try {
        const elevated = (role === 'admin' || role === 'developer');
        const mem = membershipId ? await fhir(token, 'ProjectMembership/' + membershipId) : null;
        if (mem) {
          mem.admin = elevated;
          // doctors get the own-patients access policy; admins/developers get unrestricted access (no policy)
          if (role === 'doctor') mem.access = [{ policy: { reference: await ensureDoctorPolicy(token) } }];
          else { delete mem.access; delete mem.accessPolicy; }
          const mr = await fetch(`${CFG.medplum}/admin/projects/${session.projectId}/members/${membershipId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(mem) });
          if (!mr.ok) note = 'Role set, but Medplum permissions were not changed (normal for the project owner).';
        }
      } catch (e) { note = 'Role set; permission flag unchanged.'; }
      return sendJson(200, { ok: true, note });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // Set / update / clear a profile's National ID (e.g. Fayda-ET). Empty value clears it.
  if (req.method === 'POST' && req.url === '/admin/users/nid') {
    const session = requireAdmin(); if (!session) return;
    const j = await readJsonBody();
    const profile = (j.profile || '').trim(), nidType = (j.nidType || 'Fayda-ET').trim(), nidValue = (j.nidValue || '').trim();
    if (!profile.startsWith('Practitioner/')) return sendJson(400, { ok: false, error: 'need profile' });
    try {
      const token = await sessionToken(session);
      if (nidValue && await nidExists(token, nidType, nidValue, profile)) return sendJson(200, { ok: false, error: 'That National ID is already assigned to another account.' });
      const p = await fhir(token, profile); setNid(p, nidType, nidValue);
      const r = await fetch(`${CFG.medplum}/fhir/R4/${profile}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(p) });
      if (!r.ok) { const t = await r.text(); return sendJson(200, { ok: false, error: 'save failed: ' + r.status + ' ' + t.slice(0, 160) }); }
      return sendJson(200, { ok: true });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  if (req.method === 'DELETE' && req.url.startsWith('/admin/users/')) {
    const session = requireAdmin(); if (!session) return;
    const mid = decodeURIComponent(req.url.slice('/admin/users/'.length));
    if (!session.projectId || !mid) return sendJson(400, { ok: false, error: 'bad_request' });
    try {
      const token = await sessionToken(session);
      // capture the profile first so we can also remove the Practitioner record (avoid orphans)
      let profileRef = '';
      try { const mem = await fhir(token, 'ProjectMembership/' + mid); profileRef = mem.profile?.reference || ''; } catch (e) {}
      const r = await fetch(`${CFG.medplum}/admin/projects/${session.projectId}/members/${mid}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      // best-effort: delete the now-orphaned Practitioner profile too
      if (r.ok && profileRef.startsWith('Practitioner/')) { try { await fetch(`${CFG.medplum}/fhir/R4/${profileRef}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); } catch (e) {} }
      return sendJson(200, { ok: r.ok });
    } catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // --- config (prompts / model / voice) — Developer only ---
  if (req.method === 'GET' && req.url === '/admin/config') {
    const session = requireDeveloper(); if (!session) return;
    let models = [];
    try { const t = await fetch(`${CFG.ollama}/api/tags`); if (t.ok) { const j = await t.json(); models = (j.models || []).map(m => m.name); } } catch (e) {}
    if (!models.includes(runtime.model)) models.unshift(runtime.model);
    return sendJson(200, { ok: true, systemPrompt: runtime.systemPrompt, quickPrompt: runtime.quickPrompt, model: runtime.model, voice: runtime.voice, models, voices: VOICE_CHOICES });
  }
  if (req.method === 'POST' && req.url === '/admin/config') {
    const session = requireDeveloper(); if (!session) return;
    const j = await readJsonBody();
    const patch = {};
    if (typeof j.systemPrompt === 'string' && j.systemPrompt.trim()) patch.systemPrompt = j.systemPrompt;
    if (typeof j.quickPrompt === 'string' && j.quickPrompt.trim()) patch.quickPrompt = j.quickPrompt;
    if (typeof j.model === 'string' && j.model) patch.model = j.model;
    if (typeof j.voice === 'string' && j.voice) patch.voice = j.voice;
    try { await saveConfig(patch); return sendJson(200, { ok: true }); }
    catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  if (req.method === 'POST' && req.url === '/admin/config/reset') {
    const session = requireDeveloper(); if (!session) return;
    try { await saveConfig({ ...DEFAULTS }); return sendJson(200, { ok: true }); }
    catch (e) { return sendJson(200, { ok: false, error: String(e.message || e) }); }
  }
  // --- usage / audit log ---
  if (req.method === 'GET' && req.url.startsWith('/admin/audit')) {
    const session = requireAdmin(); if (!session) return;
    let limit = 100; try { const u = new URL(req.url, 'http://x'); limit = Math.min(500, parseInt(u.searchParams.get('limit') || '100', 10) || 100); } catch (e) {}
    return sendJson(200, { ok: true, entries: await readAudit(limit) });
  }

  res.writeHead(404); res.end('not found');
}).listen(CFG.port, async () => {
  await loadConfig(); // load any admin-saved prompts/model/voice (falls back to safe defaults)
  console.log(`Dr. Elroi connector running at http://localhost:${CFG.port}`);
});
