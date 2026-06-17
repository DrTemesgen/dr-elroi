# Deploys the Spaces AI bots + Dr. Elroi system prompts into the Elroi project.
# Idempotent: re-running updates code and prompts in place.
import json, urllib.request, urllib.error, hashlib, base64, secrets, pathlib, sys

BASE = "http://localhost:8103"

# Credentials are loaded from connector/.env (git-ignored) — never hard-code them here.
import os
def _load_env():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass
_load_env()
ELROI_EMAIL = os.environ.get("ELROI_EMAIL", "")
ELROI_PASSWORD = os.environ.get("ELROI_PASSWORD", "")

PROJECT_ID = "3a8016cf-e6dc-4574-8601-639237694c9d"  # Elroi
ROOT = pathlib.Path(r"D:\Software Engineering\Dr. Ubuntu\medplum\examples\medplum-demo-bots\dist\spaces-bots")

BOTS = [
    # (identifier value, bot name, dist file)
    ("ai-fhir-request-tools", "Dr. Elroi Spaces - FHIR Translator", "fhir-translator-bot.js"),
    ("ai-resource-summary", "Dr. Elroi Spaces - Summary", "fhir-summary-bot.js"),
    ("ai-resource-summary-sse", "Dr. Elroi Spaces - Summary (SSE)", "fhir-summary-bot.js"),
    ("ai-component-generator-sse", "Dr. Elroi Spaces - Chart Generator (SSE)", "fhir-visualizer-bot.js"),
]

TRANSLATOR_PROMPT = """You are Dr. Elroi's data assistant inside an EMR used by healthcare workers across Africa. Your ONLY job is to satisfy the user's request by making FHIR R4 requests with the fhir_request tool, then stop.

Rules:
- You MUST use the fhir_request tool for every data operation. You cannot answer from memory and you must never invent patient data or resource ids.
- Strategy: resolve patients first (GET Patient?name=<name> or Patient?identifier=<id>), then query within that patient, e.g. GET Observation?subject=Patient/<id>&_sort=-date&_count=20, Condition?subject=..., MedicationRequest?subject=..., AllergyIntolerance?patient=..., Encounter?subject=...
- Prefer small focused queries (_count=20, _sort=-date) over broad dumps.
- When the user asks for a chart/graph/plot/trend, set the SEPARATE tool argument visualize=true on the relevant fhir_request call, e.g. {"method":"GET","path":"Observation?subject=Patient/<id>&_sort=-date","visualize":true}. NEVER put visualize inside the path or query string — it is not a FHIR search parameter.
- For writes: POST to create; for updates GET the resource first, modify it, then PUT the COMPLETE resource. Only write what the user explicitly asked for.
- When you have enough data to answer, stop calling tools so the conversation can be summarized.
- If a request fails or returns nothing, try one sensible alternative query, then report what you found honestly."""

TRANSLATOR_PROFILE_TEMPLATE = "\n\nThe signed-in clinician making this request is {{ref}}. Add the filter general-practitioner={{ref}} ONLY when the user explicitly asks about 'my patients' or their own panel. When the user names a specific patient, search by name alone (GET Patient?name=<name>) without practitioner filters. If a filtered search returns zero results, retry once without the extra filters before concluding the record does not exist."

SUMMARY_PROMPT = """You are Dr. Elroi, a warm and professional AI assistant for healthcare workers across Africa. Summarize the FHIR data gathered in this conversation as a clear, clinically useful answer.

Style:
- Lead with the direct answer to the user's question, then supporting detail.
- Plain language, short paragraphs or tight bullet lists; use patient names, dates, values with units.
- Flag anything urgent or abnormal first (danger signs, abnormal vitals/labs, drug allergies and interactions) and say plainly why it matters.
- Consider the local context: malaria, TB, HIV, typhoid, maternal and child health are common; follow WHO and national treatment protocols.
- Be honest about gaps: if data is missing or a query returned nothing, say so. Never invent values.
- You assist healthcare workers; you do not replace clinical judgment. Keep that tone without repeating a disclaimer in every message."""

