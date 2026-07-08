function normalizeDecision({ status, category, subStatus, reason, message, score, confidence }) {
  const safeCategory = String(category || "").toLowerCase();
  let normalizedCategory = safeCategory;
  let normalizedStatus = status;

  if (!["valid", "invalid", "risky", "unknown"].includes(normalizedCategory)) {
    normalizedCategory = "unknown";
  }

  if (!normalizedStatus) {
    normalizedStatus =
      normalizedCategory === "valid"
        ? "Valid"
        : normalizedCategory === "invalid"
          ? "Invalid"
          : normalizedCategory === "risky"
            ? "Risky"
            : "Unknown";
  }

  return {
    status: normalizedStatus,
    category: normalizedCategory,
    subStatus: subStatus || null,
    reason: reason || "",
    message: message || "",
    score: typeof score === "number" ? score : 0,
    confidence: typeof confidence === "number" ? confidence : null,
  };
}

function evaluateEarlyRisk({
  domain,
  isManualHighRisk,
  isTwDomain,
  isBankOrHealthcare,
  highBounce,
}) {
  if (isManualHighRisk) {
    return normalizeDecision({
      status: "Risky",
      category: "risky",
      subStatus: "high_risk_domain",
      reason: "Manual High-Risk Domain",
      message:
        "This domain is configured under manual high-risk domains. Email is marked risky directly without validation.",
      score: 25,
      confidence: 0.95,
    });
  }

  if (isTwDomain) {
    return normalizeDecision({
      status: "Risky",
      category: "risky",
      subStatus: "tw_domain",
      reason: "Restricted Country TLD",
      message:
        "This address belongs to a Taiwanese domain (.tw). SMTP probing is unreliable for .tw domains and sending cold emails is risky.",
      score: 30,
      confidence: 0.9,
    });
  }

  if (highBounce?.block) {
    return normalizeDecision({
      status: "Risky",
      category: "risky",
      subStatus: "high_bounce_domain_reputation",
      reason: "High Bounce Domain Reputation",
      message: `Domain ${domain} has high historical bounce rate (${(
        (highBounce.bounceRate || 0) * 100
      ).toFixed(1)}% across ${highBounce.sent || 0} sends). Marked risky before sending.`,
      score: 20,
      confidence: 0.92,
    });
  }

  if (isBankOrHealthcare) {
    return normalizeDecision({
      status: "Risky",
      category: "risky",
      subStatus: "bank_healthcare_domain",
      reason: "High-Risk Domain",
      message:
        "This address belongs to a banking or healthcare domain. Sending cold emails to these domains is risky.",
      score: 30,
      confidence: 0.9,
    });
  }

  return null;
}

function shouldUseSendGridDirect({
  tld,
  isBankOrHealthcare,
  isProofpoint,
  isMimecast,
  isOutlookProvider = false,
}) {
  const isEduGovOrgDomain = tld === "edu" || tld === "gov" || tld === "org";
  const isTargetSendgridSuffix =
    tld === "us" ||
    tld === "uk" ||
    tld === "eu" ||
    tld === "it" ||
    tld === "gov" ||
    tld === "ca" ||
    tld === "br";

  const shouldUseEduGovOrgDirect = isEduGovOrgDomain && !isOutlookProvider;

  return (
    shouldUseEduGovOrgDirect ||
    isBankOrHealthcare ||
    ((isProofpoint || isMimecast) && isTargetSendgridSuffix)
  );
}

module.exports = {
  normalizeDecision,
  evaluateEarlyRisk,
  shouldUseSendGridDirect,
};
