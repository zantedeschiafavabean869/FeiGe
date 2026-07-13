# Security

## API keys

FeiGe stores API keys locally. On supported Windows systems it uses Electron's
Windows-backed secure storage. Release ZIP files and project export ZIP files
must never contain `settings.json`, `FeiGeData`, `.env` files, or API keys.

If a key is accidentally published, revoke it at the model provider and create
a replacement immediately.

## Reporting a vulnerability

Please open a GitHub issue containing reproduction steps but no credentials,
personal video, or private project data. For a report that cannot be disclosed
publicly, use GitHub's private vulnerability reporting feature when enabled.
