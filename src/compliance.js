// ============================================================
// Mapping archive evidence to debris-mitigation frameworks.
//
// ── The single most important sentence in this file ─────────
// OrbitIQ does not determine compliance. It holds evidence that supports
// demonstrating some obligations, and this module says which — and, just as
// importantly, which it cannot touch.
//
// That distinction is not lawyerly throat-clearing, it is the product. A tool
// that told an operator "you are FCC compliant" on the strength of public TLE
// screening would be wrong in a way that only surfaces during a licence review
// or after a loss, which is exactly when being wrong is most expensive. The
// FCC's collision-probability requirement, for instance, is a LIFETIME figure
// computed with NASA's Debris Assessment Software or a higher-fidelity tool.
// Nothing here computes that. Screening records are evidence of operational
// practice; they are not a lifetime probability analysis, and this module
// refuses to imply otherwise.
//
// ── Why thresholds are per-mission, not constants ───────────
// It is tempting to hardcode "manoeuvre above 1e-4" because that number is
// widely quoted. ESA's actual practice is a per-mission tolerable probability
// threshold, agreed with the mission, not an industry constant. So every
// obligation that depends on a threshold reads it from the operator's own
// recorded policy, and the report states which threshold was in force.
//
// ── Sources ─────────────────────────────────────────────────
// FCC 47 CFR 25.114(d)(14) — orbital debris mitigation disclosures, including
//   the requirement to assess and limit collision probability with large
//   objects (>=10 cm) over total orbital lifetime to less than 0.001,
//   calculated with NASA DAS or a higher-fidelity tool.
// ISO 24113:2019 — top-level space debris mitigation requirements. The 2019
//   edition added clauses requiring collision risk to be actively managed and
//   avoidance manoeuvres performed where appropriate.
// ESA Space Debris Mitigation Requirements (ESSB-ST-U-007) and ESA Space
//   Debris Office practice — probability-based assessment from CDMs against a
//   mission-specific tolerable threshold.
// ============================================================

/**
 * What kind of support the archive can offer an obligation.
 *
 * The grades matter more than the mapping. "supports" is the honest ceiling
 * for almost everything here: a screening archive can show that you watched
 * and responded, which is corroborating evidence, not proof of conformance.
 */
export const SUPPORT = {
  supports: "Archive holds evidence that directly supports demonstrating this.",
  partial:  "Archive holds evidence relevant to part of this obligation only.",
  none:     "Outside what conjunction screening can evidence. Requires other analysis or records."
};

export const FRAMEWORKS = [
  {
    id: "fcc-odm",
    name: "FCC orbital debris mitigation",
    citation: "47 CFR § 25.114(d)(14)",
    jurisdiction: "United States (FCC-licensed systems)",
    url: "https://www.govinfo.gov/content/pkg/CFR-2022-title47-vol2/pdf/CFR-2022-title47-vol2-sec25-114.pdf",
    obligations: [
      {
        ref: "25.114(d)(14) collision risk",
        text: "Assess and limit the probability of collision with large objects (10 cm or larger) "
            + "over the total orbital lifetime, including de-orbit phases, to less than 0.001, "
            + "calculated using NASA's Debris Assessment Software or a higher-fidelity tool.",
        support: "none",
        why: "This is a LIFETIME probability from a design-stage tool. OrbitIQ screens live "
           + "element sets over days, not the mission lifetime, and does not run DAS. Nothing "
           + "in this archive substitutes for that analysis.",
        evidence: []
      },
      {
        ref: "25.114(d)(14) collision avoidance practice",
        text: "Disclose the risk of accidental collision and the measures taken to mitigate it.",
        support: "supports",
        why: "A continuous screening record with recorded operator responses is direct evidence "
           + "of the mitigation measures actually in place, as distinct from those proposed.",
        evidence: ["conjunction", "decision"]
      },
      {
        ref: "25.114(d)(14) orbital tolerance",
        text: "Disclose the accuracy with which orbital parameters will be maintained, and if "
            + "tolerances cannot be maintained, the anticipated evolution of the orbit.",
        support: "partial",
        why: "Archived element-set history shows how the orbit actually evolved and when "
           + "manoeuvres occurred. It evidences realised behaviour, not the declared tolerance.",
        evidence: ["maneuver", "conjunction"]
      }
    ]
  },
  {
    id: "iso-24113",
    name: "ISO 24113 space debris mitigation requirements",
    citation: "ISO 24113:2019 / :2023",
    jurisdiction: "International standard, referenced by many national regimes",
    url: "https://www.iso.org/standard/72383.html",
    obligations: [
      {
        ref: "Active collision risk management",
        text: "Spacecraft collision risk shall be actively managed, and avoidance manoeuvres "
            + "performed where appropriate. (Clauses added in the 2019 edition.)",
        support: "supports",
        why: "This is the obligation the archive was built for. A dated, tamper-evident record "
           + "of screening plus the decisions taken against a stated threshold is the most "
           + "direct evidence of active management that an operator can produce.",
        evidence: ["conjunction", "decision"]
      },
      {
        ref: "No intentional debris release",
        text: "Avoid intentional release of space debris during normal operations.",
        support: "none",
        why: "Not observable from element sets. Evidenced by design and operations records.",
        evidence: []
      },
      {
        ref: "Post-mission disposal",
        text: "Remove spacecraft and orbital stages from protected regions after end of mission.",
        support: "partial",
        why: "Decay and re-entry tracking evidences what happened to an object after operations "
           + "ceased, but disposal compliance is judged against the mission's own plan.",
        evidence: ["reentry"]
      },
      {
        ref: "Debris and meteoroid impact risk assessment",
        text: "Assess debris/meteoroid impact risk during spacecraft design. (2019 edition.)",
        support: "none",
        why: "A design-stage analysis. Nothing operational evidences it.",
        evidence: []
      }
    ]
  },
  {
    id: "esa-sdm",
    name: "ESA space debris mitigation requirements",
    citation: "ESSB-ST-U-007",
    jurisdiction: "ESA missions and ESA-contracted programmes",
    url: "https://technology.esa.int/upload/media/ESA-Space-Debris-Mitigation-Requirements-ESSB-ST-U-007-Issue1.pdf",
    obligations: [
      {
        ref: "Probability-based conjunction assessment",
        text: "Assess collision risk on a probability basis against the mission's tolerable "
            + "probability threshold, and plan avoidance action when that threshold is exceeded.",
        support: "supports",
        why: "Screening records carry a computed probability per event, and decisions record the "
           + "threshold in force at the time. Note ESA's operational practice works from CDMs; "
           + "this archive works from public element sets, which is a weaker input and is "
           + "labelled as such on every row.",
        evidence: ["conjunction", "decision"]
      },
      {
        ref: "Manoeuvre screening",
        text: "Confirm that a planned avoidance manoeuvre achieves the intended risk reduction "
            + "and does not raise the risk of other conjunctions to unacceptable levels.",
        support: "supports",
        why: "Post-manoeuvre re-screening produces exactly this: the risk against the original "
           + "object and against everything else the burn moves you toward.",
        evidence: ["manoeuvre-screen", "decision"]
      }
    ]
  }
];

