"""Seed a few realistic Ethiopian-context sample patients into the local Medplum EMR via FHIR."""
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

def post(path, data, token=None, form=False):
    url = BASE + path
    if form:
        body = urllib.parse.urlencode(data).encode()
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
    else:
        body = json.dumps(data).encode()
        headers = {"Content-Type": "application/fhir+json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

# 1. token
tok = post("/oauth2/token", {"grant_type": "client_credentials", "client_id": CID, "client_secret": SECRET}, form=True)["access_token"]

def patient(fullUrl, given, family, gender, birth):
    return {"fullUrl": fullUrl, "request": {"method": "POST", "url": "Patient"},
            "resource": {"resourceType": "Patient", "name": [{"given": [given], "family": family}],
                         "gender": gender, "birthDate": birth, "address": [{"country": "Ethiopia"}]}}

def condition(ref, text):
    return {"request": {"method": "POST", "url": "Condition"},
            "resource": {"resourceType": "Condition", "subject": {"reference": ref}, "code": {"text": text},
                         "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active"}]}}}

def obs(ref, text, value, unit):
    return {"request": {"method": "POST", "url": "Observation"},
            "resource": {"resourceType": "Observation", "status": "final", "subject": {"reference": ref},
                         "code": {"text": text}, "valueQuantity": {"value": value, "unit": unit}}}

bundle = {"resourceType": "Bundle", "type": "transaction", "entry": [
    patient("urn:uuid:p1", "Almaz", "Tesfaye", "female", "1998-03-12"),
    condition("urn:uuid:p1", "Pregnancy (first trimester)"),
    condition("urn:uuid:p1", "Suspected malaria"),
    obs("urn:uuid:p1", "Body temperature", 39.2, "Cel"),
    obs("urn:uuid:p1", "Systolic blood pressure", 110, "mmHg"),

    patient("urn:uuid:p2", "Bekele", "Worku", "male", "1972-07-01"),
    condition("urn:uuid:p2", "Hypertension"),
    condition("urn:uuid:p2", "Type 2 diabetes mellitus"),
    obs("urn:uuid:p2", "Systolic blood pressure", 158, "mmHg"),
    obs("urn:uuid:p2", "Diastolic blood pressure", 96, "mmHg"),
    obs("urn:uuid:p2", "Fasting blood glucose", 9.8, "mmol/L"),

    patient("urn:uuid:p3", "Chaltu", "Diriba", "female", "2019-11-20"),
    condition("urn:uuid:p3", "Community-acquired pneumonia"),
    obs("urn:uuid:p3", "Body temperature", 38.6, "Cel"),
    obs("urn:uuid:p3", "Respiratory rate", 44, "breaths/min"),
]}

res = post("/fhir/R4", bundle, token=tok)
created = sum(1 for e in res.get("entry", []) if e.get("response", {}).get("status", "").startswith("201"))
print(f"Created {created} resources across 3 patients.")
