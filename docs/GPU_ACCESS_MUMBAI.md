# Getting NVIDIA L4 Cloud Run GPUs in `asia-south1` (Mumbai)

> **Status: not yet executed.** This is a standing runbook, not a record of
> what happened. Confirmed as of this writing: `stt-service` and
> `opus-transcriber-proxy` are still deployed in `asia-southeast1`
> (Singapore) — see `docs/CLOUD_INVENTORY.md`. Nothing below has been
> carried out; treat every step as forward-looking until someone actually
> runs it and updates this line.

`asia-south1` is a supported Cloud Run L4 region but Google gates it
**by invitation** — the quota console will not let most projects request >0.
This document is the beginner-proof procedure for finding out whether you can
get access, requesting it if possible, and migrating `stt-service` if granted.

> **Honest expectation-setting:** community reports (Google Dev forums, 2025)
> show personal/education accounts often get stuck: the console says
> "contact Sales", Sales declines non-business accounts and suggests paid
> support. If your project belongs to an organisation (IIT Jodhpur in our
> case), route the request through whoever owns the GCP organisation/billing
> account — that path works far more often.

---

## 1. Check whether the project already has access

```bash
# Does a deployment into asia-south1 succeed at the API level?
gcloud run deploy mumbai-l4-probe \
  --project vmtb-new --region asia-south1 \
  --image=asia-southeast1-docker.pkg.dev/vmtb-new/vmtb-services/stt-service:latest \
  --gpu 1 --gpu-type nvidia-l4 --no-gpu-zonal-redundancy \
  --memory 16Gi --cpu 4 --concurrency 1 --max-instances 1 \
  --min-instances 0 --timeout 900 \
  --no-allow-unauthenticated \
  --service-account vmtb-services@vmtb-new.iam.gserviceaccount.com
```

- **Succeeds?** You already have access — skip to §6.
- Fails with *"GPU is not available in region"* / *"invitation only"* / quota
  error → continue to §2.

Delete the failed attempt's leftovers (it usually creates nothing on failure):

```bash
gcloud run services delete mumbai-l4-probe --project vmtb-new --region asia-south1 --quiet
```

## 2. Check GPU quota for asia-south1

Console: **IAM & Admin → Quotas & System Limits** → filter
`NVIDIA L4` / metric name contains `AllocPerProjectRegion`, scope
`asia-south1`. Look for:

| Metric name | Meaning |
|---|---|
| `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` | GPUs usable without zonal redundancy (our setup) |
| `NvidiaL4GpuAllocPerProjectRegion` | GPUs with zonal redundancy (pricier) |

CLI equivalent:

```bash
gcloud beta services list --enabled --project vmtb-new   # sanity
gcloud compute regions describe asia-south1 --project vmtb-new \
  --format='value(quotas.metric[], quotas.name)' | grep -i gpu || true
```

If the value is **0** and the *Edit* pencil is disabled with a
"contact sales" note → invitation gate confirmed.

## 3. Request the quota (if the console allows it)

Quotas page → row from §2 → **Edit** → set to `1` → submit. Approval can take
days. If the console blocks you → §4.

## 4. Requesting the invitation (the realistic path)

Gather this information first — Google will ask for all of it:

1. Organisation name & website (e.g. Indian Institute of Technology Jodhpur)
2. GCP **project ID**: `vmtb-new`, and billing account ID
3. Region requested: `asia-south1`, GPU: `nvidia-l4`, quantity: `1`
4. Use case, 2–3 sentences: *"Real-time medical speech transcription for a
   virtual Molecular Tumor Board used by clinicians in India. Workload is
   sporadic (tens of meeting-hours/month); scale-to-zero; data must remain
   in-country for patient-privacy reasons."*
5. Expected monthly usage (~60 GPU-hours) and why Singapore is unacceptable
   (data-residency / latency for Indian clinicians)
6. Contact details of the billing/organisation owner

Submission channels, best first:

1. If the billing account has an assigned **Google account team** (Billing →
   Account management), email them directly.
2. Otherwise: <https://cloud.google.com/contact> → "Talk to sales", explicitly
   stating it is an **organisation-backed project** requesting
   `asia-south1` L4 allow-listing for Cloud Run.
3. Your Google Cloud partner/reseller, if one exists.

## 5. Verify access once granted

Repeat §1 — the deploy should now be accepted. Confirm quota shows ≥1.

## 6. Test with a minimal real service

The probe service from §1 *is* the test. Once deployed successfully:

```bash
# invoke /health once through an authenticated request
URL=$(gcloud run services describe mumbai-l4-probe \
  --project vmtb-new --region asia-south1 --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" "$URL/health"    # expect {"status":"ok"}
```

Then delete it (a warm GPU bills ~₹56/hr even idle!):

```bash
gcloud run services delete mumbai-l4-probe --project vmtb-new --region asia-south1 --quiet
```

## 7. Migrate stt-service to Mumbai

Use the existing GitHub button: **Actions → Deploy stt-service → Run workflow
→ set the `region` input to `asia-south1`**. The workflow already accepts a
region override. Same image, same env, new region.

## 8. Re-wire opus-transcriber-proxy

Press **Deploy opus-transcriber-proxy** → set the `stt_region` input to
`asia-south1`. The workflow fetches the STT URL from that region and updates
`STT_WS_URL` automatically.

## 9. Verify end-to-end connectivity

1. `POST $ACT_URL/start-jitsi` until all components report ready
   (the activation backend reads URLs by service name + its own configured
   region — update its `GCP_REGION` env to `asia-south1` **only if you move
   the other services too**; STT-only migration needs no change because the
   proxy holds the STT URL).
2. Join a meeting, enable transcription, speak.
3. Proxy logs: `stt: fetched id token…` then finals flowing.
4. Latency check: speech-to-caption delay should be similar or slightly lower
   than via Singapore.

## 10. Decommission Singapore safely

Only after a full successful Mumbai meeting:

```bash
# keep the image/tag history, remove only the running service
gcloud run services delete stt-service \
  --project vmtb-new --region asia-southeast1 --quiet
```

Rollback = re-run the Deploy stt-service workflow with region
`asia-southeast1` + re-run proxy deploy with `stt_region=asia-southeast1`.

## Cost notes (official pricing, Aug 2026)

| Item | Singapore (Tier 2) | Mumbai (Tier 1) |
|---|---|---|
| vCPU-second | $0.000018 | $0.000011244 |
| GiB-second | $0.000002 | $0.000001235 |
| **L4 GPU-second (no zonal redundancy)** | **$0.0001867** | **$0.0001867 — identical** |

GPU pricing is **not** region-tiered. At ~60 meeting-hours/month the move
saves roughly ₹600–700/month (CPU+RAM only). The dominant GPU line item is
unchanged, so treat this migration as latency/data-residency driven, not cost
driven.
