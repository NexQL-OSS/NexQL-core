// Pricing tier UI: currency auto-detect, billing/currency toggles, dynamic price labels.

(function () {
  const STORAGE_CURRENCY = 'pgstudio_pricing_currency';
  const STORAGE_PERIOD = 'pgstudio_pricing_period';

  let catalog = null;

  function detectDefaultCurrency() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz === 'Asia/Kolkata') return 'INR';
    } catch (_) {
      /* ignore */
    }
    const lang = (navigator.language || '').toLowerCase();
    if (lang.startsWith('en-in') || lang.startsWith('hi-in')) return 'INR';
    return 'USD';
  }

  function getCurrency() {
    return sessionStorage.getItem(STORAGE_CURRENCY) || detectDefaultCurrency();
  }

  function getPeriod() {
    return sessionStorage.getItem(STORAGE_PERIOD) || 'monthly';
  }

  function setCurrency(currency) {
    sessionStorage.setItem(STORAGE_CURRENCY, currency);
    syncToggleGroup('.pricing-currency-toggle', 'data-currency', currency);
    updatePriceLabels();
  }

  function setPeriod(period) {
    sessionStorage.setItem(STORAGE_PERIOD, period);
    syncToggleGroup('.pricing-billing-toggle', 'data-period', period);
    updatePriceLabels();
  }

  function syncToggleGroup(selector, attr, value) {
    document.querySelectorAll(`${selector} button`).forEach((btn) => {
      const active = btn.getAttribute(attr) === value;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
  }

  function parseDisplay(display) {
    if (!display) return { amount: '—', period: '' };
    const slash = display.indexOf('/');
    if (slash === -1) return { amount: display, period: '' };
    return {
      amount: display.slice(0, slash).trim(),
      period: `/ ${display.slice(slash + 1).trim()}`,
    };
  }

  function updatePriceLabels() {
    if (!catalog) return;

    const currency = getCurrency();
    const period = getPeriod();

    document.querySelectorAll('[data-pricing-tier]').forEach((el) => {
      const tier = el.getAttribute('data-pricing-tier');
      const tierData = catalog.tiers?.[tier]?.[period]?.[currency];
      const amountEl = el.querySelector('.pricing-amount-value');
      const periodEl = el.querySelector('.pricing-amount .period');
      const payBtn = el.querySelector('[data-tier]');

      if (!tierData) return;

      const parsed = parseDisplay(tierData.display);
      if (amountEl) amountEl.textContent = parsed.amount;
      if (periodEl) periodEl.textContent = parsed.period;

      if (payBtn) {
        payBtn.disabled = !tierData.available;
        payBtn.title = tierData.available
          ? ''
          : 'Checkout unavailable — plan not configured yet';
      }
    });
  }

  async function loadCatalog() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('Failed to load pricing config');
      catalog = await res.json();
      updatePriceLabels();
    } catch (err) {
      console.error('Pricing catalog load failed:', err);
    }
  }

  function wireToggles() {
    /* Event delegation — partials inject pricing controls after initial load */
  }

  document.addEventListener('click', (event) => {
    const currencyBtn = event.target.closest('.pricing-currency-toggle button[data-currency]');
    if (currencyBtn) {
      setCurrency(currencyBtn.getAttribute('data-currency'));
      return;
    }
    const periodBtn = event.target.closest('.pricing-billing-toggle button[data-period]');
    if (periodBtn) {
      setPeriod(periodBtn.getAttribute('data-period'));
    }
  });

  function initPricingUi() {
    syncToggleGroup('.pricing-currency-toggle', 'data-currency', getCurrency());
    syncToggleGroup('.pricing-billing-toggle', 'data-period', getPeriod());
    updatePriceLabels();
  }

  function init() {
    loadCatalog();
  }

  window.PgStudioPricing = {
    getCurrency,
    getPeriod,
    getCatalog: () => catalog,
    refreshCatalog: loadCatalog,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  document.addEventListener('partials-loaded', () => {
    initPricingUi();
    loadCatalog();
  });
})();
