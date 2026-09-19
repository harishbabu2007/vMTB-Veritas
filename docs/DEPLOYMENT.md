# vMTB Deployment Guide — everything from scratch

This is the **only** document you need to take an empty cloud account to a
fully working platform: GCP backend, Jitsi VM, Render app, Vercel frontend,
CI/CD buttons in GitHub, then a real end-to-end test. It also folds in the
GCP-only manual `gcloud` alternative previously in `docs/GCP_SETUP.md` (§2
appendix) for anyone who wants to skip the GitHub Actions buttons.

Follow top to bottom. Steps marked **(one-time)** never need repeating.
If you already did part of §2 (e.g. bucket/Pub/Sub), just skip those blocks.

Total time estimate: **half a day** (most of it waiting on builds/quota/DNS).

> **Flagged, not corrected:** this guide describes `main/`'s frontend
> hosting as Render (`vmtb-main.onrender.com`). Per current confirmation,
> the live main app's domain is `vmtb.3billionpairs.com` — the underlying
> hosting platform for that domain wasn't re-verified as part of this
> documentation pass, and per the project owner, service domains are
> actively in flux during development. Don't assume §7.1 (Render setup) is
> still exactly how `main/` is deployed today without checking; jitsi-frontend/
> jitsi-activation-backend/opus-transcriber-proxy/stt-service/transcript-worker
> hosting *is* confirmed current — see `docs/CLOUD_INVENTORY.md`.
>
> Every `feature/codebase-reorg` branch reference below is **stale** — that
> branch was this repo's pre-monorepo working branch and no longer reflects
> current git state (see the root `CLAUDE.md` for the actual git workflow:
> feature branches off `main`, merged via PR). Read "the branch you're
> deploying from" wherever this guide says `feature/codebase-reorg`.

---

## 0. What you are building

| Component | Where | URL |
|---|---|---|
| `main/` app | Render Static Site (**new**, §7.1) | `https://vmtb-main.onrender.com` |
| `jitsi-frontend/` | Vercel (**new**, §7.2) | `https://<you>.vercel.app` |
| `stt-service` (GPU Whisper) | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `opus-transcriber-proxy` | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `transcript-worker` | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `jitsi-activation-backend` | Cloud Run, `asia-southeast1` | assigned by Cloud Run |
| `jitsi-vm` (JVB/Prosody/Jicofo) | Compute Engine, `asia-south1-c` (**new**, §6) | `https://<VM_IP>` (custom domain later, §6.7) |
| Transcript artifacts | GCS `gs://vmtb-transcripts` | internal |
| Minutes-of-Meeting LLM | Mistral API | external |

Everything Cloud Run is **scale-to-zero** (no idle cost). The VM and the warm
GPU only bill while a meeting is active (see §9).

### CI/CD model

Every deployable unit has its own **manual button** in GitHub → Actions
(`workflow_dispatch`) — nothing deploys on every commit unless you also keep
the Vercel/Render git-integration enabled (optional):

| Button (workflow) | Deploys | Mechanism |
|---|---|---|
| Deploy stt-service | Cloud Run GPU | Cloud Build → Cloud Run |
| Deploy opus-transcriber-proxy | Cloud Run | Cloud Build → Cloud Run |
| Deploy transcript-worker | Cloud Run | Cloud Build → Cloud Run (+ repairs Pub/Sub wiring) |
| Deploy jitsi-activation-backend | Cloud Run | Cloud Build → Cloud Run |
| Deploy jitsi-frontend (Vercel) | Vercel prod | Vercel CLI (`vercel deploy --prod`) |
| Deploy main app (Render) | Render static site | Render Deploy Hook |

### How every URL connects (master wiring table)

| # | From → To | Value | Set where | When |
|---|---|---|---|---|
| 1 | main app → jitsi-frontend | `VITE_SERVER_LOADER_URL=<vercel-url>` | Render env vars | §7.3 (manual!) |
| 2 | jitsi-frontend → activation backend | `VITE_JITSI_BACKEND_URL=<ACT_URL>` | Vercel env vars | §7.2 (manual!) |
| 3 | jitsi-frontend → main app | `VITE_MAIN_APP_URL=<render-url>` | Vercel env vars | §7.2 (manual!) |
| 4 | activation backend → Jitsi VM | name `jitsi-vm`, zone `asia-south1-c` | baked into workflow | automatic |
| 5 | activation backend → STT/proxy | service names (Cloud Run API) | baked into workflow | automatic |
| 6 | proxy → STT | `STT_WS_URL` fetched at deploy time | proxy workflow | automatic |
| 7 | Pub/Sub → worker | push subscription w/ token | worker workflow | automatic |
| 8 | worker → GCS/Supabase/Mistral | secrets | Secret Manager | §2.4, §5 |
| 9 | **Jicofo (VM) → proxy** | `wss://<PROXY_URL>/transcribe?...` | `jicofo.conf` on VM | §6.5 (manual!) |
| 10 | browsers → VM | the VM's raw IP (self-signed cert) | nothing to set — IP is the URL | §6.2 |

Manual links: #1, #2, #3, #9. Everything else self-wires during deploys.
(DNS/domain linking is deliberately deferred to §6.7.)

---

## 1. Prerequisites

- GCP project with billing enabled (✅ you have this). Collect:
  ```bash
  gcloud auth login && gcloud config set project YOUR_PROJECT_ID
  gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)'
  ```
