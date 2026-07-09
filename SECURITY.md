# Security Policy

## Supported Versions

We actively support security updates for the latest major release.

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in this extension (for example, credential storage issues, SQL injection risks, or data leakage), please report it via GitHub issues and clearly mark it as a security report.

### What to Include
* Description of the vulnerability.
* Steps to reproduce the issue.
* Any relevant code snippets or screenshots (sanitize credentials before sending).

## Data Privacy & Credential Storage

As a database tool, security is paramount. Here is how this extension handles sensitive data:

1.  **Credential Storage:** We utilize the **VS Code Secret Storage API** to persist connection strings and passwords. We do not store credentials in plain text in `settings.json` or workspace state.
2.  **Telemetry (Opt-Out / Configurable):** Telemetry is privacy-first and anonymized. It never sends SQL text, schema names, hostnames, database names, usernames, credentials, or object names.
3.  **Telemetry Controls:** Telemetry honors both extension settings and VS Code global telemetry (`vscode.env.isTelemetryEnabled`) as a hard gate. You can disable telemetry entirely with `postgresExplorer.telemetry.mode = off`.
4.  **Data Transmission:** This extension operates locally for database traffic. Telemetry events are only sent when enabled and configured (for example with a PostHog API key), and include only anonymous usage/performance buckets.