/** Which archive record types can back each obligation, flattened. */
export const evidenceTypes = () => {
  const s = new Set();
  for (const f of FRAMEWORKS) for (const o of f.obligations) o.evidence.forEach(e => s.add(e));
  return [...s];
};

/**
 * Coverage for one operator over one window.
 *
 * Reports, per obligation, whether the archive actually holds the evidence
 * types that obligation depends on — not whether the operator complied.
 * An obligation graded "none" stays "none" no matter how much data exists,
 * because more screening records cannot evidence a design-stage analysis.
 */
export function coverage({ counts = {}, thresholdPc = null, frameworkIds = null } = {}) {
  const frameworks = FRAMEWORKS
    .filter(f => !frameworkIds || frameworkIds.includes(f.id))
    .map(f => {
      const obligations = f.obligations.map(o => {
        const have = o.evidence.filter(t => (counts[t] || 0) > 0);
        const missing = o.evidence.filter(t => !(counts[t] || 0));
        return {
          ref: o.ref,
          text: o.text,
          support: o.support,
          supportMeans: SUPPORT[o.support],
          why: o.why,
          evidenceRequired: o.evidence,
          evidenceHeld: have,
          evidenceMissing: missing,
          // Only meaningful where support is possible at all.
          status: o.support === "none" ? "not-evidenceable"
                : missing.length === 0 ? "evidence-held"
                : have.length ? "evidence-partial" : "evidence-absent"
        };
      });
      return {
        id: f.id, name: f.name, citation: f.citation,
        jurisdiction: f.jurisdiction, url: f.url,
        obligations,
        summary: {
          total: obligations.length,
          evidenceHeld: obligations.filter(o => o.status === "evidence-held").length,
          partial: obligations.filter(o => o.status === "evidence-partial").length,
          absent: obligations.filter(o => o.status === "evidence-absent").length,
          notEvidenceable: obligations.filter(o => o.status === "not-evidenceable").length
        }
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    thresholdPc,
    thresholdNote: thresholdPc == null
      ? "No mission threshold recorded. Obligations that turn on a threshold cannot be "
      + "assessed without one; set the fleet policy threshold first."
      : "Assessed against the mission's own recorded threshold. Debris-mitigation regimes "
      + "generally set a per-mission tolerable probability rather than an industry constant.",
    frameworks,
    // Repeated at the top level because it is the sentence most likely to be
    // skipped, and the one that most needs reading.
    limits: "OrbitIQ does not determine compliance and does not issue certification. This maps "
          + "archive evidence to published obligations so an operator can see what they can "
          + "substantiate and what they cannot. Obligations graded 'none' are outside what "
          + "conjunction screening can evidence at all — notably the FCC lifetime collision "
          + "probability, which requires NASA DAS or a higher-fidelity tool. Screening here "
          + "uses public element sets, which carry no covariance; probabilities are modelled "
          + "and labelled accordingly."
  };
}

export const frameworkList = () =>
  FRAMEWORKS.map(({ id, name, citation, jurisdiction, url, obligations }) =>
    ({ id, name, citation, jurisdiction, url, obligations: obligations.length }));
