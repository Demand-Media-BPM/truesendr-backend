// ---------------------------------------------------------------------------
// Geo + Tax (Phase-1)
// ---------------------------------------------------------------------------
const COUNTRY_TAX_MAP = {
  AF: { countryName: "Afghanistan", taxName: "No VAT", taxRate: 0.0 },

  AL: {
    countryName: "Albania",
    taxName: "VAT",
    taxRate: 0.2,
    note: "6% tourism services (reduced)",
  },
  DZ: {
    countryName: "Algeria",
    taxName: "VAT",
    taxRate: 0.19,
    note: "9% reduced",
  },
  AD: {
    countryName: "Andorra",
    taxName: "IGI",
    taxRate: 0.045,
    note: "Standard IGI 4.5%",
  },
  AO: { countryName: "Angola", taxName: "VAT", taxRate: 0.14 },

  AR: { countryName: "Argentina", taxName: "VAT", taxRate: 0.21 },
  AM: { countryName: "Armenia", taxName: "VAT", taxRate: 0.2 },
  AU: {
    countryName: "Australia",
    taxName: "GST",
    taxRate: 0.1,
    note: "0% on essential items",
  },
  AT: {
    countryName: "Austria",
    taxName: "VAT",
    taxRate: 0.2,
    note: "13% tourism, 10% basic items",
  },
  AZ: { countryName: "Azerbaijan", taxName: "VAT", taxRate: 0.18 },

  BH: {
    countryName: "Bahrain",
    taxName: "VAT",
    taxRate: 0.1,
    note: "0% essential goods",
  },
  BD: { countryName: "Bangladesh", taxName: "VAT", taxRate: 0.15 },
  BY: {
    countryName: "Belarus",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% reduced",
  },
  BE: {
    countryName: "Belgium",
    taxName: "VAT",
    taxRate: 0.21,
    note: "12% restaurants, 6% reduced",
  },
  BZ: {
    countryName: "Belize",
    taxName: "Sales Tax",
    taxRate: 0.125,
    note: "12.5% (shown as Sales/GST style)",
  },
  BJ: { countryName: "Benin", taxName: "VAT", taxRate: 0.18 },
  BT: {
    countryName: "Bhutan",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  BO: { countryName: "Bolivia", taxName: "VAT", taxRate: 0.13 },
  BA: { countryName: "Bosnia & Herzegovina", taxName: "VAT", taxRate: 0.17 },
  BW: { countryName: "Botswana", taxName: "VAT", taxRate: 0.14 },
  BR: {
    countryName: "Brazil",
    taxName: "Sales Tax",
    taxRate: 0.2,
    note: "Shown as 20–30.7% (varies); using 20% baseline",
  },
  BG: {
    countryName: "Bulgaria",
    taxName: "VAT",
    taxRate: 0.2,
    note: "9% hotels/camping",
  },

  KH: { countryName: "Cambodia", taxName: "VAT", taxRate: 0.1 },
  CM: { countryName: "Cameroon", taxName: "VAT", taxRate: 0.1925 },
  CA: {
    countryName: "Canada",
    taxName: "GST",
    taxRate: 0.05,
    note: "Shown as 5% to 15% (varies by province); provincial tax not included",
  },
  CL: { countryName: "Chile", taxName: "VAT", taxRate: 0.19 },
  CN: {
    countryName: "China",
    taxName: "VAT",
    taxRate: 0.13,
    note: "9%/6% reduced; 0% exports",
  },
  CO: {
    countryName: "Colombia",
    taxName: "VAT",
    taxRate: 0.19,
    note: "5% or 0% reduced",
  },
  CR: {
    countryName: "Costa Rica",
    taxName: "VAT",
    taxRate: 0.13,
    note: "Reduced rates down to 1%",
  },
  HR: {
    countryName: "Croatia",
    taxName: "VAT",
    taxRate: 0.25,
    note: "13% reduced",
  },
  CU: {
    countryName: "Cuba",
    taxName: "Sales Tax",
    taxRate: 0.025,
    note: "Shown as 2.5–20% (varies); using 2.5% baseline",
  },
  CY: {
    countryName: "Cyprus",
    taxName: "VAT",
    taxRate: 0.19,
    note: "5% or 0% reduced",
  },
  CZ: {
    countryName: "Czech Republic",
    taxName: "VAT",
    taxRate: 0.21,
    note: "12% reduced",
  },

  DK: { countryName: "Denmark", taxName: "VAT", taxRate: 0.25 },
  DO: { countryName: "Dominican Republic", taxName: "VAT", taxRate: 0.18 },

  EC: {
    countryName: "Ecuador",
    taxName: "VAT",
    taxRate: 0.12,
    note: "15% luxury; 0% exports",
  },
  EG: {
    countryName: "Egypt",
    taxName: "VAT",
    taxRate: 0.14,
    note: "10% professional services; 0% exports",
  },
  EE: {
    countryName: "Estonia",
    taxName: "VAT",
    taxRate: 0.22,
    note: "9% reduced",
  },
  ET: {
    countryName: "Ethiopia",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },

  FI: {
    countryName: "Finland",
    taxName: "VAT",
    taxRate: 0.255,
    note: "14% food; 10% medicines/public transport",
  },
  FR: {
    countryName: "France",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10%/5.5%/2.1% reduced",
  },

  GE: { countryName: "Georgia", taxName: "VAT", taxRate: 0.18 },
  DE: {
    countryName: "Germany",
    taxName: "VAT",
    taxRate: 0.19,
    note: "7% reduced",
  },
  GH: {
    countryName: "Ghana",
    taxName: "VAT",
    taxRate: 0.03,
    note: "Shown as 3% in VAT/GST/Sales column in source",
  },
  GR: {
    countryName: "Greece",
    taxName: "VAT",
    taxRate: 0.24,
    note: "13%/6% reduced; island reductions apply",
  },
  GT: { countryName: "Guatemala", taxName: "VAT", taxRate: 0.12 },

  HN: {
    countryName: "Honduras",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  HK: { countryName: "Hong Kong", taxName: "No VAT", taxRate: 0.0 },
  HU: {
    countryName: "Hungary",
    taxName: "VAT",
    taxRate: 0.27,
    note: "18%/5% reduced",
  },

  IS: {
    countryName: "Iceland",
    taxName: "VAT",
    taxRate: 0.24,
    note: "11% reduced",
  },
  IN: {
    countryName: "India",
    taxName: "GST",
    taxRate: 0.18,
    note: "Multiple GST slabs exist; 18% standard",
  },
  ID: { countryName: "Indonesia", taxName: "VAT", taxRate: 0.11 },
  IR: {
    countryName: "Iran",
    taxName: "VAT",
    taxRate: 0.09,
    note: "Shown as 0–9% (varies); using 9% max/standard",
  },
  IQ: {
    countryName: "Iraq",
    taxName: "Sales Tax",
    taxRate: 0.1,
    note: "Various special rates listed; 10% restaurants/hotels",
  },
  IE: {
    countryName: "Ireland",
    taxName: "VAT",
    taxRate: 0.23,
    note: "Goods 23%; services 9–13.5%; some 0%",
  },
  IL: {
    countryName: "Israel",
    taxName: "VAT",
    taxRate: 0.18,
    note: "0% on fruits/vegetables",
  },
  IT: {
    countryName: "Italy",
    taxName: "VAT",
    taxRate: 0.22,
    note: "10%/4% reduced",
  },

  JM: {
    countryName: "Jamaica",
    taxName: "Sales Tax",
    taxRate: 0.165,
    note: "Goods 16.5%, services 20%",
  },
  JP: {
    countryName: "Japan",
    taxName: "Consumption Tax",
    taxRate: 0.1,
    note: "8% groceries/takeout/subscriptions (reduced)",
  },
  JO: { countryName: "Jordan", taxName: "Sales Tax", taxRate: 0.16 },

  KZ: { countryName: "Kazakhstan", taxName: "VAT", taxRate: 0.13 },
  KE: {
    countryName: "Kenya",
    taxName: "VAT",
    taxRate: 0.16,
    note: "12% electricity/fuel; 0% food",
  },
  KR: { countryName: "South Korea", taxName: "VAT", taxRate: 0.1 },
  KW: { countryName: "Kuwait", taxName: "No VAT", taxRate: 0.0 },

  LA: {
    countryName: "Laos",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  LV: {
    countryName: "Latvia",
    taxName: "VAT",
    taxRate: 0.21,
    note: "12%/5% reduced",
  },
  LB: { countryName: "Lebanon", taxName: "VAT", taxRate: 0.11 },
  LY: {
    countryName: "Libya",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  LI: {
    countryName: "Liechtenstein",
    taxName: "VAT",
    taxRate: 0.081,
    note: "3.8% lodging; 2.5% reduced",
  },
  LT: {
    countryName: "Lithuania",
    taxName: "VAT",
    taxRate: 0.21,
    note: "9%/5% reduced; some 0%",
  },
  LU: {
    countryName: "Luxembourg",
    taxName: "VAT",
    taxRate: 0.17,
    note: "3% reduced",
  },
  MO: { countryName: "Macau", taxName: "No VAT", taxRate: 0.0 },

  MY: {
    countryName: "Malaysia",
    taxName: "Sales Tax",
    taxRate: 0.1,
    note: "Goods 10%, services 7% (shown in source)",
  },
  MT: {
    countryName: "Malta",
    taxName: "VAT",
    taxRate: 0.18,
    note: "7%/5% reduced",
  },
  MU: { countryName: "Mauritius", taxName: "VAT", taxRate: 0.15 },
  MX: { countryName: "Mexico", taxName: "VAT", taxRate: 0.16 },
  MD: {
    countryName: "Moldova",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% HoReCa",
  },
  MC: {
    countryName: "Monaco",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% reduced; 5.5% basic products",
  },
  MN: { countryName: "Mongolia", taxName: "VAT", taxRate: 0.1 },
  ME: {
    countryName: "Montenegro",
    taxName: "VAT",
    taxRate: 0.21,
    note: "7% reduced; some 0%",
  },
  MA: {
    countryName: "Morocco",
    taxName: "VAT",
    taxRate: 0.2,
    note: "Reduced 14%/10%/7%",
  },
  MZ: {
    countryName: "Mozambique",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  MM: {
    countryName: "Myanmar",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },

  NP: { countryName: "Nepal", taxName: "VAT", taxRate: 0.13 },

  NL: {
    countryName: "Netherlands",
    taxName: "VAT",
    taxRate: 0.21,
    note: "9% reduced",
  },
  NZ: { countryName: "New Zealand", taxName: "GST", taxRate: 0.15 },
  NG: { countryName: "Nigeria", taxName: "VAT", taxRate: 0.075 },
  NO: {
    countryName: "Norway",
    taxName: "VAT",
    taxRate: 0.25,
    note: "15% food; 12% transport/cinema/hotels",
  },

  OM: { countryName: "Oman", taxName: "VAT", taxRate: 0.05 },

  PK: {
    countryName: "Pakistan",
    taxName: "Sales Tax",
    taxRate: 0.18,
    note: "15% services; 0% basic food; +3% non-registered goods",
  },
  PA: {
    countryName: "Panama",
    taxName: "VAT",
    taxRate: 0.07,
    note: "Higher rates for tobacco/alcohol/hotels; reduced 5%",
  },
  PY: { countryName: "Paraguay", taxName: "VAT", taxRate: 0.1 },
  PE: {
    countryName: "Peru",
    taxName: "VAT",
    taxRate: 0.16,
    note: "+2% municipal promotional tax (shown in source)",
  },
  PH: {
    countryName: "Philippines",
    taxName: "VAT",
    taxRate: 0.12,
    note: "0% reduced",
  },
  PL: {
    countryName: "Poland",
    taxName: "VAT",
    taxRate: 0.23,
    note: "8%/5% reduced",
  },
  PT: {
    countryName: "Portugal",
    taxName: "VAT",
    taxRate: 0.23,
    note: "13% intermediate; 6% reduced",
  },

  QA: { countryName: "Qatar", taxName: "No VAT", taxRate: 0.0 },

  RO: {
    countryName: "Romania",
    taxName: "VAT",
    taxRate: 0.19,
    note: "9%/5% reduced",
  },
  RU: {
    countryName: "Russia",
    taxName: "VAT",
    taxRate: 0.22,
    note: "10% reduced; 0% certain items",
  },

  SA: {
    countryName: "Saudi Arabia",
    taxName: "VAT",
    taxRate: 0.15,
    note: "5% real estate transactions rate mentioned",
  },
  RS: {
    countryName: "Serbia",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% or 0% reduced",
  },
  SG: { countryName: "Singapore", taxName: "GST", taxRate: 0.09 },
  SK: {
    countryName: "Slovakia",
    taxName: "VAT",
    taxRate: 0.23,
    note: "19%/5% reduced",
  },
  SI: {
    countryName: "Slovenia",
    taxName: "VAT",
    taxRate: 0.22,
    note: "9.5% reduced; 5% books/newspapers",
  },

  ZA: { countryName: "South Africa", taxName: "VAT", taxRate: 0.15 },
  ES: {
    countryName: "Spain",
    taxName: "VAT",
    taxRate: 0.21,
    note: "10%/4% reduced",
  },
  LK: {
    countryName: "Sri Lanka",
    taxName: "VAT",
    taxRate: 0.12,
    note: "8% or 0% reduced",
  },
  SE: {
    countryName: "Sweden",
    taxName: "VAT",
    taxRate: 0.25,
    note: "12% or 6% reduced",
  },
  CH: {
    countryName: "Switzerland",
    taxName: "VAT",
    taxRate: 0.081,
    note: "3.8%/2.5% reduced",
  },

  TW: { countryName: "Taiwan", taxName: "VAT", taxRate: 0.05 },
  TH: { countryName: "Thailand", taxName: "VAT", taxRate: 0.07 },
  TR: {
    countryName: "Turkey",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% clothing; 1% certain foods",
  },

  UA: {
    countryName: "Ukraine",
    taxName: "VAT",
    taxRate: 0.18,
    note: "2% turnover tax during martial law mentioned (separate)",
  },

  AE: { countryName: "United Arab Emirates", taxName: "VAT", taxRate: 0.05 },
  GB: {
    countryName: "United Kingdom",
    taxName: "VAT",
    taxRate: 0.2,
    note: "5% home energy; many 0% items",
  },
  US: {
    countryName: "United States",
    taxName: "Sales Tax",
    taxRate: 0.0,
    note: "State/local; shown as 0–11.5%",
  },

  UY: {
    countryName: "Uruguay",
    taxName: "VAT",
    taxRate: 0.22,
    note: "11% lowest; some 0%",
  },
  UZ: {
    countryName: "Uzbekistan",
    taxName: "VAT",
    taxRate: 0.15,
    note: "Shown as 0–15% (varies); using 15% max/standard",
  },

  VE: {
    countryName: "Venezuela",
    taxName: "VAT",
    taxRate: 0.16,
    note: "8% reduced",
  },
  VN: { countryName: "Vietnam", taxName: "VAT", taxRate: 0.1 },

  YE: { countryName: "Yemen", taxName: "Sales Tax", taxRate: 0.02 },

  ZM: { countryName: "Zambia", taxName: "VAT", taxRate: 0.16 },
  ZW: {
    countryName: "Zimbabwe",
    taxName: "VAT",
    taxRate: 0.15,
    note: "0% selected items",
  },
};

function getTaxInfo(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  return (
    COUNTRY_TAX_MAP[code] || {
      countryName: code || "Unknown",
      taxName: "Tax",
      taxRate: 0.0,
    }
  );
}

module.exports = {
  COUNTRY_TAX_MAP,
  getTaxInfo,
};