- **You must be `roles/owner` on the project** (not just Editor or Project
  IAM Admin). University/org-shared projects usually aren't. Check:
  ```bash
  gcloud projects get-iam-policy YOUR_PROJECT_ID \
    --flatten="bindings[].members" \
    --filter="bindings.members:$(gcloud config get-value account)" \
    --format="table(bindings.role)"
  ```
  If `roles/owner` is missing, ask whoever manages the project to run:
  ```bash
  gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="user:YOUR_EMAIL" --role="roles/owner"
  ```
  Otherwise many steps below fail with `setIamPolicy denied` errors.
  *(Workaround if you only have Project IAM Admin: replace per-secret IAM
  bindings in §2.4 with one project-level binding — see troubleshooting.)*
- Your GitHub repo pushed and Actions enabled, e.g. `harishbabu2007/vMTB-Veritas`.
  All work currently lives on the `feature/codebase-reorg` branch — §7
  configures both frontends to build from it.
- A [Vercel](https://vercel.com) account (sign in with GitHub).
- A [Render](https://render.com) account (sign in with GitHub).
- A [Mistral](https://console.mistral.ai/) account (free tier OK).
- Supabase project URL, anon key and **service role key**.
- DNS access for `vmtb.in` — **not needed initially** (raw VM IP); required
  later per §6.7.

---

## 2. One-time GCP setup

Replace `YOUR_PROJECT_ID`, `YOUR_PROJECT_NUMBER`, `YOUR_GH_USER` everywhere.

### 2.1 Enable APIs

```bash
gcloud services enable \
  run.googleapis.com compute.googleapis.com artifactregistry.googleapis.com \
  pubsub.googleapis.com storage.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com
```

### 2.2 Artifact Registry, bucket, Pub/Sub topic *(skip what you already made)*

```bash
gcloud artifacts repositories create vmtb-services \
  --repository-format=docker --location=asia-southeast1

gcloud storage buckets create gs://vmtb-transcripts \
  --location=asia-southeast1 --uniform-bucket-level-access   # ✅ if already created

gcloud pubsub topics create meeting-transcripts              # ✅ if already created
```

(The push subscription is created automatically by the transcript-worker
workflow — no manual step.)

### 2.3 Service accounts & permissions

```bash
PROJECT_ID=vmtb-new

gcloud iam service-accounts create vmtb-services   --display-name="vMTB transcription services"
gcloud iam service-accounts create vmtb-activator  --display-name="vMTB meeting activator"
gcloud iam service-accounts create vmtb-deployer   --display-name="vMTB CI deployer"

# runtime SA: invoke services, write artifacts, read secrets, publish events
for ROLE in roles/run.invoker roles/storage.objectAdmin roles/secretmanager.secretAccessor roles/pubsub.publisher; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done

# activator SA: start/stop the VM, probe Cloud Run services.
# NOTE: read-only + invoker on purpose. The activation backend never writes
# Cloud Run scaling configuration (a former min-instances patching design
# left an idle L4 GPU resident and dominated our bill). If you are upgrading
# an older deployment, revoke roles/run.developer from vmtb-activator:
#   gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
#     --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" \
#     --role="roles/run.developer"
for ROLE in roles/compute.instanceAdmin.v1 roles/run.viewer roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done
gcloud iam service-accounts add-iam-policy-binding \
  "vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" \
  --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# deployer SA: what GitHub Actions may do
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer \
            roles/cloudbuild.builds.builder roles/storage.objectAdmin roles/secretmanager.viewer \
            roles/pubsub.editor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-deployer@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done

# --- Cloud Build's default service account ---------------------------------
# On newer projects it does NOT have Editor, so Cloud Build cannot read its
# own uploaded sources or push images. Without this, builds fail with
# "storage.objects.get denied on <project>_cloudbuild" or registry errors.
BUILD_SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
for ROLE in roles/storage.objectAdmin roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$BUILD_SA" --role="$ROLE"
done
```

### 2.4 Secrets (Secret Manager)

```bash
PROJECT_ID=vmtb-new

printf '%s' 'https://YOUR-PROJECT.supabase.co' | \
  gcloud secrets create supabase-url --data-file=- --replication-policy=automatic
printf '%s' 'PASTE_SERVICE_ROLE_KEY_HERE' | \
  gcloud secrets create supabase-service-role-key --data-file=- --replication-policy=automatic
# llm-api-key is filled with the real Mistral key in §5; placeholder until then:
printf '%s' 'placeholder' | \
  gcloud secrets create llm-api-key --data-file=- --replication-policy=automatic

for SECRET in supabase-url supabase-service-role-key llm-api-key; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

> ⚠️ **Never paste real keys into this file or any committed file.** Placeholders
> only — real values go straight into Secret Manager / platform dashboards.
> If a real key ever lands in git, treat it as compromised: rotate it first,
> clean history second.
```

### 2.5 GPU quota

Good news: new projects are **automatically granted 3 L4 GPUs** (zonal
redundancy off) on first GPU deployment — enough for `--max-instances 2`.
Our deploy uses `--no-gpu-zonal-redundancy` (cheaper, no reservation), so in
most cases you don't need to request anything. If the STT deploy still fails
with a GPU quota error, request quota: Console → **IAM & Admin → Quotas &
System Limits** → filter `NVIDIA_L4_GPUS`, region `asia-southeast1` →
request **3** for *without zonal redundancy*.

### 2.6 GitHub Actions authentication for GCP (Workload Identity Federation)

No keys stored in GitHub — OIDC token exchange:

```bash
PROJECT_NUMBER=670475652201
GH_REPO="projecth2025/vMTB-Veritas"
PROJECT_ID=vmtb-new

gcloud iam workload-identity-pools create github-pool \
  --location=global --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GH_REPO}'"

gcloud iam service-accounts add-iam-policy-binding \
  "vmtb-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GH_REPO}"
```

### 2.7 All GitHub repository secrets (do this once)

GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value | From |
|---|---|---|
| `GCP_PROJECT_ID` | your project id | §2 |
| `GCP_WIF_PROVIDER` | `projects/YOUR_PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider` | §2.6 |
| `GCP_DEPLOY_SA` | `vmtb-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com` | §2.3 |
| `RENDER_DEPLOY_HOOK` | Render deploy-hook URL | §7.1 step C |
| `VERCEL_TOKEN` | Vercel personal access token | §7.2 step D |
| `VERCEL_ORG_ID` | Vercel org/team id | §7.2 step D |
| `VERCEL_PROJECT_ID` | Vercel project id | §7.2 step D |

(GCP secrets can be added now; the Render/Vercel ones after §7 creates those
projects.)

---

## 2A. Appendix — manual `gcloud`-only alternative to §2/§4

*(Merged from the former `docs/GCP_SETUP.md`, which used direct `gcloud
builds submit`/`gcloud run deploy` commands instead of the GitHub Actions
buttons above. Superseded by §2/§4 as the recommended path — kept here for
anyone who wants to deploy without wiring up CI, or who wants to understand
what the buttons do underneath. The original doc used region `asia-south1`
throughout; corrected to `asia-southeast1` below to match the confirmed-live
region per `docs/CLOUD_INVENTORY.md` — `asia-south1` L4 GPU access is
invitation-gated, see `docs/GPU_ACCESS_MUMBAI.md`.)*

```bash
# APIs (same as §2.1)
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  pubsub.googleapis.com storage.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com

# Artifact Registry + docker auth
gcloud artifacts repositories create vmtb-services \
  --repository-format=docker --location=asia-southeast1
gcloud auth configure-docker asia-southeast1-docker.pkg.dev

# GCS bucket for transcript artifacts
gcloud storage buckets create gs://vmtb-transcripts \
  --location=asia-southeast1 --uniform-bucket-level-access

# Pub/Sub topic + a push subscription (fill in the real worker URL once deployed)
gcloud pubsub topics create meeting-transcripts
gcloud pubsub subscriptions create meeting-transcripts-worker \
  --topic=meeting-transcripts \
  --push-endpoint=REPLACE_WITH_WORKER_URL_AFTER_DEPLOY \
  --push-auth-service-account=YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --ack-deadline=60
```

Build + deploy each service directly (equivalent to what the GitHub Actions
buttons in §4 do):

```bash
# stt-service (GPU) — model is baked into the image at build time
cd stt-service
gcloud builds submit --tag \
  asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/stt-service:medium \
  --build-arg=STT_DEVICE=gpu --build-arg=STT_MODEL=medium .

gcloud run deploy stt-service \
  --image=asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/stt-service:medium \
  --region=asia-southeast1 --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy \
  --memory=16Gi --cpu=4 --no-allow-unauthenticated \
  --service-account=vmtb-services@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=STT_MODEL=medium,STT_DEVICE=cuda,STT_COMPUTE_TYPE=float16 \
  --min-instances=0 --max-instances=2 --concurrency=1   # concurrency=1: transcription is serialized per instance

# opus-transcriber-proxy
cd opus-transcriber-proxy
gcloud builds submit --tag \
  asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/opus-transcriber-proxy .
gcloud run deploy opus-transcriber-proxy \
  --image=asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/opus-transcriber-proxy \
  --region=asia-southeast1 --no-allow-unauthenticated \
  --service-account=vmtb-services@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=PROVIDER=self-hosted,STT_SAMPLE_RATE=16000,STT_CHUNK_MS=60 \
  --set-env-vars=STT_WS_URL=<stt-service URL>/client/ws/speech \
  --set-env-vars=GCP_PROJECT_ID=YOUR_PROJECT_ID,PUBSUB_TOPIC=meeting-transcripts \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest \
  --min-instances=0 --max-instances=10 --concurrency=50

# transcript-worker
cd transcript-worker
gcloud builds submit --tag \
  asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/transcript-worker .
gcloud run deploy transcript-worker \
  --image=asia-southeast1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/transcript-worker \
  --region=asia-southeast1 --no-allow-unauthenticated \
  --service-account=vmtb-services@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=GCS_BUCKET=vmtb-transcripts,GCP_PROJECT_ID=YOUR_PROJECT_ID,LLM_PROVIDER=mistral \
  --set-env-vars=LLM_BASE_URL=https://api.mistral.ai/v1,LLM_MODEL=mistral-small-latest \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest \
  --set-secrets=LLM_API_KEY=llm-api-key:latest \
  --min-instances=0 --max-instances=5

# then wire Pub/Sub push with a token (see §4/§8 for the equivalent via the
# GitHub Actions buttons, which do this step for you automatically):
gcloud run services update transcript-worker --region=asia-southeast1 \
  --update-env-vars=PUBSUB_PUSH_TOKEN=RANDOM_TOKEN
gcloud pubsub subscriptions update meeting-transcripts-worker \
  --push-endpoint=<transcript-worker URL>/pubsub/push \
  --push-auth-token=RANDOM_TOKEN
```

Common gotchas specific to the manual path (the GitHub Actions workflows
already handle all of these): GPU quota is the most common blocker — request
it early (§2.5); STT and proxy regions must agree (`STT_WS_URL` must point
at wherever STT actually landed); keep STT at `concurrency=1`; Cloud Run's
default idle timeout (~15 min) is shorter than a real meeting — set
`--timeout=3600` and rely on the proxy/STT heartbeat rather than the
platform for liveness.

## 3. Supabase schema (one-time)

Supabase Dashboard → **SQL Editor** → paste all of
`main/supabase/migrations/20260820_meeting_transcripts.sql` → **Run**.
Creates `meeting_transcripts`, `meeting_transcript_segments`, the state RPCs,
RLS policies and realtime publication.

---

## 4. Deploy the four backend services (GitHub buttons)

GitHub → **Actions** tab → pick a workflow → **Run workflow** → keep defaults.
Deploy strictly in this order:

1. **Deploy stt-service** — first build takes ~15–25 min (CUDA wheels +
   Whisper `medium` model baked into the image).
2. **Deploy opus-transcriber-proxy** — auto-fetches the STT URL.
3. **Deploy transcript-worker** — wires secrets + creates the Pub/Sub push
   subscription automatically.
4. **Deploy jitsi-activation-backend**.

Then collect the URLs you'll need later:

```bash
YOUR_PROJECT_ID=vmtb-new

gcloud run services list --project $YOUR_PROJECT_ID
PROXY_URL=$(gcloud run services describe opus-transcriber-proxy \
  --project $YOUR_PROJECT_ID --region asia-southeast1 --format 'value(status.url)')
ACT_URL=$(gcloud run services describe jitsi-activation-backend \
  --project $YOUR_PROJECT_ID --region asia-southeast1 --format 'value(status.url)')
echo "PROXY=$PROXY_URL"; echo "ACT=$ACT_URL"
```

> **Write down `PROXY_URL`** — needed in §6.5 (Jicofo config).
> **Write down `ACT_URL`** — needed in §7 (frontends).

---

## 5. Mistral setup (Minutes-of-Meeting)

1. <https://console.mistral.ai/> → **API Keys** → *Create new key*.
2. Store it (replaces the placeholder from §2.4):
   ```bash
   printf '%s' 'YOUR_REAL_MISTRAL_KEY' | \
     gcloud secrets versions add llm-api-key --data-file=-
   ```
3. Redeploy **transcript-worker** via its Action button so the running
   container picks up the new secret version.
4. Config already set in the workflow: `LLM_BASE_URL=https://api.mistral.ai/v1`,
   `LLM_MODEL=mistral-small-latest`. Transient 429/5xx errors are retried
   automatically (`transcript-worker/src/llm.ts`).

Quick sanity check of your key:

```bash
curl https://api.mistral.ai/v1/chat/completions \
  -H "Authorization: Bearer $MISTRAL_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"mistral-small-latest","response_format":{"type":"json_object"},
       "messages":[{"role":"user","content":"Return {\"summary\":\"ok\"}"}]}'
```

---

## 6. Jitsi VM from scratch (raw IP for now, domain later)

This creates the VM that runs JVB (media), Prosody (XMPP), Jicofo (conference
logic) and nginx. Nothing else in the pipeline works without it.

### 6.1 Firewall rules (one-time)

```bash
gcloud compute firewall-rules create allow-jitsi-http \
  --allow=tcp:80 --source-ranges=0.0.0.0/0
gcloud compute firewall-rules create allow-jitsi-https \
  --allow=tcp:443 --source-ranges=0.0.0.0/0
gcloud compute firewall-rules create allow-jitsi-media \
  --allow=udp:10000 --source-ranges=0.0.0.0/0
```

(SSH/tcp:22 is already open via the default network's `default-allow-ssh`.)

### 6.2 Create the VM

```bash
gcloud compute instances create jitsi-vm \
  --zone=asia-south1-c \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB
```

`e2-standard-4` (4 vCPU / 16 GB) comfortably hosts small tumor-board meetings.
For pure cost saving with ≤5 participants you can drop to `e2-standard-2`.

Note the VM's external IP — it is your meeting URL for now:

```bash
gcloud compute instances describe jitsi-vm \
  --zone=asia-south1-c --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

### 6.3 DNS — skipped for now

We install Jitsi against the **raw VM IP** with a self-signed certificate, so
no DNS record is needed yet. When you're happy with the app, follow §6.7 to
switch to `meet.vmtb.in` properly.

### 6.4 Install Jitsi Meet on the VM

```bash
gcloud compute ssh jitsi-vm --zone=asia-south1-c
```

Then on the VM (replace `<VM_IP>` with the external IP from §6.2):

```bash
sudo apt update && sudo apt upgrade -y

curl https://download.jitsi.org/jitsi-key.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/jitsi-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/jitsi-keyring.gpg] https://download.jitsi.org/ stable/" | \
  sudo tee /etc/apt/sources.list.d/jitsi-stable.list
sudo apt update
sudo apt install -y jitsi-meet
```

During installation it prompts twice:
- **FQDN**: type the VM's external IP (e.g. `35.200.123.45`)
- **Certificate**: choose *"Generate a new self-signed certificate"* — fine
  for testing; browsers will show a one-time warning you accept.

Open `https://<VM_IP>` in a browser, click through the certificate warning
(Chrome: *Advanced → Proceed anyway*), and you should see the Jitsi welcome
page. Meetings already work at this point; transcription comes next.

> Accepting the warning once per browser is required **before** starting
> meetings from the app, because the meeting is embedded from this same IP.

### 6.5 Wire transcription to your proxy ← **the important part**

Four edits on the VM. Replace `<PROXY_URL>` with the value saved in §4
(e.g. `https://opus-transcriber-proxy-xxxxx-ey.a.run.app`).

**(a) Force-enable background transcription on every room (Prosody module)**

This makes transcription fully automatic: no one has to press the captions
button. Both server-side gates are forced on at room creation:

```bash
sudo tee /usr/share/jitsi-meet/prosody-plugins/mod_force_async_transcription.lua > /dev/null <<'EOF'
-- Forces background transcription on EVERY room, no UI action needed:
--   asyncTranscription=true            -> Jicofo transcribes without a client request
--   recording.isTranscribingEnabled=true -> satisfies the second (UI) gate
local util = module:require 'util';
local is_healthcheck_room = util.is_healthcheck_room;

module:hook('muc-room-created', function(event)
    local room = event.room;
    if is_healthcheck_room(room.jid) then return; end
    if not room.jitsiMetadata then room.jitsiMetadata = {}; end
    room.jitsiMetadata.asyncTranscription = true;
    if not room.jitsiMetadata.recording then room.jitsiMetadata.recording = {}; end
    room.jitsiMetadata.recording.isTranscribingEnabled = true;
    module:log('info', 'Forced background transcription for %s', room.jid);
end, -2); -- after mod_room_metadata_component (-1)
EOF
```

**(b) Enable the module on the conference component**

Edit `/etc/prosody/conf.avail/<VM_IP>.cfg.lua` (the file is named after the
FQDN you entered, i.e. the IP). Find the block starting with
`Component "conference.<VM_IP>" "muc"` and make sure its `modules_enabled`
list contains both entries:

```lua
Component "conference.<VM_IP>" "muc"
    ...
    modules_enabled = {
        "muc_meeting_id";           -- usually already present
        "force_async_transcription"; -- ADD THIS LINE
        ...
    }
```

**(c) Point Jicofo at the proxy**

Edit `/etc/jicofo/jicofo.conf` — add a `transcription` block inside the
top-level `jicofo { ... }` section:

```
jicofo {
  // ... existing config stays ...

  transcription {
    url-template = "wss://<PROXY_URL>/transcribe?sessionId={{MEETING_ID}}&sendBack=true"
    ping {
      enabled = true
      interval = 10 seconds
      timeout = 3 seconds
    }
  }
}
```

**(d) Enable the toggle in the client**

Edit `/etc/jitsi/meet/<VM_IP>-config.js` and add:

```js
transcription: {
    enabled: true,
},
```

**(e) Restart and verify**

```bash
sudo systemctl restart prosody jicofo
sudo systemctl status prosody jicofo nginx   # all should be active
```

Reference: <https://jitsi.github.io/handbook/docs/devops-guide/transcription/>

### 6.6 Check the activation backend can control this VM

From your laptop:

```bash
ACT_URL=<your activation backend URL>
curl -s "$ACT_URL/status" | python3 -m json.tool
# expect: jvb TERMINATED, stt cold, proxy cold

curl -s -X POST "$ACT_URL/start-jitsi"
# repeat every few seconds until ALL components say "ready"
# then tear back down:
curl -s -X POST "$ACT_URL/stop-jitsi"
```

If `jvb` shows `error`, re-check §2.3 IAM bindings and the activation
backend's Cloud Run logs.

### 6.7 Later: switching to `meet.vmtb.in` (custom domain)

Do this only after the app works to your satisfaction. Summary:

1. Add the DNS A record `meet → <VM_IP>` at your DNS provider and wait for
   propagation (`dig +short meet.vmtb.in`).
2. On the VM:
   ```bash
   sudo hostnamectl set-hostname meet.vmtb.in
   echo "127.0.0.1 meet.vmtb.in" | sudo tee -a /etc/hosts
   sudo /usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh
   ```
   If the cert script complains about the old self-signed config, re-run
   `sudo apt install -y jitsi-meet` and answer the FQDN prompt with
   `meet.vmtb.in` — it regenerates nginx/prosody/jicofo config for the new
   name (your §6.5 edits must then be re-applied to the *new* file names:
   `/etc/prosody/conf.avail/meet.vmtb.in.cfg.lua`,
   `/etc/jitsi/meet/meet.vmtb.in-config.js`).
3. Update `VITE_JITSI_DOMAIN=meet.vmtb.in` on Vercel (§7.2) and redeploy.
4. Ask me when you get here — we'll do it together.

---

## 7. Frontends from scratch (Render + Vercel)

Both frontends are static Vite builds served by their platforms' CDNs.

> **Branch warning:** everything we built lives on `feature/codebase-reorg`.
> Both platforms default to your repo's *default* branch (`main`) — make sure
> you point them at `feature/codebase-reorg` (steps below), or merge to `main`
> first. Switch them back to `main` after you eventually merge.

**Order matters** because the two URLs point at each other:

```
1. Create Render site      → its URL exists immediately (e.g. vmtb-main.onrender.com)
2. Create Vercel project   → uses the Render URL as VITE_MAIN_APP_URL
3. Loop back to Render     → set VITE_SERVER_LOADER_URL to the Vercel URL, redeploy
```

You will need ready: `<ACT_URL>` (§4), `<VM_IP>` (§6.2), Supabase URL + anon key.

---

### 7.1 Manual: main app on Render

**A. Account & access**

1. Go to <https://dashboard.render.com> → **Get Started** / sign in **with
   GitHub** (recommended — avoids extra password setup).
2. If asked, install the **Render GitHub App** and grant it access to your
   `vMTB-Veritas` repository (you can scope it to just this repo).

**B. Create the service**

3. Dashboard top-right: **New +** → **Static Site**.
4. Pick your `vMTB-Veritas` repository from the list → **Connect**.
5. Fill the creation form exactly:

   | Field | Value | Notes |
   |---|---|---|
   | Name | `vmtb-main` | URL becomes `https://vmtb-main.onrender.com` |
   | Project | *(leave empty)* | optional grouping |
   | Language/Framework | leave as detected / "Static Site" | |
   | Branch | `feature/codebase-reorg` | ← **not** `main` (see branch warning) |
   | Root Directory *(under Advanced)* | `main` | all paths below become relative to this |
   | Build Command | `npm ci && npm run build` | |
   | Publish Directory | `dist` | relative to Root Directory, so `main/dist` |

6. **Environment Variables** — click *Add more* for each row:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your Supabase URL (`https://xxxx.supabase.co`) |
   | `VITE_SUPABASE_ANON_KEY` | anon key (safe for browsers) |
   | `VITE_JITSI_BACKEND_URL` | `<ACT_URL>` from §4 |
   | `VITE_SERVER_LOADER_URL` | *(skip for now — added in §7.3)* |

   > These are **build-time** variables: changing them later requires a
   > redeploy (our Action button does that).

7. **SPA routing rule (required!)** — still in the form, find
   *Redirects/Rewrites* → *Add rule*:
   - Source: `/*`
   - Destination: `/index.html`
   - Action: **Rewrite** (NOT Redirect)
   
   Without this, refreshing any route other than `/` (e.g. `/my-cases`)
   returns 404.

8. Click **Create Static Site**. Watch the *Events* tab — first build takes
   ~2–4 min. When it says *Live*, open `https://vmtb-main.onrender.com`:
   you should see the vMTB login page. Log in with a real account to confirm
   Supabase connectivity. *(Google login won't work until step 9.)*

9. **Allow-list the site in Supabase (required for Google OAuth)** — Supabase
   redirects users back to whatever *Site URL* is configured there, **not**
   to wherever you deployed; unlisted origins silently fall back to that old
   Site URL. In Supabase Dashboard → **Authentication → URL Configuration**:
   - **Site URL**: `https://vmtb-main.onrender.com`
   - **Redirect URLs**: add `https://vmtb-main.onrender.com/**`; keep
     `http://localhost:5173/**` for dev; delete stale domains from previous
     deployments
   - Save — takes effect immediately, no redeploy needed.

**C. Wire up CI/CD**

10. Service page → **Settings** → scroll to **Deploy Hook** → copy the URL
    (looks like `https://api.render.com/deploy/srv-...?key=...`).
11. Add it as the GitHub secret `RENDER_DEPLOY_HOOK` (§2.7).

    From now on, **Actions → Deploy main app (Render)** triggers a fresh
    build. (Render also auto-deploys on every push to the branch by default;
    turn that off under Settings → Build & Deploy → Auto-Deploy if you want
    button-only.)

---

### 7.2 Manual: jitsi-frontend on Vercel

**A. Account & access**

1. Go to <https://vercel.com> → **Sign Up / Log in with GitHub**.
2. If asked, install the **Vercel GitHub App** for your repository.

**B. Create the project**

3. <https://vercel.com/new> → find `vMTB-Veritas` in the *Import Git
   Repository* list → **Import**.
4. On the *Configure Project* screen:

   | Field | Value | Notes |
   |---|---|---|
   | Project Name | `vmtb-jitsi` | URL becomes `https://vmtb-jitsi.vercel.app` |
   | Framework Preset | Vite | usually auto-detected |
   | Root Directory | `jitsi-frontend` | click **Edit** next to Root Directory → select → Continue |
   | Build Command / Output | leave as detected (`npm run build` / `dist`) | |

5. Expand **Environment Variables** and add each row (keep *Environment* =
   Production, Preview optional):

   | Name | Value |
   |---|---|
   | `VITE_JITSI_BACKEND_URL` | `<ACT_URL>` from §4 |
   | `VITE_JITSI_DOMAIN` | `<VM_IP>` from §6.2 *(switch to `meet.vmtb.in` later, §6.7)* |
   | `VITE_MAIN_APP_URL` | `https://vmtb-main.onrender.com` (from §7.1) |
   | `VITE_SUPABASE_URL` | your Supabase URL |
   | `VITE_SUPABASE_ANON_KEY` | anon key |

6. Click **Deploy** → wait ~1–2 min → *Congratulations!* → **Continue to
   Dashboard**. Note the production domain shown at the top
   (e.g. `https://vmtb-jitsi.vercel.app`).

**C. Point it at the right branch**

7. Project → **Settings** → **Git** → *Production Branch* → change to
   `feature/codebase-reorg` → **Save**.

**D. Wire up CI/CD**

8. Get the two IDs: project → **Settings** → **General** → scroll down —
   copy **Vercel Organization ID** and **Vercel Project ID**
   (alternative: run `npx vercel link` inside `jitsi-frontend/` locally and
   read `.vercel/project.json`).
9. Create a token: <https://vercel.com/account/settings/tokens> →
   **Add Token…** → scope *Full Account*, expiry e.g. 90 days → copy it
   immediately (shown only once). Calendar a reminder to rotate it.
10. Add three GitHub secrets (§2.7): `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
    `VERCEL_PROJECT_ID`.
11. Test the button: GitHub → **Actions → Deploy jitsi-frontend (Vercel)** →
    *Run workflow* → wait for the green check.

    (Vercel's git-integration also auto-deploys on push; disable under
    Settings → Git if you want button-only.)

**E. Sanity-check**

12. Open `https://vmtb-jitsi.vercel.app` directly (no query params) → you
    should see the friendly error page ("No room name provided…") — proves
    the app loads and builds correctly.

---

### 7.3 Loop back: point the main app at the loader

1. Render dashboard → `vmtb-main` → **Environment** → edit
   `VITE_SERVER_LOADER_URL` → set it to your Vercel production URL from
   §7.2 (e.g. `https://vmtb-jitsi.vercel.app`) → **Save Changes**.
2. Trigger **Actions → Deploy main app (Render)** — env var changes only
   apply after a rebuild.
3. **Allow-list the Vercel origin on the activation backend (required)** —
   the loader calls `/start-jitsi` straight from the browser, and the
   backend's CORS list doesn't include your new Vercel URL by default.
   Use an env-vars file — gcloud splits inline values on commas, which
   makes multi-origin lists painful to escape:
   ```bash
   cat > /tmp/cors.yaml <<'EOF'
   CORS_ORIGINS: "https://vmtb-jitsi.vercel.app,https://www.vmtb.in,https://server.vmtb.in,http://localhost:5173"
   EOF

   gcloud run services update jitsi-activation-backend \
     --project YOUR_PROJECT_ID --region asia-southeast1 \
     --env-vars-file /tmp/cors.yaml
   ```
   Takes effect on the next request. The deploy workflow merges env vars on
   redeploys, so this setting survives pressing the button again.

### 7.4 Final frontend checklist

- [ ] Render URL loads the login page and you can log in.
- [ ] Refreshing a deep link (e.g. `/my-cases`) does **not** 404 (SPA rule works).
- [ ] Vercel URL without params shows the friendly error page.
- [ ] Both deploy buttons in GitHub Actions complete with green checks.

---

## 8. End-to-end test

Do this exactly once, in order, and note anything that breaks.

1. **Cold state**
   `curl -s $ACT_URL/status | python3 -m json.tool`
   → jvb `TERMINATED`, stt `cold`, proxy `cold`.
2. **Accept the VM's self-signed cert once** — open `https://<VM_IP>` in the
   browser you'll test from and click through the warning (*Advanced →
   Proceed anyway*). Without this, the embedded meeting iframe fails silently.
3. **Start a meeting** — main app → MTB → *Meeting* → *Start Meeting*.
   It opens the Vercel loader, which polls `/start-jitsi`; expect **1–3 min**
   (VM boot + GPU alloc + model load) before the room opens.
4. **Talk** — join from a second device/tab if possible. Transcription starts
   **automatically** when the room is created (§6.5a forces both metadata
   gates), so nobody needs to press the captions button — captions are just
   an optional on-screen display.
   Check: proxy logs (Cloud Run → opus-transcriber-proxy → Logs) show
   `transcription session opened`.
5. **Segments land** — Supabase → Table Editor →
   `meeting_transcript_segments`: FINAL rows appear within seconds of speech.
6. **End the meeting** — leave/end for everyone. Within ~1 min:
   - `meeting_transcripts.status` → `COMPLETED`
   - `gs://vmtb-transcripts/meetings/<meeting_id>/transcript/transcript-v1.{json,txt}` exist
   - `minutes_of_meeting` column filled with Mistral JSON
     (summary / decisions / action_items).
7. **Tear down**
   `curl -X POST $ACT_URL/stop-jitsi` then confirm `/status` shows all
   stopped/cold. **Never skip this** — the warm GPU bills ~$0.80/hr.

Pipeline smoke test without a real meeting (dummy provider, no GPU):

```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("wss://PROXY_URL/transcribe?sessionId=smoke-room&provider=dummy");
ws.on("open", () => ws.send(JSON.stringify({event:"ping",id:1})));
ws.on("message", (m) => console.log(m.toString()));
'
```

---

## 9. Keeping costs near zero between meetings

The GPU STT service is **request-driven scale-to-zero**: no meetings → zero
instances → zero cost. The activation backend only *probes* services (which
starts a cold instance) and never patches min-instances — an earlier design
that set `min-instances=1` during meetings left an idle L4 resident for days
(~₹56/hr) and dominated the bill. Do not reintroduce scaling writes; if you
suspect a resident instance, check:

```bash
gcloud run services describe stt-service --project YOUR_PROJECT_ID \
  --region asia-southeast1 --format='value(spec.template.metadata.annotations)'
# run.googleapis.com/minScale must be absent or '0'
```

- GPU billing = entire instance lifetime (instance-based). A cold start adds
  ~1–2 min of billable time before the first word is transcribed — accepted.
- Orphan protection: the STT service closes WebSocket sessions after
  `STT_IDLE_TIMEOUT_SECONDS` (default 300s) of silence, so a crashed client
  cannot hold the GPU for the full request timeout.
- The Jitsi VM **stops itself now**: the transcript-worker fires
  `POST $ACT_URL/stop-jitsi` after every processed meeting, but only when no
  analytics session has heartbeated in the last 3 minutes (so it never kills a
  live or newer meeting). Requires the loader's Supabase analytics to be
  running — it is, automatically. Watch for `vm: /stop-jitsi fired
  successfully` in worker logs. The nightly scheduler below remains as an
  optional backup for days with zero processed meetings.
- ⚠️ Frequent VM stop/start cycles change its ephemeral external IP. While
  your meeting URL is an sslip.io hostname that IP is baked into the name —
  either reserve a static IP (~₹10/day, billed whenever attached *or* idle)
  or move to `meet.vmtb.in` (§6.7). Safety net if you skip this:
  ```bash
  gcloud scheduler jobs create http vmtb-nightly-stop \
    --location=asia-south1 \
    --schedule="30 18 * * *" --time-zone="Asia/Kolkata" \
    --uri="$ACT_URL/stop-jitsi" --http-method=POST
  ```
  (enable Cloud Scheduler API if prompted)
- Render static sites and Vercel hobby projects are free at this scale.
- Cost audit after any test session: Console → Cloud Run → stt-service →
  **Metrics** → `Billable instance time`. A 2-minute meeting should show
  ~3–5 minutes of billable time (cold start + meeting), not hours.
- Considering Mumbai for the STT service? See `docs/GPU_ACCESS_MUMBAI.md` —
  L4 there is invite-only and GPU pricing is identical across regions.

### Tuning the Jitsi VM itself

The default `e2-standard-4` (4 vCPU / 16 GB) is oversized for small boards.
With the VM **stopped**:

```bash
gcloud compute instances set-machine-type jitsi-vm \
  --zone=asia-south1-c --machine-type=e2-medium    # 2 vCPU/4GB, ~25% of the cost
# safer: --machine-type=e2-standard-2               # 2 vCPU/8GB
gcloud compute instances start jitsi-vm --zone=asia-south1-c
```

On `e2-medium`, cap the Java heaps (JVB ships a 3 GB heap by default):

```bash
sudo systemctl edit jitsi-videobridge2   # [Service] Environment="JAVA_TOOL_OPTIONS=-Xmx768m"
sudo systemctl edit jicofo               # [Service] Environment="JAVA_TOOL_OPTIONS=-Xmx384m"
sudo systemctl restart jitsi-videobridge2 jicofo && free -h
```

Notes:
- A stopped VM still bills its boot disk (~₹50/month for 20 GB) — everything
  else pauses. Disks can be grown but never shrunk.
- ⚠️ While the meeting URL is an sslip.io hostname (§6.3), stopping/starting
  the VM may change its ephemeral IP and break the hostname/cert/config trio.
  Either complete §6.7 (real domain) first, or update DNS + re-run
  `install-letsencrypt-cert.sh` after every IP change. A reserved static IP
  (~₹10/day) avoids the churn at a price.
- Undo: `set-machine-type … e2-standard-4` and remove the drop-ins with
  `sudo systemctl revert jitsi-videobridge2 jicofo`.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Build fails: `unrecognized arguments: --build-arg` | old workflow version — pull latest `feature/codebase-reorg` and re-run the button |
| Build "fails" with `This tool can only stream logs if you are Viewer/Owner` | old workflow version — the build itself may have succeeded (check Console → Cloud Build → History). Latest workflows poll status instead of streaming logs |
| Build fails: `storage.objects.get denied` on `<project>_cloudbuild` | Cloud Build's default SA lacks roles — run the "Cloud Build's default service account" block in §2.3, then re-run the button |
| Build fails pushing to Artifact Registry (`denied` on docker.pkg.dev) | same block in §2.3 (artifactregistry.writer missing for the build SA) |
| STT deploy fails: GPU zonal-redundancy quota error | old workflow version — latest adds `--no-gpu-zonal-redundancy`; pull and re-run |
| STT deploy fails: container failed to start on PORT=8080 | old image — the Dockerfile now listens on `$PORT`; re-run the button so a fresh build deploys |
| STT deploy fails: GPU quota error | §2.5 quota not granted yet, or wrong region |
| Meeting stuck on loader ("Server starting…") | `curl $ACT_URL/status` → see which component isn't ready; check that service's Cloud Run logs |
| `/start-jitsi` components show `error` | IAM bindings from §2.3 missing; check activation backend logs |
| Proxy logs: STT connect failures (403) | `STT_USE_ID_TOKEN=true` missing on proxy, or `vmtb-services` lacks `roles/run.invoker` |
| No captions / nothing in proxy logs | §6.5 wiring wrong: jicofo.conf template, prosody module not loaded (`systemctl status prosody`), or client toggle off |
| Segments never appear in Supabase | proxy secrets wrong (`supabase-url` / `supabase-service-role-key`); check proxy logs for store errors |
| Worker never runs; status stuck PENDING | push subscription broken — rerun the transcript-worker workflow (it repairs it) |
| Worker wiring step fails with `unrecognized arguments: --push-auth-token` | old workflow version — latest wires the subscription via OIDC only (`--push-auth-service-account`); pull and re-run |
| Worker wiring step fails with `User not authorized` (subscriptions) | CI deployer lacks Pub/Sub rights — grant `roles/pubsub.editor` to `vmtb-deployer@…` (§2.3), re-run the button |
| Meeting FAILED with LLM error | bad/expired Mistral key → fix `llm-api-key` secret, redeploy worker |
| WebSocket drops at exactly 60 min | Cloud Run hard cap; proxy/STT reconnect automatically — acceptable for MVP |
| CORS error in browser console | add frontend origin to `CORS_ORIGINS` env of activation backend (§7.3 step 3), redeploy |
| Loader shows "Network error (CORS or server down)" when starting a meeting | same as above — your Vercel origin is missing from the activation backend's `CORS_ORIGINS` |
| Meeting iframe blank / external_api.js fails to load | the self-signed cert wasn't accepted in that browser yet — visit `https://<VM_IP>` directly and proceed past the warning (§8 step 2) |
| Google OAuth lands on an old/wrong domain | Supabase **Site URL / Redirect URLs** still point there — fix per §7.1 step 9 |
| Render site 404s on refresh / deep links | missing SPA rewrite rule `/* → /index.html` (§7.1 step 4) |
| Frontend shows old backend URLs after env change | `VITE_*` vars bake at build time — trigger the deploy button again |
| Vercel workflow fails auth | wrong/expired `VERCEL_TOKEN`, or org/project ids swapped |
| Render hook returns non-200 | `RENDER_DEPLOY_HOOK` secret stale — re-copy from Render settings |
| Let's Encrypt fails later (§6.7) | DNS not propagated yet, or port 80 blocked (§6.1) |
