# Linking Custom Domains — Beginner Guide

This guide walks you through connecting your domains to the deployed services.
No prior experience needed — just follow each step.

## What you want

| Service | Currently at | Target domain |
|---|---|---|
| Main app (React, Render) | `vmtb-main.onrender.com` | `vmtb-v2.3billionpairs.com` |
| Jitsi frontend (Vercel) | `vmtb-jitsi.vercel.app` | `meeting-vmtb-v2.3billionpairs.com` |
| Jitsi VM (GCP Compute) | `<VM_IP>` | `meet.3billionpairs.com` |

---

## Part 1 — Prerequisites (do these first)

### 1.1 Buy the domain (if you haven't already)

You need to own `3billionpairs.com`. If you don't:
- Go to [Namecheap](https://www.namecheap.com), [GoDaddy](https://www.godaddy.com), or [Google Domains](https://domains.google)
- Search for `3billionpairs.com` and buy it (~₹600-800/year for .com)

### 1.2 Know where your DNS is managed

DNS is the phonebook of the internet. When someone types `vmtb.3billionpairs.com`,
DNS tells their browser which server to connect to.

You manage DNS at:
- **Where you bought the domain** (Namecheap, GoDaddy, etc.) — most likely this
- **Cloudflare** — if you use their CDN/proxy (common for free SSL + speed)

**If you're not sure:** log into wherever you bought the domain. Look for
"DNS Management", "Nameservers", or "DNS Settings" in the dashboard.

### 1.3 What you'll be creating

You'll create three **DNS records**:

```
Type: CNAME   Name: vmtb-v2       Value: vmtb-main.onrender.com    TTL: Auto
Type: CNAME   Name: meeting-vmtb-v2   Value: vmtb-jitsi.vercel.app  TTL: Auto
Type: A       Name: meet          Value: <Jitsi VM IP>              TTL: 300
```

- A `CNAME` record points a hostname to another hostname (like forwarding mail)
- An `A` record points a hostname to an IP address

---

## Part 2 — Link `vmtb-v2.3billionpairs.com` to Render

### 2.1 Add the domain in Render

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click on your main app (the Static Site, probably named `vmtb-main` or similar)
3. Go to **Settings** (left sidebar)
4. Scroll down to **Custom Domains** section
5. Click **Add Custom Domain**
6. Type `vmtb-v2.3billionpairs.com` and click **Save**

Render will show you something like:

```
Add a CNAME record for vmtb-v2.3billionpairs.com pointing to vmtb-main.onrender.com
```

Write this down. You need it for the next step.

### 2.2 Add DNS record at your domain provider

1. Log into wherever you bought `3billionpairs.com`
2. Find the **DNS Management** page for `3billionpairs.com`
3. Add a new record:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Host/Name | `vmtb-v2` |
| Value/Target | `vmtb-main.onrender.com` (the value Render gave you) |
| TTL | `Auto` or `300` |

4. **Save** the record

### 2.3 Wait and verify

- DNS propagation takes **5 minutes to 48 hours** (usually ~30 min)
- To check: open a terminal and run:
  ```bash
  dig vmtb-v2.3billionpairs.com +short
  ```
  If it returns an IP or CNAME target, it's propagated.
- Or just open `https://vmtb-v2.3billionpairs.com` in your browser

### 2.4 Tell Render to issue SSL certificate

1. Back in Render dashboard → your app → **Settings** → **Custom Domains**
2. You should see `vmtb-v2.3billionpairs.com` with a status indicator
3. Render auto-provisions a free Let's Encrypt SSL certificate
4. Wait until it shows **"Live"** or the lock icon appears

### 2.5 Update Supabase allowlist

Supabase only accepts requests from allowed origins. Add your new domain:

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project (`togobilqdevoyijxrexc`)
3. Go to **Settings** → **API** → **Network** (or **Authentication** → **URL Configuration**)
4. Add `https://vmtb-v2.3billionpairs.com` to the **Redirect URLs** and **Site URL**

---

## Part 3 — Link `meet.3billionpairs.com` to Jitsi VM

This is more involved because the Jitsi VM uses a Let's Encrypt certificate
that must be generated for the domain. You need the VM running for this.

### 3.1 Start the VM

```bash
gcloud compute instances start jitsi-vm --zone=asia-south1-c --project vmtb-new
```

Wait 60 seconds for it to boot, then grab its IP:

```bash
sleep 60
gcloud compute instances describe jitsi-vm \
  --zone=asia-south1-c --project vmtb-new \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

Write down the IP. Call it `$VM_IP`.

### 3.2 Add DNS record at your domain provider

1. Log into wherever you bought `3billionpairs.com`
2. Find the **DNS Management** page
3. Add a new record:

| Field | Value |
|---|---|
| Type | `A` |
| Host/Name | `meet` |
| Value/Target | `$VM_IP` (the IP from step 3.1) |
| TTL | `300` |

4. **Save** the record

### 3.3 Wait for DNS to propagate

```bash
dig meet.3billionpairs.com +short
```

Must return `$VM_IP` before continuing. Let's Encrypt will fail otherwise.

### 3.4 SSH into the VM and reinstall Jitsi with the new domain

```bash
gcloud compute ssh jitsi-vm --zone=asia-south1-c
```

Once inside, run these commands one by one:

```bash
# Stop everything
sudo systemctl stop prosody jicofo nginx jitsi-videobridge2 || true

# Purge old Jitsi installation
sudo apt purge -y 'jitsi-meet*' prosody-0.12 jicofo jitsi-videobridge2
sudo rm -rf /etc/prosody /var/lib/prosody /var/log/prosody /etc/jitsi /etc/jicofo
sudo rm -f /etc/nginx/sites-available/34-180-60-14.sslip.io.conf \
           /etc/nginx/sites-enabled/34-180-60-14.sslip.io.conf

# Install Prosody
sudo apt install -y prosody-0.12

# Fix Lua 5.4 launcher bug
sudo sed -i '1c #!/usr/bin/lua5.4' /usr/bin/prosody /usr/bin/prosodyctl

# Install Jitsi Meet
sudo apt update && sudo apt install -y jitsi-meet
```

**During install, you'll be prompted:**
- **FQDN:** type `meet.3billionpairs.com`
- **Certificate:** select **"Generate a new self-signed certificate"**

After install, get a real certificate:

```bash
sudo /usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh
```

### 3.5 Re-wire transcription

The purge removed the transcription config. You need to redo it.
Follow **Part 4** of `CUSTOM_VM_DOMAIN.md` (lines 89-117) — replace every
occurrence of `meet.vmtb.in` with `meet.3billionpairs.com`.

Key files to edit on the VM:

```bash
# (a) Create the transcription plugin
sudo nano /usr/share/jitsi-meet/prosody-plugins/mod_force_async_transcription.lua
# (paste the content from DEPLOYMENT.md §6.5a)

# (b) Enable modules in Prosody config
sudo nano /etc/prosody/conf.avail/meet.3billionpairs.com.cfg.lua
# Inside the MUC component, add "muc_meeting_id" and "force_async_transcription" to modules_enabled

# (c) Configure Jicofo transcription URL
sudo nano /etc/jitsi/jicofo/jicofo.conf
# Add: transcription { url-template = "wss://YOUR_PROXY_URL/transcribe?sessionId={{MEETING_ID}}&sendBack=true" }

# (d) Enable transcription in config.js
sudo nano /etc/jitsi/meet/meet.3billionpairs.com-config.js
# Add: transcription: { enabled: true },

# (e) Restart everything
sudo systemctl restart prosody jicofo nginx
```

### 3.6 Verify

Open `https://meet.3billionpairs.com` in your browser.
- You should see the Jitsi Meet landing page
- Green padlock (SSL working)
- No certificate warnings

### 3.7 Shut down the VM (to save cost)

```bash
gcloud compute instances stop jitsi-vm --zone=asia-south1-c
```

---

## Part 4 — Link `meeting-vmtb-v2.3billionpairs.com` to Vercel

The Jitsi meeting frontend (Vercel) also needs a custom domain.

### 4.1 Add the domain in Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click on your jitsi-frontend project (probably named `vmtb-jitsi`)
3. Go to **Settings** → **Domains**
4. Type `meeting-vmtb-v2.3billionpairs.com` and click **Add**

Vercel will show you:

```
Add a CNAME record for meeting-vmtb-v2.3billionpairs.com pointing to cname.vercel-dns.com
```

### 4.2 Add DNS record at your domain provider

1. Log into wherever you bought `3billionpairs.com`
2. Find the **DNS Management** page
3. Add a new record:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Host/Name | `meeting-vmtb-v2` |
| Value/Target | `cname.vercel-dns.com` |
| TTL | `Auto` or `300` |

4. **Save** the record

### 4.3 Wait and verify

```bash
dig meeting-vmtb-v2.3billionpairs.com +short
```

Should return something like `cname.vercel-dns.com` or a Vercel IP.

### 4.4 Vercel auto-provisions SSL

Vercel automatically provisions a Let's Encrypt certificate once DNS propagates.
No manual steps needed — just wait a few minutes.

---

## Part 5 — Update code references

After domains are live, update these in the codebase:

### 5.1 `main/src/services/meeting.ts` (line 3)

```typescript
// Change this:
const JITSI_MEET_URL = 'https://meet.vmtb.in';
// To this:
const JITSI_MEET_URL = 'https://meet.3billionpairs.com';
```

### 5.2 `jitsi-frontend/.env.production`

```
VITE_JITSI_DOMAIN=meet.3billionpairs.com
VITE_MAIN_APP_URL=https://vmtb-v2.3billionpairs.com
```

### 5.3 `jitsi-activation-backend/main.py` — CORS origins

Add your new domains to the CORS list (or set the `CORS_ORIGINS` env var):

```python
default_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://vmtb-v2.3billionpairs.com",
    "https://meeting-vmtb-v2.3billionpairs.com",
    "https://meet.3billionpairs.com",
    # keep old ones too if needed
]
```

### 5.4 Render environment variables

In Render dashboard → your app → **Settings** → **Environment**:

| Variable | Value |
|---|---|
| `VITE_SERVER_LOADER_URL` | `https://meeting-vmtb-v2.3billionpairs.com` |

### 5.5 Vercel environment variables

In Vercel dashboard → your project → **Settings** → **Environment Variables**:

| Variable | Value |
|---|---|
| `VITE_JITSI_DOMAIN` | `meet.3billionpairs.com` |
| `VITE_MAIN_APP_URL` | `https://vmtb-v2.3billionpairs.com` |

Then redeploy the Vercel project.

---

## Part 6 — Cost-saving features (already built in)

Your codebase already handles this correctly:

1. **Jitsi VM stays OFF when no meetings are happening**
   - The activation backend (`/start-jitsi` / `/stop-jitsi`) controls the VM
   - When the last person leaves a meeting, it auto-stops (~1 min delay)
   - The VM only bills when RUNNING (~₹3/hr for e2-standard-4)

2. **Cloud Run services scale to zero**
   - STT, proxy, worker, activation backend — all scale to zero when idle
   - They wake up on-demand when someone hits them

3. **GPU only runs during transcription**
   - `stt-service` has `--min-instances=0 --max-instances=2`
   - L4 GPU bills only when warm (during active meetings)

**Estimated monthly cost when idle (no meetings):**
- Render Static Site: free tier
- Vercel Static Site: free tier
- Cloud Run services: ₹0 (scaled to zero)
- Jitsi VM: ₹0 (stopped)
- GCS + Pub/Sub: pennies
- **Total: ~₹0/month when not in use**

---

## Quick Reference — DNS Records Summary

| Record | Type | Host | Value | TTL |
|---|---|---|---|---|
| Main app (Render) | CNAME | `vmtb-v2` | `vmtb-main.onrender.com` | Auto |
| Meeting frontend (Vercel) | CNAME | `meeting-vmtb-v2` | `cname.vercel-dns.com` | Auto |
| Jitsi VM | A | `meet` | `<STATIC_IP>` (see Part 7) | 300 |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `vmtb-v2.3billionpairs.com` shows Render 404 | DNS not propagated yet. Wait or check with `dig`. Also verify domain is added in Render dashboard. |
| `meeting-vmtb-v2.3billionpairs.com` shows Vercel 404 | DNS not propagated yet, or domain not added in Vercel. Check `dig` and Vercel dashboard. |
| `meet.3billionpairs.com` shows connection refused | VM is stopped. Run `gcloud compute instances start jitsi-vm --zone=asia-south1-c` |
| SSL certificate warning on `meet.*` | DNS A record doesn't match VM IP, or Let's Encrypt hasn't issued yet. Verify `dig meet.3billionpairs.com` returns the correct IP. |
| Jitsi loads but meetings don't connect | Transcription wiring is missing. Re-do Part 3.5. |
| CORS error in browser console | New domain not in CORS allowlist. Update `CORS_ORIGINS` env var or the Python defaults. |
| VM IP changed after restart | If you reserved a static IP (Part 7), this shouldn't happen. Otherwise, update the `meet` A record and wait for TTL (300s). |

---

## Part 7 — Reserve a Static IP for the Jitsi VM (recommended)

By default, the VM gets a **new IP every time you start it** (ephemeral IP).
This means you'd have to update the DNS `A` record every restart, and wait
~5 min for propagation. A **static external IP** avoids this entirely.

### Cost

~₹10/day (~₹300/month). Worth it if you run meetings regularly.

### 7.1 Reserve the IP

You can do this via the CLI or the Console.

#### Option A: CLI (faster)

```bash
# Reserve a static IP named "jitsi-static-ip" in the same region as your VM
gcloud compute addresses create jitsi-static-ip \
  --region=asia-south1 \
  --project=vmtb-new

# See the IP it assigned you
gcloud compute addresses describe jitsi-static-ip \
  --region=asia-south1 \
  --project=vmtb-new \
  --format='value(address)'
```

Write down the IP — call it `$STATIC_IP`.

#### Option B: GCP Console (visual)

1. Go to [GCP Console](https://console.cloud.google.com)
2. Make sure you're in project `vmtb-new`
3. Go to **VPC Network** → **External IP addresses** (left sidebar)
4. Click **Reserve IP address**
5. Fill in:
   - **Name:** `jitsi-static-ip`
   - **Region:** `asia-south1` (same as your VM)
   - **Network service tier:** Standard
6. Click **Reserve**
7. Copy the IP address it shows you — that's `$STATIC_IP`

### 7.2 Attach the IP to the VM

The VM must be **stopped** to attach a static IP.

```bash
# Stop the VM first (if running)
gcloud compute instances stop jitsi-vm --zone=asia-south1-c --project=vmtb-new

# Attach the static IP
gcloud compute instances delete-access-config jitsi-vm \
  --access-config-name="external-nat" \
  --zone=asia-south1-c \
  --project=vmtb-new

gcloud compute instances add-access-config jitsi-vm \
  --access-config-name="external-nat" \
  --address=$STATIC_IP \
  --zone=asia-south1-c \
  --project=vmtb-new
```

Or via GCP Console:
1. Go to **Compute Engine** → **VM instances**
2. Click `jitsi-vm` → **Edit**
3. Under **Network interfaces**, click **Edit** (pencil icon on the network interface)
4. Expand **External IP**
5. Select **None** first (to release the old ephemeral IP)
6. Save, wait a few seconds, edit again
7. Select **Static IP** → choose `jitsi-static-ip`
8. **Save**

### 7.3 Update your DNS A record

Once the static IP is attached, update the DNS record at your domain provider:

| Field | Value |
|---|---|
| Type | A |
| Host/Name | `meet` |
| Value/Target | `$STATIC_IP` |
| TTL | `300` |

### 7.4 Start the VM and verify

```bash
# Start the VM
gcloud compute instances start jitsi-vm --zone=asia-south1-c --project=vmtb-new

# Verify the static IP is assigned
gcloud compute instances describe jitsi-vm \
  --zone=asia-south1-c --project=vmtb-new \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
# Should print $STATIC_IP

# Verify DNS resolves
dig meet.3billionpairs.com +short
# Should print $STATIC_IP
```

Open `https://meet.3billionpairs.com` — green padlock, Jitsi landing page.

### 7.5 After this, you never touch DNS again

The IP never changes. Start/stop the VM freely:

```bash
gcloud compute instances start jitsi-vm --zone=asia-south1-c --project=vmtb-new
gcloud compute instances stop jitsi-vm --zone=asia-south1-c --project=vmtb-new
```

The DNS record always points to the same IP. No updates needed.

---

## Summary: DNS Records (final state)

| Record | Type | Host | Value | TTL |
|---|---|---|---|---|
| Main app (Render) | CNAME | `vmtb-v2` | `vmtb-main.onrender.com` | Auto |
| Meeting frontend (Vercel) | CNAME | `meeting-vmtb-v2` | `cname.vercel-dns.com` | Auto |
| Jitsi VM | A | `meet` | `<STATIC_IP>` (never changes) | 300 |

---

## Cost breakdown

| Item | Cost |
|---|---|
| Static IP (reserved, attached to running VM) | ~₹10/day (~₹300/month) |
| Static IP (reserved, **not** attached) | Free |
| VM running (e2-standard-4) | ~₹3/hr (~₹72/day if left on) |
| VM stopped | ₹0 |
| Cloud Run (all services, idle) | ₹0 |
| Render Static Site | ₹0 (free tier) |
| Vercel Static Site | ₹0 (free tier) |

**Tip:** The static IP only costs money while the VM is running. When you stop
the VM, the IP stays reserved at no charge. You only pay the ~₹10/day for the
IP while the VM is actually running.
