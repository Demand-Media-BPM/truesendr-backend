// backend/utils/domainClassifier.js
// ============================================================================
// DOMAIN CLASSIFIER - Detect Bank, Healthcare, and High-Risk Domains
// ============================================================================

/**
 * Known bank domains (major US and international banks)
 */
const BANK_DOMAINS = [
  // US Banks (Top 50)
  'chase.com',
  'wellsfargo.com',
  'bankofamerica.com',
  'citi.com',
  'usbank.com',
  'pnc.com',
  'capitalone.com',
  'tdbank.com',
  'bbt.com',
  'truist.com',
  'suntrust.com',
  'regions.com',
  'fifththird.com',
  'keybank.com',
  'ally.com',
  'discover.com',
  'americanexpress.com',
  'goldmansachs.com',
  'morganstanley.com',
  'jpmorganchase.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'citizensbank.com',
  'huntington.com',
  'mufg.com',
  'mtb.com', // M&T Bank
  'comerica.com',
  'zionsbank.com',
  'synovus.com',
  'bok.com', // Bank of Oklahoma
  'firsthorizon.com',
  'websterbank.com',
  'valleybank.com',
  'bankunited.com',
  'easternbank.com',
  'fnb-online.com',
  'frostbank.com',
  'umpquabank.com',
  'bankwest.com',
  'firstrepublic.com',
  'svb.com', // Silicon Valley Bank
  'signaturebank.com',
  'nycommunitybankcom',
  'westernu nion.com',
  'paypal.com',
  'square.com',
  'stripe.com',
  'braintreepayments.com',
  
  // Credit Unions
  'navyfederal.org',
  'penfed.org',
  'alliantcreditunion.org',
  
  // UK Banks
  'hsbc.com',
  'hsbc.co.uk',
  'barclays.com',
  'barclays.co.uk',
  'lloydsbanking.com',
  'lloydsbank.com',
  'nationwide.co.uk',
  'natwest.com',
  'rbs.com',
  'santander.co.uk',
  'tsb.co.uk',
  'metrobankonline.co.uk',
  'co-operativebank.co.uk',
  'halifax.co.uk',
  'bankofscotland.co.uk',
  'standardchartered.com',
  
  // European Banks
  'bnpparibas.com',
  'deutschebank.com',
  'credit-suisse.com',
  'ubs.com',
  'santander.com',
  'santander.de',
  'ing.com',
  'ing.de',
  'ing.nl',
  'rabobank.com',
  'rabobank.nl',
  'abn-amro.com',
  'commerzbank.com',
  'unicredit.it',
  'intesasanpaolo.com',
  'societegenerale.com',
  'creditagricole.com',
  'pfandbriefbank.com',
  'kbc.com',
  'kbc.be',
  
  // Nordic Banks
  'dnb.com',
  'dnb.no',
  'nordea.com',
  'nordea.fi',
  'nordea.se',
  'nordea.no',
  'nordea.dk',
  'swedbank.se',
  'swedbank.com',
  'swedbank.lt',
  'swedbank.lv',
  'swedbank.ee',
  'handelsbanken.se',
  'handelsbanken.com',
  'handelsbanken.no',
  'handelsbanken.fi',
  'seb.se',
  'seb.com',
  'seb.no',
  'seb.ee',
  'danskebank.com',
  'danskebank.dk',
  'danskebank.no',
  'danskebank.se',
  'danskebank.fi',
  
  // Asian Banks
  'dbs.com',
  'dbs.com.sg',
  'ocbc.com',
  'uob.com',
  'maybank.com',
  'cimb.com',
  'icbc.com.cn',
  'boc.cn',
  'ccb.com',
  'abchina.com',
  'bankcomm.com',
  'cmb.com',
  'cib.com.cn',
  'spdb.com.cn',
  'citicbank.com',
  'hdfcbank.com',
  'icicibank.com',
  'axisbank.com',
  'sbi.co.in',
  'kotak.com',
  
  // Australian Banks
  'commbank.com.au',
  'westpac.com.au',
  'anz.com',
  'nab.com.au',
  'bendigobank.com.au',
  
  // Canadian Banks
  'rbc.com',
  'td.com',
  'scotiabank.com',
  'bmo.com',
  'cibc.com',
  'nbc.ca',
  'desjardins.com',
  
  // Middle East Banks
  'emiratesnbd.com',
  'adcb.com',
  'dib.ae',
  'qnb.com',
  'samba.com',
  'alrajhibank.com.sa',
  
  // Latin American Banks
  'itau.com.br',
  'bradesco.com.br',
  'santander.com.br',
  'bancodobrasil.com.br',
  'banorte.com',
  'bbva.mx',
  
  // Investment/Corporate Banks
  'bny.com',
  'us.bny.com',
  'townebank.com',
  'citigroup.com',
  'jefferies.com',
  'lazard.com',
  'evercore.com',
  'piper sandler.com',
  'stifel.com',
  'raymondjames.com',
  'edwardjones.com',
  'rbccm.com',
  'credit-suisse.com',
  'nomura.com',
  'mizuho-fg.co.jp',
  'smbc.co.jp',
];

