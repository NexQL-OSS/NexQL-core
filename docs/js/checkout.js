// Razorpay Subscription Checkout for NexQL (Sponsor + Singularity tiers)

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
    .license-input {
      width: 100%; box-sizing: border-box; margin-bottom: 12px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 12px 14px; color: #fff; font-size: 14px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 1px;
    }
    .license-input:focus { outline: none; border-color: #6C4CF0; }
    .license-status-card {
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; padding: 16px; margin-bottom: 16px; font-size: 14px;
    }
    .license-status-card div { margin-bottom: 6px; }
    .license-status-card .muted { color: #9ca3af; }
    .license-pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
    .license-pill.active { background: rgba(16,185,129,0.18); color:#34d399; }
    .license-pill.cancelled, .license-pill.halted, .license-pill.paused { background: rgba(239,68,68,0.18); color:#f87171; }
    .license-btn-danger { background:#ef4444; color:#fff; width:100%; }
    .license-error { color:#f87171; font-size:13px; margin-bottom:12px; }
    a.manage-subscription-link { color: var(--accent, #8b7cf6); cursor:pointer; text-decoration: underline; }
    .license-recover { margin: 4px 0 14px; }
    .license-recover .manage-subscription-link { font-size: 13px; }
    .license-recover-note { color:#b8b8c8; font-size:13px; margin-top:10px; line-height:1.4; }
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
  const LICENSE_STORAGE_KEY = 'nexql_license';

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
        <p>Your license key is ready. Activate NexQL in VS Code:</p>
        <div class="license-key-row">
          <div class="license-key-value" id="lic-key">${licenseKey}</div>
          <button class="license-btn license-btn-copy" id="lic-copy">Copy</button>
        </div>
        <a class="license-btn license-btn-primary" href="${ACTIVATE_URI_BASE}${encodeURIComponent(licenseKey)}">Activate in VS Code</a>
        <p style="font-size:13px;margin-top:4px">Or run <b>NexQL: Activate License</b> in the command palette and paste the key. A copy was also emailed to you.</p>
      `
      : `
        <div class="license-pending"><span class="spinner-dot"></span> Issuing your license key…</div>
        <p style="margin-top:16px">Your key is being generated and will arrive by email shortly. You can also find it later from your subscription receipt.</p>
      `;

    overlay.innerHTML = `
      <div class="license-modal" role="dialog" aria-modal="true">
        <h3>Welcome to NexQL ${tierLabel} 🎉</h3>
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

  function fmtDate(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '—';
    }
  }

  function showManageModal() {
    const overlay = document.createElement('div');
    overlay.className = 'license-modal-overlay';
    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };

    let savedKey = '';
    try { savedKey = localStorage.getItem(LICENSE_STORAGE_KEY) || ''; } catch {}

    overlay.innerHTML = `
      <div class="license-modal" role="dialog" aria-modal="true">
        <h3>Manage subscription</h3>
        <p>Enter your license key to view status or cancel.</p>
        <div class="license-error" id="mng-error" style="display:none"></div>
        <input class="license-input" id="mng-key" placeholder="PGST-XXXX-XXXX-XXXX-XXXX" autocomplete="off" value="${savedKey}" />
        <div id="mng-result"></div>
        <button class="license-btn license-btn-primary" id="mng-check">Check status</button>
        <div class="license-recover">
          <a class="manage-subscription-link" id="mng-recover-toggle">Lost your key? Email it to me</a>
          <div id="mng-recover-form" style="display:none;margin-top:12px">
            <input class="license-input" id="mng-email" type="email" placeholder="you@example.com" autocomplete="email" />
            <button class="license-btn license-btn-copy" id="mng-recover-send" style="width:100%">Email my license key</button>
            <div class="license-recover-note" id="mng-recover-note" style="display:none"></div>
          </div>
        </div>
        <button class="license-btn license-btn-secondary" id="mng-close">Close</button>
      </div>`;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add('show'), 50);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#mng-close').addEventListener('click', close);

    const errorEl = overlay.querySelector('#mng-error');
    const resultEl = overlay.querySelector('#mng-result');
    const keyEl = overlay.querySelector('#mng-key');
    const checkBtn = overlay.querySelector('#mng-check');

    // --- Email recovery (cross-device) ---
    const recoverToggle = overlay.querySelector('#mng-recover-toggle');
    const recoverForm = overlay.querySelector('#mng-recover-form');
    const emailEl = overlay.querySelector('#mng-email');
    const recoverSend = overlay.querySelector('#mng-recover-send');
    const recoverNote = overlay.querySelector('#mng-recover-note');

    recoverToggle.addEventListener('click', (e) => {
      e.preventDefault();
      recoverForm.style.display = recoverForm.style.display === 'none' ? 'block' : 'none';
    });

    recoverSend.addEventListener('click', async () => {
      const email = (emailEl.value || '').trim();
      recoverNote.style.display = 'none';
      if (!email || !email.includes('@')) {
        recoverNote.textContent = 'Enter a valid email.';
        recoverNote.style.display = 'block';
        return;
      }
      recoverSend.disabled = true;
      recoverSend.textContent = 'Sending…';
      try {
        await fetch('/api/license/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        recoverNote.textContent = "If that email has a subscription, we've sent the license key to it.";
      } catch {
        recoverNote.textContent = 'Network error. Try again.';
      } finally {
        recoverNote.style.display = 'block';
        recoverSend.disabled = false;
        recoverSend.textContent = 'Email my license key';
      }
    });

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    };
    const clearError = () => { errorEl.style.display = 'none'; };

    async function checkStatus() {
      clearError();
      resultEl.innerHTML = '';
      const key = (keyEl.value || '').trim().toUpperCase();
      if (!key) return showError('Enter your license key.');
      checkBtn.disabled = true;
      checkBtn.textContent = 'Checking…';
      try {
        const res = await fetch('/api/license/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: key }),
        });
        if (res.status === 404) {
          showError('No subscription found for that key.');
          return;
        }
        if (!res.ok) {
          showError('Could not look up that key. Try again.');
          return;
        }
        const data = await res.json();
        try { localStorage.setItem(LICENSE_STORAGE_KEY, key); } catch {}
        renderStatus(key, data);
      } catch {
        showError('Network error. Try again.');
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = 'Check status';
      }
    }

    function renderStatus(key, data) {
      const tierName = data.tier ? data.tier[0].toUpperCase() + data.tier.slice(1) : '—';
      const cancellable = data.status === 'active' && data.hasSubscription;
      const renewLabel = data.status === 'active' ? 'Renews / valid until' : 'Access until';
      resultEl.innerHTML = `
        <div class="license-status-card">
          <div><b>NexQL ${tierName}</b> <span class="license-pill ${data.status}">${data.status}</span></div>
          <div class="muted">${data.period || ''} ${data.currency || ''}</div>
          <div class="muted">${renewLabel}: ${fmtDate(data.expiresAt)}</div>
          ${data.email ? `<div class="muted">${data.email}</div>` : ''}
        </div>
        ${cancellable ? '<button class="license-btn license-btn-danger" id="mng-cancel">Cancel subscription</button>' : ''}
      `;
      const cancelBtn = resultEl.querySelector('#mng-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => cancelSubscription(key, cancelBtn));
      }
    }

    async function cancelSubscription(key, btn) {
      if (!window.confirm('Cancel at the end of your current billing period? You keep access until then.')) {
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Cancelling…';
      try {
        const res = await fetch('/api/cancel-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: key, immediate: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          resultEl.innerHTML = `
            <div class="license-status-card">
              <div><b>Cancellation scheduled.</b></div>
              <div class="muted">Your subscription will not renew. Access continues until ${fmtDate(data.accessUntil)}.</div>
            </div>`;
        } else {
          showError(data.error || 'Could not cancel. Contact support.');
          btn.disabled = false;
          btn.textContent = 'Cancel subscription';
        }
      } catch {
        showError('Network error during cancellation.');
        btn.disabled = false;
        btn.textContent = 'Cancel subscription';
      }
    }

    checkBtn.addEventListener('click', checkStatus);
    keyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkStatus(); });
  }

  // Open the manage panel from any element with [data-manage-subscription].
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-manage-subscription]');
    if (trigger) {
      event.preventDefault();
      showManageModal();
    }
  });

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

    const pricing = window.NexQLPricing;
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
        name: 'NexQL',
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
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_subscription_id: response.razorpay_subscription_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });

            const verifyData = await verifyRes.json();

            if (verifyRes.ok && verifyData.success) {
              resetButton();
              showLicenseModal(tierLabel, null); // optimistic: modal opens immediately
              const licenseKey = await pollLicenseKey(subData.subscription_id);
              if (licenseKey) {
                try { localStorage.setItem(LICENSE_STORAGE_KEY, licenseKey); } catch {}
              }
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
