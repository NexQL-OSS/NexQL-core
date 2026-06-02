const SUPPORTED_CURRENCIES = ['INR', 'USD'];
const SUPPORTED_TIERS = ['sponsor', 'singularity'];
const SUPPORTED_PERIODS = ['monthly', 'annual'];

const TIER_NAMES = {
  sponsor: 'Sponsor',
  singularity: 'Singularity',
};

const DEFAULT_DISPLAY = {
  sponsor: {
    monthly: { INR: '₹199/mo', USD: '$2/mo' },
    annual: { INR: '₹1,990/yr', USD: '$20/yr' },
  },
  singularity: {
    monthly: { INR: '₹899/mo', USD: '$9/mo' },
    annual: { INR: '₹8,990/yr', USD: '$90/yr' },
  },
};

function planEnvKey(tier, period, currency) {
  return `RAZORPAY_PLAN_${tier.toUpperCase()}_${period.toUpperCase()}_${currency}`;
}

function displayEnvKey(tier, period, currency) {
  return `RAZORPAY_DISPLAY_${tier.toUpperCase()}_${period.toUpperCase()}_${currency}`;
}

function getPlanId(tier, period, currency) {
  return process.env[planEnvKey(tier, period, currency)] || '';
}

function getDisplay(tier, period, currency) {
  return (
    process.env[displayEnvKey(tier, period, currency)] ||
    DEFAULT_DISPLAY[tier]?.[period]?.[currency] ||
    ''
  );
}

function isValidTier(tier) {
  return SUPPORTED_TIERS.includes(tier);
}

function isValidPeriod(period) {
  return SUPPORTED_PERIODS.includes(period);
}

function isValidCurrency(currency) {
  return SUPPORTED_CURRENCIES.includes(currency);
}

function buildTierCatalog() {
  const tiers = {};

  for (const tier of SUPPORTED_TIERS) {
    tiers[tier] = { name: TIER_NAMES[tier] };
    for (const period of SUPPORTED_PERIODS) {
      tiers[tier][period] = {};
      for (const currency of SUPPORTED_CURRENCIES) {
        const planId = getPlanId(tier, period, currency);
        tiers[tier][period][currency] = {
          display: getDisplay(tier, period, currency),
          available: Boolean(planId),
        };
      }
    }
  }

  return tiers;
}

function resolvePlan(tier, period, currency) {
  if (!isValidTier(tier) || !isValidPeriod(period) || !isValidCurrency(currency)) {
    return { error: 'Invalid tier, period, or currency' };
  }

  const planId = getPlanId(tier, period, currency);
  if (!planId || planId === 'plan_') {
    return { error: `Plan not configured for ${tier} ${period} ${currency}` };
  }

  return { planId, display: getDisplay(tier, period, currency) };
}

module.exports = {
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIERS,
  SUPPORTED_PERIODS,
  buildTierCatalog,
  resolvePlan,
  isValidTier,
  isValidPeriod,
  isValidCurrency,
};
