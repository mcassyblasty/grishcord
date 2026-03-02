# Networking Plan

## DNS records
- `grishcord.countgrishnackh.com` -> origin IP (Cloudflare proxied allowed)

## Router forwards (Verizon Fios G1100 context)
Forward to the Debian host:
- `80/tcp`, `443/tcp` (Caddy reverse proxy)

## UFW rules
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## Notes
- Web, API, and authenticated WebSocket traffic are expected through Cloudflare proxy.
- No separate media relay ports are required because Grishcord is text/attachments only.
