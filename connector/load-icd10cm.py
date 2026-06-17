# Loads the full ICD-10-CM diagnosis code system (public domain, CMS/CDC) into the
# Elroi project and publishes ValueSets so questionnaire/condition pickers can search it.
# Idempotent-ish: re-running re-imports concepts (upserts by code) and updates ValueSets.
import json, urllib.request, urllib.error, hashlib, base64, secrets, zipfile, io, time, urllib.parse

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

ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm"
ZIP_PATH = r"D:\Software Engineering\Dr. Ubuntu\connector\icd10cm.zip"
TXT_NAME = "Code Descriptions/icd10cm_codes_2026.txt"
BATCH = 1000


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
        raise SystemExit(f"{method} {url} -> {e.code}: {e.read().decode()[:400]}")


def token():
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


def dotted(code):
    return code if len(code) <= 3 else code[:3] + "." + code[3:]


def main():
    tok = token()

    # 1) parse the code file
    z = zipfile.ZipFile(ZIP_PATH)
    lines = io.TextIOWrapper(z.open(TXT_NAME), encoding="latin-1").read().splitlines()
    concepts = []
    for line in lines:
        line = line.rstrip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        code, display = parts
        concepts.append({"code": dotted(code), "display": display.strip()})
    print(f"parsed {len(concepts)} ICD-10-CM concepts")

    # 2) ensure CodeSystem exists
    found = req("GET", f"{BASE}/fhir/R4/CodeSystem?url={urllib.parse.quote(ICD10CM)}", tok=tok)
    entries = found.get("entry") or []
    if entries:
        cs = entries[0]["resource"]
        print(f"CodeSystem exists: {cs['id']}")
    else:
        cs = req("POST", f"{BASE}/fhir/R4/CodeSystem", {
            "resourceType": "CodeSystem",
            "url": ICD10CM,
            "name": "ICD10CM",
            "title": "ICD-10-CM (diagnoses)",
            "status": "active",
            "content": "not-present",
            "description": "ICD-10-CM diagnosis codes (CMS/NCHS, public domain). Imported locally for Dr. Elroi.",
        }, tok=tok)
        print(f"CodeSystem created: {cs['id']}")

    # 3) import concepts in batches via $import
    t0 = time.time()
    for i in range(0, len(concepts), BATCH):
        batch = concepts[i:i + BATCH]
        params = {"resourceType": "Parameters", "parameter": (
            [{"name": "system", "valueUri": ICD10CM}] +
            [{"name": "concept", "valueCoding": {"system": ICD10CM, "code": c["code"], "display": c["display"]}} for c in batch]
        )}
        req("POST", f"{BASE}/fhir/R4/CodeSystem/$import", params, tok=tok)
        done = min(i + BATCH, len(concepts))
        if (i // BATCH) % 10 == 0 or done == len(concepts):
            print(f"imported {done}/{len(concepts)} ({time.time()-t0:.0f}s)")

    # 4) ValueSets: one generic, plus the US-Core URL that the app's pickers reference
    for vs_url, name in [
        ("https://www.medplum.com/valueset/icd-10-cm-diagnoses", "ICD10CMDiagnoses"),
        ("http://hl7.org/fhir/us/core/ValueSet/us-core-condition-code", "USCoreConditionCode"),
    ]:
        found = req("GET", f"{BASE}/fhir/R4/ValueSet?url={urllib.parse.quote(vs_url)}", tok=tok)
        entries = found.get("entry") or []
        vs = {
            "resourceType": "ValueSet",
            "url": vs_url,
            "name": name,
            "title": "Diagnoses (ICD-10-CM)",
            "status": "active",
            "compose": {"include": [{"system": ICD10CM}]},
        }
        if entries:
            vs["id"] = entries[0]["resource"]["id"]
            req("PUT", f"{BASE}/fhir/R4/ValueSet/{vs['id']}", vs, tok=tok)
            print(f"ValueSet updated: {vs_url}")
        else:
            req("POST", f"{BASE}/fhir/R4/ValueSet", vs, tok=tok)
            print(f"ValueSet created: {vs_url}")

    # 5) smoke test: expand with filter
    for term in ("malaria", "tuberculosis", "fracture of femur"):
        ex = req("GET", f"{BASE}/fhir/R4/ValueSet/$expand?url={urllib.parse.quote('https://www.medplum.com/valueset/icd-10-cm-diagnoses')}&filter={urllib.parse.quote(term)}&count=3", tok=tok)
        hits = [(c.get("code"), c.get("display")) for c in (ex.get("expansion", {}).get("contains") or [])]
        print(f"expand '{term}':", hits)

    print("DONE")


main()
