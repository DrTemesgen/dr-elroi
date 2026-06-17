# Seeds the Africa Care Template pack (ETB pricing) into the Elroi project.
# Categories: communicable disease, non-communicable disease (NCD), trauma.
# 11 PlanDefinitions + Questionnaires, ActivityDefinitions, ChargeItemDefinitions.
# Idempotent: resources are matched by canonical `url` and updated in place.
import json, urllib.request, urllib.error, hashlib, base64, secrets, urllib.parse

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

SVC = "urn:africadha:service"   # local service/billing codes
LAB = "urn:africadha:lab"       # local lab/procedure codes where no confident LOINC
LOINC = "http://loinc.org"
SNOMED = "http://snomed.info/sct"
MP = "https://www.medplum.com"
CHARGE_EXT = "http://medplum.com/fhir/StructureDefinition/applicable-charge-definition"
VITALS_Q = f"{MP}/questionnaire/vital-signs-assessment"  # shared, already seeded


def cc(system, code, display):
    return {"coding": [{"system": system, "code": code, "display": display}]}


def charge_def(url, title, code, display, etb):
    return {
        "resourceType": "ChargeItemDefinition", "url": url, "title": title, "status": "active",
        "propertyGroup": [{"priceComponent": [{
            "type": "base", "code": cc(SVC, code, display), "factor": 1,
            "amount": {"value": etb, "currency": "ETB"},
        }]}],
    }


def activity(url, name, codings, charge_url):
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


def q_display(linkid, text):
    return {"linkId": linkid, "text": text, "type": "display"}


