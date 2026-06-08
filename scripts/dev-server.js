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
const licenseValidateHandler = require('../api/license/validate');
const licenseLookupHandler = require('../api/license/lookup');
const licenseStatusHandler = require('../api/license/status');
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

// Webhook needs the RAW body for signature verification — register it before
// the JSON body parser so express.json() doesn't consume the stream.
app.post('/api/webhook', express.raw({ type: '*/*' }), wrapServerless(webhookHandler));

// Body parsing middlewares (apply to all other routes)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve docs/ statically
app.use(express.static(path.join(__dirname, '../docs')));

// API Endpoints
app.get('/api/config', wrapServerless(configHandler));
app.post('/api/create-subscription', wrapServerless(createSubscriptionHandler));
app.post('/api/verify-payment', wrapServerless(verifyPaymentHandler));
app.post('/api/license/validate', wrapServerless(licenseValidateHandler));
app.get('/api/license/lookup', wrapServerless(licenseLookupHandler));
app.post('/api/license/status', wrapServerless(licenseStatusHandler));
app.post('/api/cancel-subscription', wrapServerless(cancelSubscriptionHandler));

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Dev Server API Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🚀 PgStudio Marketing & Razorpay Checkout Server`);
  console.log(`🌐 Address: http://localhost:${PORT}`);
  console.log(`🔑 RAZORPAY_KEY_ID: ${process.env.RAZORPAY_KEY_ID || 'Missing!'}`);
  console.log(`========================================================\n`);
});
