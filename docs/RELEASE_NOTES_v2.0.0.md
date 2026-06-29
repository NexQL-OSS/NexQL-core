# NexQL 2.0.0 Release Notes — Professional Database Management for VS Code

Welcome to **NexQL 2.0.0** (formerly PostgreSQL Explorer)! This major release represents a significant evolution of our database tooling. It introduces a comprehensive rebranding, a secure multi-tier subscription and licensing system, streamlined per-provider AI models/catalogs, and an in-extension "What's New" release log viewer.

---

## 🎨 Rebranding to NexQL

We have officially transitioned from **PostgreSQL Explorer (YAPE)** to **NexQL**! 

* **Why NexQL?** The name reflects our vision to provide the *next* generation of query capability, object management, and developer efficiency.
* **Branding Updates:** You'll see new high-resolution branding, icons, and theme configuration inside the extension and across our documentation.
* **Redesigned Landing Page:** Our documentation and interactive sandbox at [https://nexql.astrx.dev/](https://nexql.astrx.dev/) has been redesigned from the ground up, utilizing a modern, premium dark design language built around the new NexQL spectrum color gradient (blue → indigo → magenta → amber).

---

## 🔑 Licensing & Subscription System

NexQL 2.0.0 introduces a flexible multi-tier subscription framework consisting of three main tiers:

1. **Free Tier:** Access core database explorer workflows, run SQL notebooks, and manage up to **5 saved queries**.
2. **Sponsor Tier ($2/month or $20/year):** Unlocks unlimited saved queries, visual table designers, database index advisors, schema diff tools, and advanced AI assistant capabilities.
3. **Singularity Tier ($9/month or $90/year):** Designed for teams and enterprise users, providing collaborative capabilities and flat organizational licensing.

### Key Licensing Capabilities

* **Secure Local Caching:** The background licensing system uses VS Code's native `SecretStorage` API to encrypt and store license keys locally.
* **Offline Resilience:** Once verified, licenses are cached with a **24-hour TTL** and a **7-day offline grace period**, ensuring you can continue working during network interruptions.
* **Key Recovery:** Lost your license key? Retrieve it instantly via email using our secure license recovery interface or online lookup APIs.
* **Entitlement Feedback:** Active tiers are shown dynamically in your status bar. If you attempt to access premium features (like visual schema designer or index advisor) while on the Free tier, clear hard (modal dialog) or soft (status messages) gates will assist you in upgrading.

### In-Extension License Commands

Manage your subscription without leaving VS Code:
* `> NexQL: Activate License` — Enter your license key.
* `> NexQL: Manage License` — View your current tier, subscription status, and renew/upgrade options.

---

## 🤖 Advanced AI Configuration & Model Catalog

We have rewritten the AI configuration engine to support robust multi-provider workflows and granular customizability.

### Secure Provider-Level Keys

In previous versions, switching AI providers (OpenAI, Anthropic, Gemini, or VS Code LM) would overwrite or lose credentials. In v2.0.0:
* API keys are stored **independently** per provider within the OS keychain via SecretStorage.
* You can configure keys for OpenAI, Anthropic, and Gemini simultaneously and switch between them seamlessly.

### Dedicated AI Settings Panel & Catalog

* **Model Catalog:** The new `AiModelCatalogService` dynamically pulls, stores, and validates model lists per provider (e.g., GPT-4o, Claude 3.5 Sonnet, Gemini 2.5 Flash).
* **Scoped Configurations:** Split settings for **Chat** (sidebar assistant) and **Notebooks** (inline CodeLens actions, WAL metric panel, index advisors), allowing you to run a faster model (like Gemini Flash) for notebook completions while using a stronger model (like Claude Sonnet) for chat.
* **Model Picker:** Chat webviews now feature a header dropdown listing active models from all configured providers. A direct "Configure AI..." link opens the new AI settings panel instantly.

---

## 📣 Interactive "What's New" Log

To keep you up to date, we've integrated a beautiful, markdown-rendered **What's New** panel. 
* It launches automatically after an extension update.
* It can be manually displayed at any time by running the command `> NexQL: Show What's New`.
* It features syntax-highlighted code blocks, interactive links, and trigger buttons for quick command access.

---

## 🛠️ Performance & Architectural Improvements

* **API Restructuring:** Consolidated our serverless library code into `api/_lib/` for better maintainability and lower API latencies.
* **Production Environment Safeguards:** Enhanced visual cues and validation logic when executing queries against production database environments.
* **Saved Query Gating:** Implemented soft limits on saved queries for non-licensed instances, with clear, non-intrusive paths to activate Sponsor entitlements.

---

### Upgrading to 2.0.0
Simply let VS Code auto-update the extension, or run:
```bash
ext install ric-v.postgres-explorer
```
If you encounter any issues, please submit them to our repository [GitHub Issues](https://github.com/dev-asterix/NexQL/issues). Thank you for being a part of the NexQL community!
