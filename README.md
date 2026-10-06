---
title: TideAFK Web
emoji: 🎮
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# TideAFK Web

A Java Edition web dashboard for individually authenticated Mineflayer sessions. Each dashboard login has its own bot, live log stream, Microsoft device-code login, reconnect loop, and token-cache folder. The Microsoft password is entered only on Microsoft's website, never in TideAFK.

## Hugging Face Space setup

Create a Docker Space and upload this project folder. In **Settings → Variables and secrets**, add:

- `SESSION_SECRET`: a random value at least 32 characters long.
- `TIDEAFK_USERS`: a JSON object mapping each dashboard username to a unique password of at least 12 characters, for example `{"ivan":"replace-this-with-a-long-password","friend1":"use-another-long-password"}`.
- Optional `MC_HOST`, `MC_PORT`, and `JOIN_COMMAND`. Defaults are `hightidepvp.net`, `25565`, and `/queue economy`.
- Optional `DATA_DIR`; it defaults to `/data` in the container.

Keep these values private and use Space **Secrets** for passwords. The Space URL is the dashboard; each person signs in with their own dashboard credentials, then links their own Microsoft account using the displayed code. Set up persistent storage mounted at `/data` if you want Microsoft token caches to survive container restarts. Without persistent storage, users may need to sign in again after a restart.

## Free-tier availability

Free CPU Spaces can sleep after a period of inactivity and their local filesystem is temporary. That means a free Space is not a guaranteed 24/7 host: when it sleeps or restarts, Minecraft connections stop. Persistent storage or upgraded hardware changes the hosting cost/behavior; this project does not try to bypass Space sleep.

## Local run

Use Node.js 20 or newer, set the environment values above, then run `npm install` and `npm start`. The dashboard listens on port `7860` by default. The web deployment is Java Edition only; the existing Electron desktop app remains available with `npm run start:desktop`.

Only use AFK clients where the Minecraft server permits automated accounts and movement. Store `/data` securely because it contains Microsoft authentication tokens.
