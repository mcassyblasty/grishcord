# Networking Plan

## DNS records
- `grishcord.countgrishnackh.com` -> origin IP (Cloudflare proxied allowed)
- `rtc.grishcord.countgrishnackh.com` -> origin IP (**DNS-only**, not proxied)
- `turn.grishcord.countgrishnackh.com` -> origin IP (**DNS-only**, not proxied)

## Router forwards (Verizon Fios G1100 context)
Forward to the Debian host:
- `80/tcp`, `443/tcp` (Caddy reverse proxy)
- `7881/tcp` (LiveKit ICE/TCP fallback)
- `50000-50999/udp` (LiveKit media)
- `3478/tcp`, `3478/udp` (TURN/STUN)
- `51000-51999/udp` (TURN relay)

## UFW rules
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50999/udp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 51000:51999/udp
sudo ufw enable
```

## Notes
- Web/API/chat WS are expected through Cloudflare proxy.
- RTP media and TURN must be direct to origin and DNS-only.
