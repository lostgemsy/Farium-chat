# HOHOGAMES Silver Chat

A full-screen, mobile-friendly community chat inspired by the uploaded black/silver glass theme.

## Included

- Full-screen WebGL metallic wave + molecular background
- Floating sign-in/sign-up experience with no iframe shells
- First account must be `hohogames` and becomes the Owner
- Owner/Admin badges in chat
- Global chat with message history
- Profiles + avatar uploads
- Friend requests
- Groups with member invites
- Voice queue + WebRTC peer-to-peer voice
- Push-to-talk settings and mobile HOLD TO TALK button
- Admin-only panel
- Mute controls
- Online-user IP ban/unban list (IP is captured server-side for online users)
- Owner-only admin promotion/removal
- Announcement broadcaster
- Draggable HUD editor for site-wide messages
- Site pause/lockdown with reason + countdown
- Global chat reset
- MP3 soundboard upload + site-wide broadcast
- Socket.IO real-time presence and moderation events

## Run in GitHub Codespaces

```bash
npm install
npm start
```

The app listens on port `8080` by default. In Codespaces, forward port 8080 and open the forwarded URL.

## Production notes

Use HTTPS for deployed WebRTC microphone access. Put the app behind a reverse proxy and set `TRUST_PROXY` correctly for the deployment. The JSON database is intentionally lightweight for a starter project; move persistence to PostgreSQL/Redis or another managed database for a larger community.
