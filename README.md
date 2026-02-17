## ChitChat

Desktop client (Tauri + React) for ChitChat.

Server and deployment assets were moved to the backend repository.

## Local Development

Install dependencies:

```bash
npm ci
```

Run dev server:

```bash
npm run dev
```

Run Tauri app:

```bash
npm run tauri dev
```

Build web assets:

```bash
npm run build
```

## Dependency Security

Run audits locally:

```bash
npm run audit:deps
```

CI workflow:
- `.github/workflows/dependency-audit.yml`