/**
 * Known healthcare domains
 */
const HEALTHCARE_DOMAINS = [
  // Major Healthcare Systems (US)
  'mayoclinic.org',
  'clevelandclinic.org',
  'johnshopkins.edu',
  'massgeneral.org',
  'cedars-sinai.org',
  'nyp.org',
  'upmc.com',
  'kp.org', // Kaiser Permanente
  'kaiserpermanente.org',
  'sutterhealth.org',
  'dignityhealth.org',
  'providence.org',
  'commonspirit.org',
  'hcahealthcare.com',
  'tenethealth.com',
  'adventhealth.com',
  'memorialhermann.org',
  'methodisthealth.com',
  'baptisthealth.net',
  'scripps.org',
  'ochsner.org',
  'beaumont.org',
  'henryford.com',
  'advocatehealth.com',
  'nm.org', // Northwestern Medicine
  'rush.edu',
  'uchicagomedicine.org',
  'mountsinai.org',
  'montefiore.org',
  'northwell.edu',
  'pennmedicine.org',
  'dukehealth.org',
  'wakehealth.edu',
  'vumc.org', // Vanderbilt
  'uabmedicine.org',
  'uhhospitals.org',
  'osumc.edu',
  'med.umich.edu',
  'uchealth.org',
  'stanfordhealthcare.org',
  'uclahealth.org',
  'ucsf.edu',
  'ucsd.edu',
  'health.ucdavis.edu',
  'ucihealth.org',
  'chop.edu', // Children's Hospital Philadelphia
  'childrens.com', // Children's Healthcare
  'nationwidechildrens.org',
  'texaschildrens.org',
  'seattlechildrens.org',
  'chla.org', // Children's Hospital LA
  'cincinnatichildrens.org',
  'childrensmn.org',
  'childrenscolorado.org',
  'choa.org', // Children's Healthcare Atlanta
  'mskcc.org', // Memorial Sloan Kettering
  'mdanderson.org',
  'dana-farber.org',
  'fredhutch.org',
  'cityofhope.org',
  'roswellpark.org',
  'foxchase.org',
  
  // Insurance/Health Plans (US)
  'uhc.com',
  'unitedhealthcare.com',
  'anthem.com',
  'wellpoint.com',
  'aetna.com',
  'cigna.com',
  'humana.com',
  'bcbs.com', // Blue Cross Blue Shield
  'bcbsm.com',
  'bcbsma.com',
  'bluecrossma.com',
  'bcbsnc.com',
  'bcbstx.com',
  'bcbsil.com',
  'bcbsfl.com',
  'premera.com',
  'regence.com',
  'healthnet.com',
  'molina.com',
  'centene.com',
  'wellcare.com',
  'ambetter.com',
  'healthfirst.org',
  'emblemhealth.com',
  'oscar.com',
  'bright.com',
  'clover.com',
  'devoted.com',
  'alignment.com',
  
  // Pharmacy & Retail Health
  'cvs.com',
  'cvshealth.com',
  'cvspharmacy.com',
  'walgreens.com',
  'walgreensbootsalliance.com',
  'riteaid.com',
  'hy-vee.com',
  'kroger.com',
  'walmart.com',
  'target.com',
  'costco.com',
  'samsclub.com',
  'publix.com',
  'albertsons.com',
  'safeway.com',
  'wegmans.com',
  'heb.com',
  'meijer.com',
  'giantfood.com',
  'stopandshop.com',
  'express-scripts.com',
  'optum.com',
  'optumrx.com',
  'caremark.com',
  'primetherapeutics.com',
  'magellanhealth.com',
  
  // Telehealth & Digital Health
  'teladoc.com',
  'mdlive.com',
  'amwell.com',
  'doctorsondemand.com',
  '98point6.com',
  'plushcare.com',
  'lemonaidhealth.com',
  'ro.co',
  'hims.com',
  'hers.com',
  'nurx.com',
  'simple.health',
  'cerebral.com',
  'talkspace.com',
  'betterhelp.com',
  'lyrahealth.com',
  'ginger.com',
  'headspace.com',
  'calm.com',
  
  // Dental Practices & Chains
  'shandleykanedental.com',
  'bhpediatricdentistry.com',
  'whfamilydentistry.com',
  'aspen-dental.com',
  'heartland-dental.com',
  'pacificdental.com',
  'westerndentalcom',
  'gentledental.com',
  'affordabledentures.com',
  'monarchdental.com',
  'interdent.com',
  'deltadentalins.com',
  'deltadentalwa.com',
  'deltadental.com',
  
  // Healthcare Systems & Hospitals (Regional)
  'jeffersonhealthcare.org',
  'christianacare.org',
  'fatebenefratelli.it',
  'geisinger.org',
  'intermountainhealthcare.org',
  'sharp.com',
  'hoag.org',
  'llu.edu', // Loma Linda
  'eisenhowerhealth.org',
  'bannerhealth.com',
  'honorhealth.com',
  'dignityhealth.org',
  'sclhealth.org',
  'healthone.com',
  'bswhealth.com',
  'utsouthwestern.edu',
  'houstonmethodist.org',
  'stlukes-health.org',
  'memorialhermann.org',
  'christushealth.org',
  'scottandwhite.org',
  'parklandhealth.org',
  'allina.com',
  'healthpartners.com',
  'essentia.org',
  'sanfordhealth.org',
  'avera.org',
  'billingsclinic.com',
  'providence.org',
  'multicare.org',
  'swedish.org',
  'overlakehospital.org',
  'valleyhealthsystem.com',
  'atlantichealth.org',
  'rwjbh.org',
  'hackensackmeridian.org',
  'virtua.org',
  'cooperhealth.org',
  
  // Healthcare Services & Medical Devices
  'safecare.com',
  'alarm.com',
  'lifealert.com',
  'medicalguardian.com',
  'philips.com', // Healthcare division
  'gehealthcare.com',
  'siemens-healthineers.com',
  'medtronic.com',
  'abbottcom',
  'jnj.com', // Johnson & Johnson
  'bd.com', // Becton Dickinson
  'baxter.com',
  'stryker.com',
  'bostonscientific.com',
  'edwards.com',
  'zimmer.com',
  'smithnephew.com',
  
  // Insurance & Financial Health
  'pacificlife.com',
  'experian.com',
  'equifax.com',
  'transunion.com',
  'metlife.com',
  'prudential.com',
  'newyorklife.com',
  'massmutual.com',
  'northwesternmutual.com',
  'guardian.com',
  'principal.com',
  'nationwide.com',
  'libertymutual.com',
  'allstate.com',
  'statefarm.com',
  'geico.com',
  'progressive.com',
  'travelers.com',
  'thehartford.com',
  'aflac.com',
  'unum.com',
  'lincolnfinancial.com',
  
  // Lab & Diagnostics
  'labcorp.com',
  'questdiagnostics.com',
  'sonoraquest.com',
  'bioreference.com',
  'aruplab.com',
  'mayocliniclabs.com',
  
  // Medical Staffing & Services
  'davita.com',
  'fresenius.com',
  'kindred.com',
  'encompasshealth.com',
  'selectmedical.com',
  'amedisys.com',
  'lhcgroup.com',
  'brookdale.com',
  'sunrise-care.com',
  'atria.com',
  
  // Veterinary (also healthcare)
  'vca.com',
  'banfield.com',
  'bluepearl.vet',
  'idexx.com',
  'zoetis.com',
];

