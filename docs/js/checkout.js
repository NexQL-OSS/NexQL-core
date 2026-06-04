// Razorpay Subscription Checkout for PgStudio (Sponsor + Singularity tiers)

(function () {
  const TIER_LABELS = {
    sponsor: 'Sponsor',
    singularity: 'Singularity',
  };

  const style = document.createElement('style');
  style.textContent = `
    .payment-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: rgba(22, 22, 37, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 16px 20px;
      border-radius: 12px;
      color: #f8f8f2;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      max-width: 380px;
      transform: translateY(100px);
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.4s ease;
    }
    .payment-toast.show {
      transform: translateY(0);
      opacity: 1;
    }
    .payment-toast.success { border-left: 4px solid #10b981; }
    .payment-toast.error { border-left: 4px solid #ef4444; }
    .payment-toast.warning { border-left: 4px solid #f59e0b; }
    .payment-toast-icon { font-size: 22px; }
    .payment-toast-content { flex: 1; line-height: 1.4; }
    .payment-toast-close {
      background: none; border: none; color: #9ca3af; cursor: pointer;
      font-size: 18px; margin-left: 12px; padding: 0 4px;
    }
    .payment-toast-close:hover { color: #f3f4f6; }
    .spinner-dot {
      width: 14px; height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white; border-radius: 50%;
      animation: spin-anim 0.8s linear infinite;
      display: inline-block;
    }
    @keyframes spin-anim { to { transform: rotate(360deg); } }

    .license-modal-overlay {
      position: fixed; inset: 0; z-index: 10001;
      background: rgba(8, 8, 16, 0.72);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.3s ease;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .license-modal-overlay.show { opacity: 1; }
    .license-modal {
      background: #161625; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px; padding: 32px; max-width: 440px; width: calc(100% - 32px);
      color: #f8f8f2; box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      transform: translateY(16px) scale(0.98); transition: transform 0.3s cubic-bezier(0.175,0.885,0.32,1.275);
    }
    .license-modal-overlay.show .license-modal { transform: translateY(0) scale(1); }
    .license-modal h3 { margin: 0 0 8px; font-size: 20px; }
    .license-modal p { margin: 0 0 16px; color: #b8b8c8; font-size: 14px; line-height: 1.5; }
    .license-key-row {
      display: flex; gap: 8px; margin-bottom: 20px;
    }
    .license-key-value {
      flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; padding: 12px 14px; font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 15px; letter-spacing: 1px; color: #fff; user-select: all;
    }
    .license-btn {
      border: none; border-radius: 8px; padding: 12px 18px; font-weight: 600; cursor: pointer;
      font-size: 14px; font-family: inherit; transition: opacity 0.2s ease, background 0.2s ease;
    }
    .license-btn:hover { opacity: 0.9; }
    .license-btn-copy { background: rgba(255,255,255,0.1); color: #fff; }
    .license-btn-primary { background: #6C4CF0; color: #fff; width: 100%; text-align: center; text-decoration: none; display: block; box-sizing: border-box; margin-bottom: 10px; }
    .license-btn-secondary { background: transparent; color: #9ca3af; width: 100%; }
    .license-pending { display: flex; align-items: center; gap: 10px; color: #b8b8c8; font-size: 14px; }
  `;
  document.head.appendChild(style);

  let configCache = null;

  function showCheckoutAlert(type, message) {
    const existing = document.querySelector('.payment-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `payment-toast ${type}`;

    const icons = { success: '🎉', error: '❌', warning: 'ℹ️' };
    toast.innerHTML = `
      <div class="payment-toast-icon">${icons[type] || '⚡'}</div>
      <div class="payment-toast-content">${message}</div>
      <button class="payment-toast-close" aria-label="Close notification">&times;</button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 50);

    const dismissTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 6000);

    toast.querySelector('.payment-toast-close').addEventListener('click', () => {
      clearTimeout(dismissTimer);
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    });
  }

  const ACTIVATE_URI_BASE = 'vscode://ric-v.postgres-explorer/activate?key=';

  // Poll the lookup endpoint until the webhook has issued a license key.
  async function pollLicenseKey(subscriptionId, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`/api/license/lookup?subscription_id=${encodeURIComponent(subscriptionId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.licenseKey) return data.licenseKey;
        }
      } catch (err) {
        // network hiccup — keep polling
      }
      await new Promise((r) => setTimeout(r, 1500 + i * 750)); // backoff
    }
    return null; // webhook not landed yet — fall back to email messaging
  }

  function showLicenseModal(tierLabel, licenseKey) {
    const overlay = document.createElement('div');
    overlay.className = 'license-modal-overlay';

    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };

    const keyBlock = licenseKey
      ? `
        <p>Your license key is ready. Activate PgStudio in VS Code:</p>
        <div class="license-key-row">
          <div class="license-key-value" id="lic-key">${licenseKey}</div>
          <button class="license-btn license-btn-copy" id="lic-copy">Copy</button>
        </div>
        <a class="license-btn license-btn-primary" href="${ACTIVATE_URI_BASE}${encodeURIComponent(licenseKey)}">Activate in VS Code</a>
        <p style="font-size:13px;margin-top:4px">Or run <b>PgStudio: Activate License</b> in the command palette and paste the key. A copy was also emailed to you.</p>
      `
      : `
        <div class="license-pending"><span class="spinner-dot"></span> Issuing your license key…</div>
        <p style="margin-top:16px">Your key is being generated and will arrive by email shortly. You can also find it later from your subscription receipt.</p>
      `;

    overlay.innerHTML = `
      <div class="license-modal" role="dialog" aria-modal="true">
        <h3>Welcome to PgStudio ${tierLabel} 🎉</h3>
        ${keyBlock}
        <button class="license-btn license-btn-secondary" id="lic-close">Done</button>
      </div>`;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add('show'), 50);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#lic-close').addEventListener('click', close);

    const copyBtn = overlay.querySelector('#lic-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(licenseKey);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        } catch {
          const el = overlay.querySelector('#lic-key');
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }
  }

  async function fetchConfig() {
    if (configCache) return configCache;
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Failed to fetch API configurations');
    configCache = await res.json();
    return configCache;
  }

  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-tier]');
    if (!btn || btn.tagName !== 'BUTTON') return;

    const tier = btn.getAttribute('data-tier');
    if (!tier || tier === 'free') return;

    event.preventDefault();
    if (btn.disabled) return;

    const originalContent = btn.innerHTML;

    function setBtnLoading(text) {
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.innerHTML = `<span class="spinner-dot"></span> <span>${text}</span>`;
    }

    function resetButton() {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.innerHTML = originalContent;
    }

    const pricing = window.PgStudioPricing;
    const currency = pricing?.getCurrency?.() || 'INR';
    const period = pricing?.getPeriod?.() || 'monthly';
    const tierLabel = TIER_LABELS[tier] || tier;

    try {
      setBtnLoading('Initializing…');
      const config = await fetchConfig();
      const keyId = config.key_id;
      if (!keyId) throw new Error('Razorpay Key ID is missing');

      setBtnLoading('Creating subscription…');

      const subRes = await fetch('/api/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, period, currency }),
      });

      if (!subRes.ok) {
        const errorData = await subRes.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to create subscription');
      }

      const subData = await subRes.json();

      setBtnLoading('Launching checkout…');

      const periodLabel = period === 'annual' ? 'Annual' : 'Monthly';
      const displayPrice = subData.display || '';

      const options = {
        key: keyId,
        subscription_id: subData.subscription_id,
        name: 'PgStudio',
        description: `${tierLabel} — ${periodLabel} subscription`,
        image: '/assets/NexQL.png',
        notes: {
          tier,
          period,
          currency,
        },
        theme: { color: '#6C4CF0' },
        handler: async function (response) {
          setBtnLoading('Verifying payment…');
          try {
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });

            const verifyData = await verifyRes.json();

            if (verifyRes.ok && verifyData.success) {
              resetButton();
              showLicenseModal(tierLabel, null); // optimistic: modal opens immediately
              const licenseKey = await pollLicenseKey(subData.subscription_id);
              const open = document.querySelector('.license-modal-overlay');
              if (open) open.remove(); // replace pending modal with final state
              showLicenseModal(tierLabel, licenseKey);
              return;
            } else {
              showCheckoutAlert(
                'error',
                `Verification failed: ${verifyData.error || 'Payment signature mismatch'}`
              );
            }
          } catch (err) {
            console.error('Signature verification failed:', err);
            showCheckoutAlert('error', 'Connection error during payment verification.');
          } finally {
            resetButton();
          }
        },
        modal: {
          ondismiss: function () {
            showCheckoutAlert('warning', `${tierLabel} checkout cancelled.`);
            resetButton();
          },
        },
      };

      const rzp = new Razorpay(options);

      rzp.on('payment.failed', function (response) {
        console.error('Payment failure:', response.error);
        showCheckoutAlert(
          'error',
          `<strong>Payment failed:</strong> ${response.error.description || 'Transaction unsuccessful'}`
        );
        resetButton();
      });

      rzp.open();
    } catch (error) {
      console.error('Checkout initialization failed:', error);
      showCheckoutAlert(
        'error',
        `<strong>Checkout error:</strong> ${error.message || 'Initialization failed'}`
      );
      resetButton();
    }
  });
})();
