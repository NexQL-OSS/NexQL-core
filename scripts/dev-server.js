const express = require('express');
const path = require('path');
const fs = require('fs');

// Simple .env parser to load environment variables locally
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        const key = trimmed.substring(0, index).trim();
        const value = trimmed.substring(index + 1).trim();
        // Remove surrounding quotes if any
        const cleanValue = value.replace(/^['"]|['"]$/g, '');
        process.env[key] = cleanValue;
      }
    });
    console.log('Successfully loaded credentials from .env');
  } catch (error) {
    console.error('Error loading .env file:', error);
  }
} else {
  console.warn('.env file not found at project root. Using fallback/existing environment variables.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsing middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve docs/ statically
app.use(express.static(path.join(__dirname, '../docs')));

// Import Serverless function modules
const configHandler = require('../api/config');
const createOrderHandler = require('../api/create-order');
const verifyPaymentHandler = require('../api/verify-payment');

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

// API Endpoints
app.get('/api/config', wrapServerless(configHandler));
app.post('/api/create-order', wrapServerless(createOrderHandler));
app.post('/api/verify-payment', wrapServerless(verifyPaymentHandler));

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
