"""Fix Condition/Observation.subject references that were left as urn:uuid:* instead of Patient/{id}."""
import json, urllib.request, urllib.parse

BASE = "http://localhost:8103"

# Credentials are loaded from connector/.env (git-ignored) — never hard-code them here.
import os
def _load_env():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "connector", ".env")
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
CID = os.environ.get("MEDPLUM_CLIENT_ID", "")
SECRET = os.environ.get("MEDPLUM_CLIENT_SECRET", "")

def req(method, path, data=None, token=None, form=False, fhir=False):
    url = BASE + path
    headers = {}
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode(); headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode(); headers["Content-Type"] = "application/fhir+json"
    if token: headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())

tok = req("POST", "/oauth2/token", {"grant_type": "client_credentials", "client_id": CID, "client_secret": SECRET}, form=True)["access_token"]

# Map family name -> real Patient/{id}
patients = req("GET", "/fhir/R4/Patient?_count=100", token=tok)
fam_to_id = {}
for e in patients.get("entry", []):
    p = e["resource"]; fam = (p.get("name", [{}])[0].get("family") or "").lower()
    fam_to_id[fam] = "Patient/" + p["id"]

# Original seed order: p1=Tesfaye, p2=Worku, p3=Diriba
urn_to_ref = {
    "urn:uuid:p1": fam_to_id.get("tesfaye"),
    "urn:uuid:p2": fam_to_id.get("worku"),
    "urn:uuid:p3": fam_to_id.get("diriba"),
}
print("Mapping:", urn_to_ref)

fixed = 0
for rtype in ("Condition", "Observation"):
    bundle = req("GET", f"/fhir/R4/{rtype}?_count=500", token=tok)
    for e in bundle.get("entry", []):
        r = e["resource"]
        cur = r.get("subject", {}).get("reference", "")
        if cur in urn_to_ref and urn_to_ref[cur]:
            r["subject"]["reference"] = urn_to_ref[cur]
            req("PUT", f"/fhir/R4/{rtype}/{r['id']}", r, token=tok, fhir=True)
            fixed += 1
print(f"Fixed {fixed} resource references.")