/**
 * Keywords that indicate bank/financial domains
 */
const BANK_KEYWORDS = [
  'bank',
  'banking',
  'financial',
  'finance',
  'credit',
  'loan',
  'mortgage',
  'investment',
  'wealth',
  'capital',
  'trust',
  'securities',
  'treasury',
  'fcu', // Federal Credit Union
  'creditunion',
];

/**
 * Keywords that indicate healthcare domains
 */
const HEALTHCARE_KEYWORDS = [
  'health',
  'healthcare',
  'medical',
  'medicine',
  'clinic',
  'hospital',
  'doctor',
  'physician',
  'patient',
  'pharmacy',
  'pharma',
  'dental',
  'vision',
  'insurance',
  'care',
  'wellness',
  'rehab',
  'surgery',
  'diagnostic',
  'laboratory',
  'lab',
];

/**
 * Check if domain is a known bank
 */
function isKnownBankDomain(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return BANK_DOMAINS.includes(d);
}

/**
 * Check if domain is a known healthcare provider
 */
function isKnownHealthcareDomain(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return HEALTHCARE_DOMAINS.includes(d);
}

/**
 * Check if domain contains bank-related keywords
 */
function hasBankKeywords(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return BANK_KEYWORDS.some(keyword => d.includes(keyword));
}