# ============================================================
# CHARGES (ETB) — representative Ethiopian private-clinic prices; edit freely
# ============================================================
CHARGES = [
    charge_def(f"{MP}/chargeItemDefinition/af-cons-gp", "GP Consultation", "CONS-GP", "General practitioner consultation", 400),
    charge_def(f"{MP}/chargeItemDefinition/af-cons-fu", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation", 250),
    charge_def(f"{MP}/chargeItemDefinition/af-cons-u5", "Under-5 Sick Child Visit", "CONS-U5", "Under-five sick child consultation (IMNCI)", 300),
    charge_def(f"{MP}/chargeItemDefinition/af-malaria-rdt", "Malaria RDT", "LAB-MRDT", "Malaria rapid diagnostic test", 150),
    charge_def(f"{MP}/chargeItemDefinition/af-blood-film", "Blood Film (Malaria Microscopy)", "LAB-BF", "Thick & thin blood film microscopy", 100),
    charge_def(f"{MP}/chargeItemDefinition/af-sputum-xpert", "Sputum GeneXpert MTB/RIF", "LAB-XPERT", "GeneXpert MTB/RIF sputum test", 500),
    charge_def(f"{MP}/chargeItemDefinition/af-hiv-rapid", "HIV Rapid Test", "LAB-HIV", "HIV 1/2 rapid antibody test", 100),
    charge_def(f"{MP}/chargeItemDefinition/af-glucose", "Blood Glucose (Fasting/Random)", "LAB-GLU", "Blood glucose", 120),
    charge_def(f"{MP}/chargeItemDefinition/af-hemoglobin", "Hemoglobin", "LAB-HGB", "Hemoglobin", 100),
    charge_def(f"{MP}/chargeItemDefinition/af-urinalysis", "Urinalysis (Dipstick)", "LAB-UA", "Urine dipstick analysis", 80),
    charge_def(f"{MP}/chargeItemDefinition/af-xray-limb", "X-Ray (Limb)", "IMG-XRL", "Plain radiograph, extremity", 600),
    charge_def(f"{MP}/chargeItemDefinition/af-suturing", "Wound Suturing", "PROC-SUT", "Wound repair / suturing", 500),
    charge_def(f"{MP}/chargeItemDefinition/af-dressing", "Wound Dressing", "PROC-DRS", "Wound cleaning and dressing", 200),
    charge_def(f"{MP}/chargeItemDefinition/af-burn-dressing", "Burn Dressing", "PROC-BRN", "Burn cleaning and dressing", 400),
    charge_def(f"{MP}/chargeItemDefinition/af-tetanus-tt", "Tetanus Toxoid Injection", "PROC-TT", "Tetanus toxoid prophylaxis", 150),
]

# ============================================================
# LAB / PROCEDURE ORDERS
# ============================================================
ACTIVITIES = [
    activity(f"{MP}/activitydefinition/af-malaria-rdt", "Malaria RDT",
             [(LOINC, "70569-9", "Plasmodium sp Ag [Presence] in Blood by Rapid immunoassay")],
             f"{MP}/chargeItemDefinition/af-malaria-rdt"),
    activity(f"{MP}/activitydefinition/af-blood-film", "Blood Film (Thick & Thin)",
             [(LOINC, "32700-7", "Plasmodium sp identified in Blood by Light microscopy")],
             f"{MP}/chargeItemDefinition/af-blood-film"),
    activity(f"{MP}/activitydefinition/af-sputum-xpert", "Sputum GeneXpert MTB/RIF",
             [(LAB, "XPERT-MTB-RIF", "GeneXpert MTB/RIF (sputum)")],
             f"{MP}/chargeItemDefinition/af-sputum-xpert"),
    activity(f"{MP}/activitydefinition/af-hiv-rapid", "HIV Rapid Test",
             [(LAB, "HIV-RAPID", "HIV 1/2 rapid antibody test")],
             f"{MP}/chargeItemDefinition/af-hiv-rapid"),
    activity(f"{MP}/activitydefinition/af-glucose", "Blood Glucose",
             [(LOINC, "2339-0", "Glucose [Mass/volume] in Blood")],
             f"{MP}/chargeItemDefinition/af-glucose"),
    activity(f"{MP}/activitydefinition/af-hemoglobin", "Hemoglobin",
             [(LOINC, "718-7", "Hemoglobin [Mass/volume] in Blood")],
             f"{MP}/chargeItemDefinition/af-hemoglobin"),
    activity(f"{MP}/activitydefinition/af-urinalysis", "Urinalysis (Dipstick)",
             [(LOINC, "24356-8", "Urinalysis complete panel - Urine")],
             f"{MP}/chargeItemDefinition/af-urinalysis"),
    activity(f"{MP}/activitydefinition/af-xray-limb", "X-Ray (Limb)",
             [(LAB, "XR-LIMB", "Plain radiograph, extremity")],
             f"{MP}/chargeItemDefinition/af-xray-limb"),
    activity(f"{MP}/activitydefinition/af-suturing", "Wound Suturing",
             [(SNOMED, "18557009", "Suturing of wound")],
             f"{MP}/chargeItemDefinition/af-suturing"),
    activity(f"{MP}/activitydefinition/af-dressing", "Wound Dressing",
             [(LAB, "DRESSING", "Wound cleaning and dressing")],
             f"{MP}/chargeItemDefinition/af-dressing"),
    activity(f"{MP}/activitydefinition/af-tetanus-tt", "Tetanus Toxoid",
             [(LAB, "TT-INJ", "Tetanus toxoid prophylaxis injection")],
             f"{MP}/chargeItemDefinition/af-tetanus-tt"),
]

# ============================================================
# QUESTIONNAIRES
# ============================================================
DANGER_U5 = ["None", "Unable to drink/breastfeed", "Vomits everything", "Convulsions", "Lethargic/unconscious"]

QUESTIONNAIRES = [
    # --- COMMUNICABLE ---
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-fever-malaria",
        "name": "Fever / Suspected Malaria Assessment", "title": "Fever / Suspected Malaria Assessment", "status": "active",
        "item": [
            q_display("d0", "WHO/national guideline: TEST before treating. Do not give antimalarials without a positive RDT or blood film."),
            q_string("fever-duration", "Fever duration (days)"),
            q_bool("recent-travel", "Travel to/residence in malaria-endemic area?"),
            q_choice("danger-signs", "Danger signs", ["None", "Convulsions", "Unable to drink", "Repeated vomiting", "Lethargy/unconsciousness", "Severe pallor", "Respiratory distress"]),
            q_choice("rdt-result", "Malaria RDT result", ["Positive - P. falciparum", "Positive - P. vivax", "Positive - mixed", "Negative", "Not done"]),
            q_choice("severity", "Classification", ["Uncomplicated malaria", "Severe malaria - REFER/admit", "Non-malarial fever - investigate other causes"]),
            q_text("fever-plan", "Treatment plan (first-line: AL for P. falciparum; chloroquine + primaquine for P. vivax per national protocol)", True),
            q_bool("followup-48h", "Follow-up in 48-72h arranged (or sooner if worse)?"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-tb-screening",
        "name": "TB Screening & Follow-Up", "title": "TB Screening & Follow-Up", "status": "active",
        "item": [
            q_bool("cough-2wk", "Cough ≥ 2 weeks?"),
            q_bool("tb-fever", "Fever?"),
            q_bool("night-sweats", "Night sweats?"),
            q_bool("weight-loss", "Unintentional weight loss?"),
            q_bool("tb-contact", "Household/close TB contact?"),
            q_choice("hiv-status", "HIV status", ["Negative", "Positive - on ART", "Positive - not on ART", "Unknown - offer test"]),
            q_choice("xpert-result", "GeneXpert result", ["MTB detected, RIF sensitive", "MTB detected, RIF resistant - REFER", "MTB not detected", "Pending", "Not done"]),
            q_text("tb-plan", "Plan (start DOTS, refer to TB clinic, IPT for contacts, follow-up date)", True),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-hiv-counseling",
        "name": "HIV Testing & Counseling", "title": "HIV Testing & Counseling", "status": "active",
        "item": [
            q_bool("pretest", "Pre-test counseling provided and consent obtained?"),
            q_choice("test-reason", "Reason for testing", ["Client-initiated", "Provider-initiated", "ANC", "TB patient", "Partner/contact", "Occupational exposure"]),
            q_choice("hiv-result", "Rapid test result", ["Non-reactive", "Reactive - confirmed per algorithm", "Indeterminate - repeat per algorithm"]),
            q_bool("posttest", "Post-test counseling provided?"),
            q_text("linkage", "If reactive: linkage to ART clinic (site, date). If non-reactive: prevention counseling, retest window."),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-imnci-u5",
        "name": "Under-5 Sick Child (IMNCI)", "title": "Under-5 Sick Child (IMNCI)", "status": "active",
        "item": [
            q_string("child-weight", "Weight (kg)"),
            q_string("muac", "MUAC (mm) — <115 = severe acute malnutrition"),
            q_choice("u5-danger", "General danger signs", DANGER_U5),
            q_bool("cough-fast-breathing", "Cough or difficult breathing? (count RR: fast = pneumonia)"),
            q_bool("diarrhea", "Diarrhoea? (assess dehydration: skin pinch, sunken eyes, restless/lethargic)"),
            q_choice("dehydration", "Dehydration classification", ["No dehydration", "Some dehydration - ORS plan B", "Severe dehydration - plan C/REFER"]),
            q_bool("u5-fever", "Fever? (do malaria RDT if endemic)"),
            q_bool("ear-problem", "Ear problem?"),
            q_bool("vaccines-checked", "Immunization status checked & due vaccines given?"),
            q_bool("feeding-assessed", "Feeding assessed and counseling given?"),
            q_text("u5-classify-treat", "Classification & treatment (ORS+zinc for diarrhoea; amoxicillin DT for pneumonia; AL if RDT+; vitamin A as due)", True),
            q_string("u5-followup", "Follow-up date (2 days if pneumonia/fever; 5 days diarrhoea)"),
        ],
    },
    # --- NON-COMMUNICABLE ---
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-htn-visit",
        "name": "Hypertension Visit (Africa)", "title": "Hypertension Visit (Africa)", "status": "active",
        "item": [
            q_string("bp-today", "BP today (repeat if ≥140/90, average of 2)"),
            q_text("htn-adherence", "Adherence & barriers (cost, stock-outs, side effects)"),
            q_bool("salt-counseling", "Lifestyle counseling: salt reduction, exercise, weight?"),
            q_bool("khat-alcohol", "Khat / alcohol / tobacco use reviewed?"),
            q_bool("complication-check", "Complication check done (headache, vision, chest pain, edema, urine protein)?"),
            q_text("htn-plan", "Plan (titration per protocol, next labs, follow-up interval)", True),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-dm-visit",
        "name": "Diabetes Visit (Africa)", "title": "Diabetes Visit (Africa)", "status": "active",
        "item": [
            q_string("glucose-today", "Blood glucose today (mg/dL, note fasting/random)"),
            q_bool("hypo-episodes", "Hypoglycemia episodes since last visit?"),
            q_text("dm-adherence", "Medication adherence (insulin storage/cold chain if applicable)"),
            q_bool("foot-checked", "Foot exam done (ulcers, sensation)?"),
            q_string("eye-exam-date", "Last eye exam (refer yearly)"),
            q_text("dm-plan", "Plan (titration, diet counseling, next glucose/HbA1c when available)", True),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-asthma-copd",
        "name": "Asthma / COPD Review", "title": "Asthma / COPD Review", "status": "active",
        "item": [
            q_choice("symptom-freq", "Daytime symptoms", ["≤2/week (controlled)", ">2/week (partly controlled)", "Daily (uncontrolled)"]),
            q_bool("night-waking", "Night waking due to symptoms?"),
            q_string("exacerbations", "Exacerbations / hospital visits since last review"),
            q_bool("inhaler-technique", "Inhaler technique checked & corrected?"),
            q_bool("smoke-exposure", "Tobacco / indoor cooking-smoke exposure discussed?"),
            q_string("peak-flow", "Peak flow (L/min) if available"),
            q_text("resp-plan", "Plan (step up/down, spacer, action plan)", True),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-epilepsy",
        "name": "Epilepsy Follow-Up", "title": "Epilepsy Follow-Up", "status": "active",
        "item": [
            q_string("seizure-count", "Seizures since last visit (number, type)"),
            q_text("aed-adherence", "Anti-seizure medication & adherence (phenobarbital/others, missed doses)"),
            q_bool("side-effects", "Side effects (drowsiness, rash)?"),
            q_bool("injury", "Injury during seizure (burns, falls)?"),
            q_bool("safety-counseling", "Safety counseling (open fires, cooking, water, driving)?"),
            q_text("epilepsy-plan", "Plan (dose adjustment, labs if available, next visit)", True),
        ],
    },
    # --- TRAUMA ---
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-trauma-primary",
        "name": "Acute Trauma Assessment (ABCDE)", "title": "Acute Trauma Assessment (ABCDE)", "status": "active",
        "item": [
            q_string("mechanism", "Mechanism & time of injury (RTA, fall, assault, occupational...)"),
            q_choice("airway", "A — Airway", ["Patent", "At risk - position/adjunct", "Obstructed - URGENT"]),
            q_choice("breathing", "B — Breathing", ["Normal", "Distress - give O2 if available", "Absent/agonal - URGENT"]),
            q_choice("circulation", "C — Circulation", ["Stable", "Bleeding controlled with pressure", "Shock - IV fluids, URGENT REFERRAL"]),
            q_string("gcs", "D — Disability: GCS (3-15) & pupils"),
            q_text("exposure", "E — Exposure: full-body exam findings (log-roll, keep warm)"),
            q_choice("tetanus-status", "Tetanus immunization status", ["Up to date", "Due - give TT today", "Unknown - give TT today"]),
            q_bool("imaging-needed", "Imaging needed (X-ray)?"),
            q_choice("disposition", "Disposition", ["Treat & discharge with advice", "Observe", "REFER to hospital (surgical/ortho/neuro)"]),
            q_text("trauma-plan", "Treatment given & plan", True),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-wound-care",
        "name": "Wound Care & Suturing", "title": "Wound Care & Suturing", "status": "active",
        "item": [
            q_string("wound-site", "Wound site, size (cm) & type (laceration, puncture, bite, crush)"),
            q_string("wound-age", "Time since injury (hours) — primary closure usually if <6-12h and clean"),
            q_bool("contaminated", "Contaminated / bite / crush wound? (consider delayed closure + antibiotics)"),
            q_bool("irrigated", "Irrigated thoroughly (clean water/saline) & debrided?"),
            q_choice("closure", "Closure method", ["Sutures", "Adhesive strips", "Left open / delayed closure", "Referred"]),
            q_choice("tetanus-given", "Tetanus prophylaxis", ["Up to date", "TT given today", "Refused"]),
            q_bool("infection-signs", "Infection signs (redness, pus, warmth)?"),
            q_string("dressing-followup", "Next dressing / suture removal date"),
        ],
    },
    {
        "resourceType": "Questionnaire", "url": f"{MP}/questionnaire/af-burn",
        "name": "Burn Assessment", "title": "Burn Assessment", "status": "active",
        "item": [
            q_string("burn-cause", "Cause (open flame, scald, electrical, chemical) & time"),
            q_string("tbsa", "% TBSA (rule of 9s; patient's palm ≈ 1%)"),
            q_choice("burn-depth", "Depth", ["Superficial (red, painful)", "Partial thickness (blisters)", "Full thickness (white/charred, painless)"]),
            q_bool("airway-burn", "Face/airway involvement or inhalation? (URGENT REFERRAL)"),
            q_bool("fluids-started", "IV fluids started if TBSA >10-15% (Parkland: 4mL × kg × %TBSA, half in first 8h)?"),
            q_bool("analgesia", "Analgesia given?"),
            q_bool("cooled-dressed", "Cooled with running water (20 min) & dressed (clean, non-adherent)?"),
            q_choice("burn-disposition", "Disposition", ["Outpatient dressing plan", "REFER (>10% TBSA, full thickness, face/hands/genitals, electrical, child)"]),
            q_text("burn-plan", "Plan & follow-up", True),
        ],
    },
]

# ============================================================
# PLAN DEFINITIONS (Care Templates)
# ============================================================

def plan(url, name, title, actions):
    return {
        "resourceType": "PlanDefinition", "url": url, "name": name, "title": title, "status": "active",
        "type": cc("http://terminology.hl7.org/CodeSystem/plan-definition-type", "order-set", "Order Set"),
        "action": actions,
    }


def qa(aid, title, durl, description=None):
    a = {"id": aid, "title": title, "definitionCanonical": durl}
    if description:
        a["description"] = description
    return a


def charge_action(aid, title, code, display):
    return {"id": aid, "title": title, "code": [cc(SVC, code, display)]}


PLANS = [
    # COMMUNICABLE
    plan(f"{MP}/plandefinition/af-fever-malaria", "Fever / Malaria Workup (Africa)", "Fever / Malaria Workup (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Order Malaria RDT", f"{MP}/activitydefinition/af-malaria-rdt", "Test BEFORE treating (WHO)."),
        qa("a3", "Fever / Malaria Assessment", f"{MP}/questionnaire/af-fever-malaria"),
        qa("a4", "Blood Film if RDT unavailable/negative but suspicion high", f"{MP}/activitydefinition/af-blood-film"),
        charge_action("a5", "GP Consultation", "CONS-GP", "General practitioner consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-tb-screening", "TB Screening & Follow-Up (Africa)", "TB Screening & Follow-Up (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "TB Symptom Screen", f"{MP}/questionnaire/af-tb-screening"),
        qa("a3", "Order Sputum GeneXpert", f"{MP}/activitydefinition/af-sputum-xpert"),
        qa("a4", "Offer HIV Test", f"{MP}/activitydefinition/af-hiv-rapid", "All TB patients/presumptive TB should know their HIV status."),
        charge_action("a5", "GP Consultation", "CONS-GP", "General practitioner consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-hiv-testing", "HIV Testing & Counseling (Africa)", "HIV Testing & Counseling (Africa)", [
        qa("a1", "HIV Counseling & Testing", f"{MP}/questionnaire/af-hiv-counseling"),
        qa("a2", "Order HIV Rapid Test", f"{MP}/activitydefinition/af-hiv-rapid"),
        charge_action("a3", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-imnci-u5", "Under-5 Sick Child — IMNCI (Africa)", "Under-5 Sick Child — IMNCI (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "IMNCI Assessment & Classification", f"{MP}/questionnaire/af-imnci-u5"),
        qa("a3", "Malaria RDT if fever", f"{MP}/activitydefinition/af-malaria-rdt"),
        qa("a4", "Hemoglobin if pallor", f"{MP}/activitydefinition/af-hemoglobin"),
        charge_action("a5", "Under-5 Visit", "CONS-U5", "Under-five sick child consultation (IMNCI)"),
    ]),
    # NON-COMMUNICABLE
    plan(f"{MP}/plandefinition/af-htn-visit", "Hypertension Visit (Africa)", "Hypertension Visit (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Hypertension Review", f"{MP}/questionnaire/af-htn-visit"),
        qa("a3", "Urinalysis (protein)", f"{MP}/activitydefinition/af-urinalysis"),
        charge_action("a4", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-dm-visit", "Diabetes Visit (Africa)", "Diabetes Visit (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Diabetes Review", f"{MP}/questionnaire/af-dm-visit"),
        qa("a3", "Order Blood Glucose", f"{MP}/activitydefinition/af-glucose"),
        qa("a4", "Urinalysis (glucose/protein/ketones)", f"{MP}/activitydefinition/af-urinalysis"),
        charge_action("a5", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-asthma-copd", "Asthma / COPD Review (Africa)", "Asthma / COPD Review (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Respiratory Review", f"{MP}/questionnaire/af-asthma-copd"),
        charge_action("a3", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-epilepsy", "Epilepsy Follow-Up (Africa)", "Epilepsy Follow-Up (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Epilepsy Review", f"{MP}/questionnaire/af-epilepsy"),
        charge_action("a3", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation"),
    ]),
    # TRAUMA
    plan(f"{MP}/plandefinition/af-trauma-acute", "Acute Trauma — ABCDE (Africa)", "Acute Trauma — ABCDE (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Primary & Secondary Survey", f"{MP}/questionnaire/af-trauma-primary"),
        qa("a3", "X-Ray if indicated", f"{MP}/activitydefinition/af-xray-limb"),
        qa("a4", "Tetanus Toxoid if due", f"{MP}/activitydefinition/af-tetanus-tt"),
        charge_action("a5", "GP Consultation", "CONS-GP", "General practitioner consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-wound-care", "Wound Care & Suturing (Africa)", "Wound Care & Suturing (Africa)", [
        qa("a1", "Wound Assessment & Closure", f"{MP}/questionnaire/af-wound-care"),
        qa("a2", "Suturing", f"{MP}/activitydefinition/af-suturing"),
        qa("a3", "Dressing", f"{MP}/activitydefinition/af-dressing"),
        qa("a4", "Tetanus Toxoid if due", f"{MP}/activitydefinition/af-tetanus-tt"),
        charge_action("a5", "Follow-Up Consultation", "CONS-FU", "Follow-up consultation"),
    ]),
    plan(f"{MP}/plandefinition/af-burn", "Burn Assessment & Care (Africa)", "Burn Assessment & Care (Africa)", [
        qa("a1", "Vital Signs", VITALS_Q),
        qa("a2", "Burn Assessment (TBSA, depth, refer criteria)", f"{MP}/questionnaire/af-burn"),
        qa("a3", "Burn Dressing", f"{MP}/chargeItemDefinition/af-burn-dressing"),
        qa("a4", "Tetanus Toxoid if due", f"{MP}/activitydefinition/af-tetanus-tt"),
        charge_action("a5", "GP Consultation", "CONS-GP", "General practitioner consultation"),
    ]),
]

# fix: burn dressing action should reference an ActivityDefinition, not a charge.
ACTIVITIES.append(activity(f"{MP}/activitydefinition/af-burn-dressing", "Burn Dressing",
                           [(LAB, "BURN-DRS", "Burn cleaning and dressing")],
                           f"{MP}/chargeItemDefinition/af-burn-dressing"))
PLANS[-1]["action"][2]["definitionCanonical"] = f"{MP}/activitydefinition/af-burn-dressing"


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


def main():
    tok = token()
    for group, items in (("ChargeItemDefinition", CHARGES), ("Questionnaire", QUESTIONNAIRES),
                         ("ActivityDefinition", ACTIVITIES), ("PlanDefinition", PLANS)):
        for r in items:
            state = upsert(tok, r)
            print(f"{group}: {r.get('title') or r.get('name')} -> {state}")
    print("DONE")


main()
