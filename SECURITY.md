# Security Policy / 安全政策

## Reporting a Vulnerability / 漏洞报告方式

Please **do not** report security vulnerabilities through public GitHub issues, pull requests, or discussions.

请**不要**在公开的 GitHub Issue、Pull Request 或讨论区中披露安全漏洞细节。

Instead, please report them privately via GitHub Private Vulnerability Reporting:

请通过 GitHub 私密漏洞报告入口提交：

- https://github.com/xiaolai181/dsh_laivox_tts/security/advisories/new

Please include a clear description of the issue, reproduction steps, affected version, and potential impact. We will review reports as soon as possible and coordinate a fix before public disclosure.

## Scope / 覆盖范围

**In scope:**
- Plugin host and client code in this repository
- Local library storage, path handling, and API key credential handling
- Network request boundaries and exported media handling

**Out of scope:**
- DeepSeek Harness (DSH) host runtime itself — please report host issues to upstream DSH
- Third-party online services such as Microsoft Edge Read Aloud
- Account/quota abuse issues unrelated to plugin code