/**
 * Check if domain contains healthcare-related keywords
 */
function hasHealthcareKeywords(domain) {
  const d = String(domain || '').toLowerCase().trim();
  return HEALTHCARE_KEYWORDS.some(keyword => d.includes(keyword));
}

/**
 * Main classifier: Determine if domain is bank or healthcare
 * Returns: { isBank: boolean, isHealthcare: boolean, reason: string }
 */
function classifyDomain(domain) {
  const d = String(domain || '').toLowerCase().trim();
  
  if (!d || d === 'n/a') {
    return { isBank: false, isHealthcare: false, reason: null };
  }

  // Check known lists first (most reliable)
  if (isKnownBankDomain(d)) {
    return { isBank: true, isHealthcare: false, reason: 'known_bank_domain' };
  }
  
  if (isKnownHealthcareDomain(d)) {
    return { isBank: false, isHealthcare: true, reason: 'known_healthcare_domain' };
  }

  // Check keywords (less reliable but catches variations)
  if (hasBankKeywords(d)) {
    return { isBank: true, isHealthcare: false, reason: 'bank_keyword_match' };
  }
  
  if (hasHealthcareKeywords(d)) {
    return { isBank: false, isHealthcare: true, reason: 'healthcare_keyword_match' };
  }

  return { isBank: false, isHealthcare: false, reason: null };
}

/**
 * Check if domain is bank OR healthcare (high-risk category)
 */
function isHighRiskDomain(domain) {
  const classification = classifyDomain(domain);
  return classification.isBank || classification.isHealthcare;
}

/**
 * Get domain category label
 */
function getDomainCategory(domain) {
  const classification = classifyDomain(domain);
  
  if (classification.isBank) return 'Banking/Financial';
  if (classification.isHealthcare) return 'Healthcare/Medical';
  return null;
}

module.exports = {
  // Main functions
  classifyDomain,
  isHighRiskDomain,
  getDomainCategory,
  
  // Individual checks
  isKnownBankDomain,
  isKnownHealthcareDomain,
  hasBankKeywords,
  hasHealthcareKeywords,
  
  // Lists (for reference/extension)
  BANK_DOMAINS,
  HEALTHCARE_DOMAINS,
  BANK_KEYWORDS,
  HEALTHCARE_KEYWORDS,
};
