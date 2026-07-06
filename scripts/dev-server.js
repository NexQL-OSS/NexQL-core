const express = require('express');
const path = require('path');
const fs = require('fs');

// Simple .env parser to load environment variables locally.
// Load order matches Vercel: `.env` then `.env.local` (local overrides), from repo
// root then api/ (api-scoped values override root for parity with the functions).
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        const key = trimmed.substring(0, index).trim();
        const value = trimmed.substring(index + 1).trim();
        const cleanValue = value.replace(/^['"]|['"]$/g, '');
        process.env[key] = cleanValue;
      }
    });
    console.log(`Loaded env from ${path.relative(path.join(__dirname, '..'), envPath)}`);
    return true;
  } catch (error) {
    console.error(`Error loading ${envPath}:`, error);
    return false;
  }
}

// Root only, matching Vercel (which does not read api/.env*). `.env.local` overrides `.env`.
const envCandidates = [
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../.env.local'),
];
const loadedAny = envCandidates.map(loadEnvFile).some(Boolean);
if (!loadedAny) {
  console.warn('No .env / .env.local found. Using fallback/existing environment variables.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Import Serverless function modules
const configHandler = require('../api/config');
const createSubscriptionHandler = require('../api/create-subscription');
const verifyPaymentHandler = require('../api/verify-payment');
const webhookHandler = require('../api/webhook');
const licenseRouter = require('../api/license/[...route]');
const authRouter = require('../api/auth/[...route]');
const syncRouter = require('../api/sync/[...path]');
const cancelSubscriptionHandler = require('../api/cancel-subscription');

// Standard Express wrapper for Serverless function signature (req, res)
const wrapServerless = (handler) => {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      next(err);
    }
  };
};

/** Map Express splat params to Vercel catch-all query shape. */
const wrapCatchAll = (handler, paramName) => {
  return wrapServerless(async (req, res) => {
    const raw = req.params[paramName];
    let segments = [];
    if (Array.isArray(raw)) {
      segments = raw.filter(Boolean);
    } else if (typeof raw === 'string' && raw.length > 0) {
      segments = raw.split('/').filter(Boolean);
    }
    req.query[paramName] = segments;
    return handler(req, res);
  });
};

// Webhook needs the RAW body for signature verification — register it before
// the JSON body parser so express.json() doesn't consume the stream.
app.post('/api/webhook', express.raw({ type: '*/*' }), wrapServerless(webhookHandler));

// Body parsing middlewares (apply to all other routes)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Proxy NexQL theme JSON from sibling repo when available (offline dev without CDN).
const nexqlThemesDir = path.join(__dirname, '../../NexQL-Themes/themes');
if (fs.existsSync(nexqlThemesDir)) {
  app.use('/themes', express.static(nexqlThemesDir));
  console.log(`Serving /themes from ${nexqlThemesDir}`);
}

// Serve docs/ statically
app.use(express.static(path.join(__dirname, '../docs')));

// API Endpoints
app.get('/api/config', wrapServerless(configHandler));
app.post('/api/create-subscription', wrapServerless(createSubscriptionHandler));
app.post('/api/verify-payment', wrapServerless(verifyPaymentHandler));
app.all('/api/license/*route', wrapCatchAll(licenseRouter, 'route'));
app.all('/api/auth/*route', wrapCatchAll(authRouter, 'route'));
app.all('/api/sync/*path', wrapCatchAll(syncRouter, 'path'));
app.post('/api/cancel-subscription', wrapServerless(cancelSubscriptionHandler));

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Dev Server API Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🚀 NexQL Marketing & Razorpay Checkout Server`);
  console.log(`🌐 Address: http://localhost:${PORT}`);
  console.log(`🔑 RAZORPAY_KEY_ID: ${process.env.RAZORPAY_KEY_ID ? 'configured' : 'Missing!'}`);
  console.log(`========================================================\n`);
});
