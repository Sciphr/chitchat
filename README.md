## ChitChat

Voice/video/text chat with:
- Desktop client (Tauri/React)
- Self-hosted Node server (`server/`)
- Built-in admin panel

## Server Quick Start (Linux)

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/Sciphr/chitchat/main/install.sh | sudo bash
```

This installs:
- ChitChat server as `systemd` service (`chitchat`)
- LiveKit server as `systemd` service (`livekit-server`)
- Server data/config under `/var/lib/chitchat`

## Post-Install Basics

Health check:

```bash
curl -i http://127.0.0.1:3001/api/health
```

Service status/logs:

```bash
sudo systemctl status chitchat
sudo journalctl -u chitchat -f
sudo systemctl status livekit-server
sudo journalctl -u livekit-server -f
```

## Production Deployment (Recommended)

Run ChitChat behind Nginx with TLS:
- Public URL: `https://chat.example.com`
- Nginx proxy to local app port (for example `127.0.0.1:3001` or your configured port)

LiveKit should use secure websocket:
- Preferred: dedicated hostname `wss://rtc.example.com`
- Avoid using insecure `ws://` from an HTTPS client (mixed-content blocked)

After enabling reverse proxy:
- In Admin Panel > Security:
  - Enable `Trust Reverse Proxy`
- In Admin Panel > Media:
  - Set `LiveKit URL` to `wss://...`
- In server config:
  - Set CORS allowed origins to your HTTPS app domain(s)

## Admin Panel

Default path:
- `/admin`

Key controls:
- Registration policy (invite only, password minimum, allow/block lists)
- Message/file limits
- Security controls:
  - JWT expiry
  - bcrypt rounds
  - login lockout policy
  - reverse proxy trust
  - request logging

## Config

Primary config file:
- `/var/lib/chitchat/config.json` (installer path)

Sample env variables:
- See `.env.example`

## Dependency Security

Run audits locally:

```bash
npm run audit:deps
npm --prefix server run audit:deps
```

CI workflow:
- `.github/workflows/dependency-audit.yml`