VISUALIZER_PROMPT = """You generate a single self-contained React component named Chart that visualizes the FHIR data provided. Output ONLY one fenced code block containing: function Chart() { ... } using the pre-scoped Recharts primitives (LineChart, BarChart, AreaChart, PieChart, ScatterChart, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Line, Bar, Area, Pie, Cell, Scatter) and Mantine layout components. No import statements, no exports.

Style:
- Brand colors in order: #0b5e4a (deep green), #16a886 (green), #ffc93c (gold), then any readable colors.
- Human-readable axis labels with units, formatted dates (e.g. 12 Mar 2026), a Legend when more than one series, ResponsiveContainer width="100%" height={320}.
- Use ONLY the real FHIR data provided in this conversation: copy the actual patient names, observation values, units and dates into the data array. NEVER invent placeholder data (no "John Doe", no example ids, no made-up values).
- Keep the component simple and guaranteed to render: a plain const data = [...] array of {name, value} objects, one chart, no state, no effects. Handle missing values gracefully (skip, do not crash)."""

COMMS = [
    ("ai-fhir-request-tools", "Dr. Elroi Spaces prompt - translator",
     [{"contentString": TRANSLATOR_PROMPT}, {"contentString": TRANSLATOR_PROFILE_TEMPLATE}]),
    ("ai-resource-summary-sse", "Dr. Elroi Spaces prompt - summary",
     [{"contentString": SUMMARY_PROMPT}]),
    ("ai-component-generator-sse", "Dr. Elroi Spaces prompt - visualizer",
     [{"contentString": VISUALIZER_PROMPT}]),
]

def req(method, url, data=None, tok=None, ct="application/fhir+json"):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, body, {"Content-Type": ct}, method=method)
    if tok:
        r.add_header("Authorization", "Bearer " + tok)
    try:
        resp = urllib.request.urlopen(r)
        txt = resp.read().decode()
        return json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {url} -> {e.code}: {e.read().decode()[:300]}")

def elroi_admin_token():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    login = req("POST", BASE + "/auth/login", {"email": ELROI_EMAIL, "password": ELROI_PASSWORD,
                "scope": "openid", "codeChallenge": challenge, "codeChallengeMethod": "S256"}, ct="application/json")
    code = login.get("code")
    if not code:
        prof = req("POST", BASE + "/auth/profile", {"login": login["login"], "profile": login["memberships"][0]["id"]}, ct="application/json")
        code = prof["code"]
    form = ("grant_type=authorization_code&code=" + code + "&code_verifier=" + verifier).encode()
    r = urllib.request.Request(BASE + "/oauth2/token", form, {"Content-Type": "application/x-www-form-urlencoded"})
    return json.load(urllib.request.urlopen(r))["access_token"]

def main():
    tok = elroi_admin_token()
    ident_sys = "https://www.medplum.com/bots"

    for value, name, dist in BOTS:
        code = (ROOT / dist).read_text(encoding="utf-8")
        found = req("GET", f"{BASE}/fhir/R4/Bot?identifier={ident_sys}|{value}", tok=tok)
        entries = found.get("entry") or []
        if entries:
            bot = entries[0]["resource"]
        else:
            bot = req("POST", f"{BASE}/admin/projects/{PROJECT_ID}/bot",
                      {"name": name, "description": "Dr. Elroi Spaces AI bot"}, tok=tok, ct="application/json")
        bot["identifier"] = [{"system": ident_sys, "value": value}]
        bot["name"] = name
        bot["runtimeVersion"] = "vmcontext"
        bot = req("PUT", f"{BASE}/fhir/R4/Bot/{bot['id']}", bot, tok=tok)
        dep = req("POST", f"{BASE}/fhir/R4/Bot/{bot['id']}/$deploy",
                  {"code": code, "filename": "index.js"}, tok=tok, ct="application/json")
        print(f"bot {value}: id={bot['id']} deploy={dep.get('issue',[{}])[0].get('details',{}).get('text','?')}")

    prompt_sys = "http://medplum.com/ai-spaces"
    for value, label, payload in COMMS:
        found = req("GET", f"{BASE}/fhir/R4/Communication?identifier={prompt_sys}|{value}", tok=tok)
        entries = found.get("entry") or []
        comm = {
            "resourceType": "Communication",
            "status": "completed",
            "identifier": [{"system": prompt_sys, "value": value}],
            "payload": payload,
        }
        if entries:
            comm["id"] = entries[0]["resource"]["id"]
            comm = req("PUT", f"{BASE}/fhir/R4/Communication/{comm['id']}", comm, tok=tok)
        else:
            comm = req("POST", f"{BASE}/fhir/R4/Communication", comm, tok=tok)
        print(f"prompt {value}: Communication/{comm['id']}")

    print("DONE")

main()
