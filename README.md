# Hermes — WhatsApp AI Coding Agent

Hermes is an autonomous coding agent that lives on your Linux server and is controlled entirely through WhatsApp. Send a voice note from the gym, a screenshot of a bug, or a text request — Hermes executes it directly on your server.

## Features

- **Voice messages** → transcribed via Groq Whisper, then processed
- **Image messages** → analyzed via vision models (kimi-k2.5 / glm-5.2)
- **Bash execution** on the server with safety guardrails
- **File read/write** for building and editing projects
- **Git clone** any repository
- **Auto-deploy** projects with PM2 + Nginx
- **Web search** via DuckDuckGo
- **Conversation memory** per session (last 20 messages)
- **Single-owner security** — the first number to contact Hermes becomes the only authorized user
- **Auto-reconnect watchdog** — Chrome/Puppeteer health checked every 3 minutes

## WhatsApp number

Hermes needs a dedicated WhatsApp number to operate — ideally not your personal one. A good approach is to register a virtual number through an online temporary SMS service (search for services like smsman, smsspool, or similar). Get a number, verify WhatsApp with the OTP, then scan the QR. That's it — your main phone stays clean.

## Requirements

- Node.js 18+
- Google Chrome stable (`/usr/bin/google-chrome-stable`)
- `ffmpeg` (for audio conversion)
- PM2 (`npm install -g pm2`)

## Setup

```bash
git clone https://github.com/marcosdeaza/hermes.git
cd hermes
npm install
cp .env.example .env
# Fill in your API keys in .env
```

### API Keys needed

| Key | Where to get it |
|-----|----------------|
| `BAI_API_KEY` | [b.ai](https://b.ai) — access to kimi-k2.5 and glm-5.2 |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free Whisper transcription |

## Run

```bash
# Development
npm start

# Production with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

On first launch, a QR code is saved to `qr-code.png`. Scan it with WhatsApp (Settings → Linked Devices → Link a Device). The first phone number that messages Hermes becomes the registered owner — all other numbers are silently ignored.

## Commands

| Command | Action |
|---------|--------|
| `!modelo kimi` | Switch to kimi-k2.5 |
| `!modelo glm` | Switch to glm-5.2 |
| `!reset` | Clear conversation history |
| `!status` | Show server CPU/RAM/disk info |
| `!help` | Show all commands |

## Usage examples

```
"Create a REST API in Node.js and deploy it on port 3001"
"Clone github.com/user/repo and set it up"
"How much disk space is left?"
"What's in /var/www/myproject/index.js?"
```

Or just send a voice note — Hermes transcribes it and responds.

## Security

- Only the registered owner number can interact with Hermes
- Blocked commands: `rm -rf /`, `shutdown`, `reboot`, format commands, etc.
- Blocked paths: `/etc/shadow`, `/etc/passwd`, `~/.ssh`, etc.
- Unauthorized senders receive no response (silent ignore)

## Models

Hermes uses [b.ai](https://b.ai) which provides access to:
- **kimi-k2.5** — default, strong coding and reasoning, supports vision
- **glm-5.2** — alternative model

Voice transcription uses **Groq Whisper large-v3** (free tier available).

## License

MIT
