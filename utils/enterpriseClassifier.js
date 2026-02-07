// backend/utils/enterpriseClassifier.js
// ============================================================================
// ENTERPRISE DOMAIN CLASSIFIER - Detect Corporate Catch-All Domains
// These domains often have catch-all email gateways that accept all emails
// ============================================================================

/**
 * Known enterprise/corporate domains with catch-all behavior
 * These domains should use SendGrid verification instead of SMTP
 */
const ENTERPRISE_CATCHALL_DOMAINS = [
  // Energy & Oil
  'shell.com',
  'petronas.com',
  
  // Technology & Consulting
  'atos.net',
  
  // Manufacturing & Industrial
  'rolls-royce.com',
  'elesa.com',
  'faac.it',
  'liujo.it',
  
  // Media & Publishing
  'theglobeandmail.com',
  
  // Logistics & Distribution
  'dksh.com',
  
  // Canadian Enterprises
  'mbll.ca',
  
  // Add more as you discover them
];

/**
 * Keywords that indicate enterprise/corporate domains
 */
const ENTERPRISE_KEYWORDS = [
  'corp',
  'corporate',
  'group',
  'holdings',
  'international',
  'global',
  'worldwide',
  'enterprise',
  'industries',
];

/**
 * Check if domain is a known enterprise with catch-all
 */
function isKnownEnterpriseDomain(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return ENTERPRISE_CATCHALL_DOMAINS.includes(d);
}

/**
 * Check if domain contains enterprise keywords
 */
function hasEnterpriseKeywords(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return ENTERPRISE_KEYWORDS.some(keyword => d.includes(keyword));
}

/**
 * Classify if domain is enterprise with likely catch-all
 * Returns: { isEnterprise: boolean, reason: string }
 */
function classifyEnterprise(domain) {
  const d = String(domain || '').toLowerCase().trim();
  
  if (!d || d === 'n/a') {
    return { isEnterprise: false, reason: null };
  }

  // Check known list first
  if (isKnownEnterpriseDomain(d)) {
    return { isEnterprise: true, reason: 'known_enterprise_catchall' };
  }
  
  // Check keywords (less reliable)
  if (hasEnterpriseKeywords(d)) {
    return { isEnterprise: true, reason: 'enterprise_keyword_match' };
  }

  return { isEnterprise: false, reason: null };
}

/**
 * Get enterprise category label
 */
function getEnterpriseCategory(domain) {
  const classification = classifyEnterprise(domain);
  
  if (classification.isEnterprise) return 'Enterprise/Corporate';
  return null;
}

module.exports = {
  // Main functions
  classifyEnterprise,
  isKnownEnterpriseDomain,
  getEnterpriseCategory,
  hasEnterpriseKeywords,
  
  // Lists (for reference/extension)
  ENTERPRISE_CATCHALL_DOMAINS,
  ENTERPRISE_KEYWORDS,
};
