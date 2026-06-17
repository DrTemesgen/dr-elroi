# Seeds a standard US primary-care Care Template library into the Elroi project.
# 8 PlanDefinitions + supporting Questionnaires, ActivityDefinitions, ChargeItemDefinitions.
# Idempotent: resources are matched by canonical `url` and updated in place.
import json, urllib.request, urllib.error, hashlib, base64, secrets

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

CPT = "http://www.ama-assn.org/go/cpt"
LOINC = "http://loinc.org"
SNOMED = "http://snomed.info/sct"
MP = "https://www.medplum.com"
CHARGE_EXT = "http://medplum.com/fhir/StructureDefinition/applicable-charge-definition"


def cc(system, code, display):
    return {"coding": [{"system": system, "code": code, "display": display}]}


def charge_def(url, title, cpt, display, usd):
    return {
        "resourceType": "ChargeItemDefinition", "url": url, "title": title, "status": "active",
        "propertyGroup": [{"priceComponent": [{
            "type": "base", "code": cc(CPT, cpt, display), "factor": 1,
            "amount": {"value": usd, "currency": "USD"},
        }]}],
    }


def lab_activity(url, name, codings, charge_url):
    return {
        "resourceType": "ActivityDefinition", "url": url, "name": name, "title": name, "status": "active",
        "kind": "ServiceRequest", "intent": "order",
        "extension": [{"url": CHARGE_EXT, "valueCanonical": charge_url}],
        "code": {"coding": [{"system": s, "code": c, "display": d} for (s, c, d) in codings]},
    }


def q_text(linkid, text, required=False):
    item = {"linkId": linkid, "text": text, "type": "text"}
    if required:
        item["required"] = True
    return item


def q_string(linkid, text):
    return {"linkId": linkid, "text": text, "type": "string"}


def q_bool(linkid, text):
    return {"linkId": linkid, "text": text, "type": "boolean"}


def q_choice(linkid, text, options):
    return {"linkId": linkid, "text": text, "type": "choice",
            "answerOption": [{"valueString": o} for o in options]}


PHQ9_OPTS = ["0 - Not at all", "1 - Several days", "2 - More than half the days", "3 - Nearly every day"]

