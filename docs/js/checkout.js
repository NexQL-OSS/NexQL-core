// Self-contained Razorpay Checkout Integration for PgStudio
// Features: Event Delegation, Dynamic Public Key Resolution, Custom Premium Glassmorphism Alerts.

(function () {
  // Inject toast alert styles dynamically to keep checkout styling modular and visually premium
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
    .payment-toast.success {
      border-left: 4px solid #10b981;
    }
    .payment-toast.error {
      border-left: 4px solid #ef4444;
    }
    .payment-toast.warning {
      border-left: 4px solid #f59e0b;
    }
    .payment-toast-icon {
      font-size: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .payment-toast-content {
      flex: 1;
      line-height: 1.4;
    }
    .payment-toast-close {
      background: none;
      border: none;
      color: #9ca3af;
      cursor: pointer;
      font-weight: bold;
      font-size: 18px;
      margin-left: 12px;
      padding: 0 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.2s ease;
    }
    .payment-toast-close:hover {
      color: #f3f4f6;
    }
    
    /* Loading Spinner */
    .spinner-dot {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin-anim 0.8s linear infinite;
      display: inline-block;
    }
    @keyframes spin-anim {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  // Custom Toast Alert System
  function showCheckoutAlert(type, message) {
    // Remove existing toast if any
    const existing = document.querySelector('.payment-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `payment-toast ${type}`;

    let icon = '⚡';
    if (type === 'success') icon = '🎉';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = 'ℹ️';

    toast.innerHTML = `
      <div class="payment-toast-icon">${icon}</div>
      <div class="payment-toast-content">${message}</div>
      <button class="payment-toast-close" aria-label="Close notification">&times;</button>
    `;

    document.body.appendChild(toast);

    // Fade-in animation
    setTimeout(() => toast.classList.add('show'), 50);

    // Auto dismiss after 6 seconds
    const dismissTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 6000);

    // Close button click handler
    toast.querySelector('.payment-toast-close').addEventListener('click', () => {
      clearTimeout(dismissTimer);
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    });
  }

  // Use Event Delegation to capture clicks on #btn-razorpay-checkout (since the html is loaded as a dynamic partial)
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#btn-razorpay-checkout');
    if (!btn) return;

    event.preventDefault();
    if (btn.disabled) return;

    // Save original button content and disable
    const originalContent = btn.innerHTML;
    const originalText = btn.textContent.trim();
    
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

    try {
      setBtnLoading('Initializing Payment...');

      // 1. Fetch Razorpay Key ID from config endpoint
      const configRes = await fetch('/api/config');
      if (!configRes.ok) throw new Error('Failed to fetch API configurations');
      const configData = await configRes.json();
      const keyId = configData.key_id;

      if (!keyId) throw new Error('Razorpay Key ID is missing');

      setBtnLoading('Creating Order...');

      // 2. Call backend endpoint to create order (amount: 100 paise = ₹1.00)
      const orderRes = await fetch('/api/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: 100,
          currency: 'INR',
          receipt: `receipt_sponsor_${Date.now()}`
        })
      });

      if (!orderRes.ok) {
        const errorData = await orderRes.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to create order');
      }

      const orderData = await orderRes.json();

      setBtnLoading('Launching Checkout...');

      // 3. Configure Razorpay Standard Checkout Options
      const options = {
        key: keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'PgStudio Pro',
        description: 'One-time Pro Sponsorship Support',
        order_id: orderData.order_id,
        image: 'assets/postgres-vsc-icon.png',
        prefill: {
          name: 'PostgreSQL Developer',
          email: 'developer@pgstudio.astrx.dev',
          contact: '9999999999'
        },
        notes: {
          sponsorship_tier: 'Pro Support Plan'
        },
        theme: {
          color: '#4d5efc' // Matching PgStudio's brand color
        },
        handler: async function (response) {
          // On Payment Success:
          // Receive razorpay_payment_id, razorpay_order_id, razorpay_signature
          setBtnLoading('Verifying Transaction...');
          
          try {
            const verifyRes = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature
              })
            });

            const verifyData = await verifyRes.json();

            if (verifyRes.ok && verifyData.success) {
              showCheckoutAlert(
                'success',
                '<strong>Thank you for your support!</strong><br>Your payment of ₹1.00 has been verified successfully. Welcome to PgStudio Pro!'
              );
            } else {
              showCheckoutAlert(
                'error',
                `Verification failed: ${verifyData.error || 'Payment signature mismatch'}`
              );
            }
          } catch (err) {
            console.error('Signature verification call failed:', err);
            showCheckoutAlert(
              'error',
              'Connection error during transaction signature verification.'
            );
          } finally {
            resetButton();
          }
        },
        modal: {
          ondismiss: function () {
            // Handle modal dismiss (user cancelled)
            showCheckoutAlert('warning', 'Sponsorship checkout cancelled by user.');
            resetButton();
          }
        }
      };

      // 4. Open Razorpay Payment Modal
      const rzp = new Razorpay(options);
      
      // Handle payment.failed event
      rzp.on('payment.failed', function (response) {
        console.error('Payment failure event:', response.error);
        showCheckoutAlert(
          'error',
          `<strong>Payment Failed:</strong> ${response.error.description || 'Transaction unsuccessful'}`
        );
        resetButton();
      });

      rzp.open();

    } catch (error) {
      console.error('Checkout initialization failed:', error);
      showCheckoutAlert(
        'error',
        `<strong>Checkout Error:</strong> ${error.message || 'Initialization failed'}`
      );
      resetButton();
    }
  });
})();
