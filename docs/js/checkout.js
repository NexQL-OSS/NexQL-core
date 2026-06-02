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
              showCheckoutAlert(
                'success',
                `<strong>Welcome to PgStudio ${tierLabel}!</strong><br>Your ${displayPrice} subscription payment was verified.`
              );
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