QUESTIONNAIRES = [
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-preventive-screening",
        "name": "Preventive Screening Review", "title": "Preventive Screening Review", "status": "active",
        "item": [
            q_choice("tobacco-use", "Tobacco use", ["Never", "Former", "Current every day", "Current some days"]),
            q_choice("alcohol-use", "Alcohol use (drinks/week)", ["None", "1-7", "8-14", "15+"]),
            q_bool("colorectal-due", "Colorectal cancer screening due (age 45-75)?"),
            q_bool("mammo-due", "Mammogram due (women 40-74)?"),
            q_bool("cervical-due", "Cervical cancer screening due (women 21-65)?"),
            q_bool("immunizations-due", "Adult immunizations due (Tdap, flu, COVID, zoster, pneumococcal)?"),
            q_choice("phq2-interest", "PHQ-2: Little interest or pleasure in doing things", PHQ9_OPTS),
            q_choice("phq2-mood", "PHQ-2: Feeling down, depressed, or hopeless", PHQ9_OPTS),
            q_text("counseling", "Lifestyle counseling provided (diet, exercise, safety)"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-interval-history",
        "name": "Interval History & Exam", "title": "Interval History & Exam", "status": "active",
        "item": [
            q_text("interval-history", "Interval history since last visit", True),
            q_text("current-meds-reviewed", "Medication reconciliation (changes, adherence, refills)"),
            q_text("focused-exam", "Focused physical exam"),
            q_text("assessment-plan", "Assessment & plan", True),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-well-child",
        "name": "Well-Child Assessment", "title": "Well-Child Assessment", "status": "active",
        "item": [
            q_string("growth-weight", "Weight (kg) & percentile"),
            q_string("growth-height", "Height/length (cm) & percentile"),
            q_string("growth-hc", "Head circumference (cm) & percentile (under 2y)"),
            q_bool("milestones-gross-motor", "Gross motor milestones on track?"),
            q_bool("milestones-fine-motor", "Fine motor milestones on track?"),
            q_bool("milestones-language", "Language milestones on track?"),
            q_bool("milestones-social", "Social/emotional milestones on track?"),
            q_bool("immunizations-uptodate", "Immunizations up to date (CDC schedule)?"),
            q_text("anticipatory-guidance", "Anticipatory guidance (nutrition, sleep, safety, screens)"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-diabetes-management",
        "name": "Diabetes Management Assessment", "title": "Diabetes Management Assessment", "status": "active",
        "item": [
            q_string("home-glucose", "Home glucose readings / CGM summary"),
            q_bool("hypoglycemia", "Hypoglycemic episodes since last visit?"),
            q_text("med-adherence", "Medication adherence & side effects"),
            q_bool("foot-exam", "Comprehensive foot exam performed?"),
            q_string("last-eye-exam", "Last dilated eye exam (date)"),
            q_bool("statin", "On statin therapy (if indicated)?"),
            q_text("dm-plan", "Plan (targets, titration, referrals)"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-htn-followup",
        "name": "Hypertension Follow-Up", "title": "Hypertension Follow-Up", "status": "active",
        "item": [
            q_string("office-bp", "Office BP (repeat if elevated)", ),
            q_string("home-bp", "Home BP log average"),
            q_text("htn-med-adherence", "Medication adherence & side effects"),
            q_bool("lifestyle-reviewed", "Lifestyle measures reviewed (DASH diet, sodium, exercise)?"),
            q_text("htn-plan", "Plan (titration, labs, follow-up interval)"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-prenatal-visit",
        "name": "Routine Prenatal Visit", "title": "Routine Prenatal Visit", "status": "active",
        "item": [
            q_string("gestational-age", "Gestational age (weeks)", ),
            q_string("fundal-height", "Fundal height (cm)"),
            q_string("fetal-heart-rate", "Fetal heart rate (bpm)"),
            q_string("urine-dip", "Urine dipstick (protein/glucose)"),
            q_bool("fetal-movement", "Fetal movement normal (after 28w)?"),
            q_bool("danger-signs", "Danger signs screened (bleeding, headache, vision, swelling)?"),
            q_text("prenatal-plan", "Plan & next visit"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-acute-visit",
        "name": "Acute Visit (Problem-Focused)", "title": "Acute Visit (Problem-Focused)", "status": "active",
        "item": [
            q_text("chief-complaint", "Chief complaint & HPI", True),
            q_text("ros", "Pertinent review of systems"),
            q_text("acute-exam", "Focused exam"),
            q_text("acute-assessment", "Assessment & plan", True),
            q_bool("return-precautions", "Return precautions given?"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/us-phq9",
        "name": "PHQ-9 Depression Screening", "title": "PHQ-9 Depression Screening", "status": "active",
        "item": [
            q_choice("phq9-1", "1. Little interest or pleasure in doing things", PHQ9_OPTS),
            q_choice("phq9-2", "2. Feeling down, depressed, or hopeless", PHQ9_OPTS),
            q_choice("phq9-3", "3. Trouble falling/staying asleep, or sleeping too much", PHQ9_OPTS),
            q_choice("phq9-4", "4. Feeling tired or having little energy", PHQ9_OPTS),
            q_choice("phq9-5", "5. Poor appetite or overeating", PHQ9_OPTS),
            q_choice("phq9-6", "6. Feeling bad about yourself", PHQ9_OPTS),
            q_choice("phq9-7", "7. Trouble concentrating", PHQ9_OPTS),
            q_choice("phq9-8", "8. Moving/speaking slowly or being fidgety/restless", PHQ9_OPTS),
            q_choice("phq9-9", "9. Thoughts of being better off dead or self-harm", PHQ9_OPTS),
            q_string("phq9-total", "Total score (0-27)"),
            q_choice("phq9-severity", "Severity", ["0-4 Minimal", "5-9 Mild", "10-14 Moderate", "15-19 Moderately severe", "20-27 Severe"]),
        ],
    },
]

CHARGES = [
    charge_def(f"{MP}/chargeItemDefinition/us-99395", "Annual Preventive Exam, Established 18-39", "99395", "Periodic preventive medicine, established patient, 18-39", 150),
    charge_def(f"{MP}/chargeItemDefinition/us-99213", "Established Patient Visit, Low Complexity", "99213", "Office visit, established patient, low MDM", 110),
    charge_def(f"{MP}/chargeItemDefinition/us-99214", "Established Patient Visit, Moderate Complexity", "99214", "Office visit, established patient, moderate MDM", 165),
    charge_def(f"{MP}/chargeItemDefinition/us-99212", "Established Patient Visit, Straightforward", "99212", "Office visit, established patient, straightforward MDM", 85),
    charge_def(f"{MP}/chargeItemDefinition/us-99392", "Well-Child Visit, Established 1-4y", "99392", "Periodic preventive medicine, established patient, age 1-4", 130),
    charge_def(f"{MP}/chargeItemDefinition/us-83036", "Hemoglobin A1c", "83036", "Hemoglobin; glycosylated (A1c)", 25),
    charge_def(f"{MP}/chargeItemDefinition/us-80048", "Basic Metabolic Panel", "80048", "Basic metabolic panel", 20),
    charge_def(f"{MP}/chargeItemDefinition/us-80061", "Lipid Panel", "80061", "Lipid panel", 30),
    charge_def(f"{MP}/chargeItemDefinition/us-85025", "CBC with Differential", "85025", "Complete blood count with differential", 22),
    charge_def(f"{MP}/chargeItemDefinition/us-81002", "Urinalysis, Dipstick", "81002", "Urinalysis, non-automated, without microscopy", 8),
    charge_def(f"{MP}/chargeItemDefinition/us-96127", "Brief Behavioral Assessment (PHQ-9)", "96127", "Brief emotional/behavioral assessment", 15),
]

ACTIVITIES = [
    lab_activity(f"{MP}/activitydefinition/us-preventive-labs", "Preventive Labs (Lipid, CMP, CBC)",
                 [(SNOMED, "16254007", "Lipid panel"), (SNOMED, "166312007", "Blood chemistry"), (SNOMED, "26604007", "Complete blood count")],
                 f"{MP}/chargeItemDefinition/us-80061"),
    lab_activity(f"{MP}/activitydefinition/us-hba1c", "Hemoglobin A1c",
                 [(LOINC, "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood")],
                 f"{MP}/chargeItemDefinition/us-83036"),
    lab_activity(f"{MP}/activitydefinition/us-bmp", "Basic Metabolic Panel",
                 [(LOINC, "51990-0", "Basic metabolic panel - Blood")],
                 f"{MP}/chargeItemDefinition/us-80048"),
    lab_activity(f"{MP}/activitydefinition/us-urinalysis", "Urinalysis (Dipstick)",
                 [(LOINC, "24356-8", "Urinalysis complete panel - Urine")],
                 f"{MP}/chargeItemDefinition/us-81002"),
]


def plan(url, name, title, actions):
    return {
        "resourceType": "PlanDefinition", "url": url, "name": name, "title": title, "status": "active",
        "type": cc("http://terminology.hl7.org/CodeSystem/plan-definition-type", "order-set", "Order Set"),
        "action": actions,
    }


def qa(aid, title, q_url, description=None):
    a = {"id": aid, "title": title, "definitionCanonical": q_url}
    if description:
        a["description"] = description
    return a


def charge_action(aid, title, cpt, display):
    return {"id": aid, "title": title, "code": [cc(CPT, cpt, display)]}


VITALS_Q = f"{MP}/questionnaire/vital-signs-assessment"  # shipped with Simple Initial Visit bundle

PLANS = [
    plan(f"{MP}/plandefinition/us-annual-preventive-exam", "Annual Preventive Exam (Adult)", "Annual Preventive Exam (Adult)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Preventive Screening Review", f"{MP}/questionnaire/us-preventive-screening"),
        qa("a3", "Preventive Labs", f"{MP}/activitydefinition/us-preventive-labs"),
        charge_action("a4", "Preventive E&M (99395)", "99395", "Periodic preventive medicine, established patient, 18-39"),
    ]),
    plan(f"{MP}/plandefinition/us-established-followup", "Established Patient Follow-Up", "Established Patient Follow-Up", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Interval History & Exam", f"{MP}/questionnaire/us-interval-history"),
        charge_action("a3", "E&M (99213)", "99213", "Office visit, established patient, low MDM"),
    ]),
    plan(f"{MP}/plandefinition/us-well-child-visit", "Well-Child Visit", "Well-Child Visit", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Well-Child Assessment", f"{MP}/questionnaire/us-well-child"),
        charge_action("a3", "Preventive E&M (99392)", "99392", "Periodic preventive medicine, established patient, age 1-4"),
    ]),
    plan(f"{MP}/plandefinition/us-diabetes-management", "Diabetes Management Visit", "Diabetes Management Visit", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Diabetes Assessment", f"{MP}/questionnaire/us-diabetes-management"),
        qa("a3", "Order HbA1c", f"{MP}/activitydefinition/us-hba1c"),
        qa("a4", "Order BMP", f"{MP}/activitydefinition/us-bmp"),
        charge_action("a5", "E&M (99214)", "99214", "Office visit, established patient, moderate MDM"),
    ]),
    plan(f"{MP}/plandefinition/us-htn-followup", "Hypertension Follow-Up", "Hypertension Follow-Up", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Hypertension Follow-Up", f"{MP}/questionnaire/us-htn-followup"),
        qa("a3", "Order BMP", f"{MP}/activitydefinition/us-bmp"),
        charge_action("a4", "E&M (99213)", "99213", "Office visit, established patient, low MDM"),
    ]),
    plan(f"{MP}/plandefinition/us-prenatal-routine", "Prenatal Visit (Routine)", "Prenatal Visit (Routine)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Routine Prenatal Assessment", f"{MP}/questionnaire/us-prenatal-visit"),
        qa("a3", "Urinalysis", f"{MP}/activitydefinition/us-urinalysis"),
        charge_action("a4", "E&M (99213)", "99213", "Office visit, established patient, low MDM"),
    ]),
    plan(f"{MP}/plandefinition/us-acute-visit", "Acute Visit (Problem-Focused)", "Acute Visit (Problem-Focused)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Acute Visit Documentation", f"{MP}/questionnaire/us-acute-visit"),
        charge_action("a3", "E&M (99212)", "99212", "Office visit, established patient, straightforward MDM"),
    ]),
    plan(f"{MP}/plandefinition/us-depression-screening", "Depression Screening (PHQ-9)", "Depression Screening (PHQ-9)", [
        qa("a1", "PHQ-9 Questionnaire", f"{MP}/questionnaire/us-phq9",
           "Score: 0-4 minimal, 5-9 mild, 10-14 moderate, 15-19 mod-severe, 20-27 severe. Item 9 positive -> assess suicide risk today."),
        charge_action("a2", "Brief Behavioral Assessment (96127)", "96127", "Brief emotional/behavioral assessment"),
    ]),
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


def upsert(tok, resource):
    rt = resource["resourceType"]
    found = req("GET", f"{BASE}/fhir/R4/{rt}?url={urllib.parse.quote(resource['url'])}", tok=tok)
    entries = found.get("entry") or []
    if entries:
        resource["id"] = entries[0]["resource"]["id"]
        req("PUT", f"{BASE}/fhir/R4/{rt}/{resource['id']}", resource, tok=tok)
        return "updated"
    req("POST", f"{BASE}/fhir/R4/{rt}", resource, tok=tok)
    return "created"


import urllib.parse

def main():
    tok = token()
    for group, items in (("ChargeItemDefinition", CHARGES), ("Questionnaire", QUESTIONNAIRES),
                         ("ActivityDefinition", ACTIVITIES), ("PlanDefinition", PLANS)):
        for r in items:
            state = upsert(tok, r)
            print(f"{group}: {r.get('title') or r.get('name')} -> {state}")
    print("DONE")


main()
