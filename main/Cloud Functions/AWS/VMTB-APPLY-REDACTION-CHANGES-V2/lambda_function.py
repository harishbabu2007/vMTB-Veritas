"""
VMTB-APPLY-REDACTION-CHANGES-V2 — the pipeline run "materializer".

Every document edit a case owner makes (redaction adds/removes, document
removals, uploads, "Your data") is committed to Postgres first, in one
transaction, by the commit_case_edits() RPC, which records a
case_pipeline_runs row. This Lambda is then invoked (asynchronously, via
VMTB-TRIGGER-APPLY-REDACTION-CHANGES-V2) with just that run's id, and makes
S3 match what the database says:

  1. Removals: every document marked deleted whose file is still live in S3
     is renamed with the DELETE_ prefix.
  2. Redactions: every document whose redaction rows changed after its latest
     published version is re-rendered from the retained originals plus the
     currently active regions, and published with an S3 conditional write
     (redaction_core.write_document_version).
  3. Next stage: runs with new uploads hand off to the conversion pipeline
     (which anonymizes the new files and re-summarizes); other runs trigger
     summarization directly.

It works from the database's CURRENT state, not from its own request, so it
is safe to run twice, and it doesn't matter if runs are delivered out of
order: whichever executes sees every save committed so far. It checks that
its run is still current before each document and stops quietly when a newer
save has superseded it — the newer run does the work. Failures are recorded
on the run (pipeline_fail), which the user sees with a Retry.

Expected event: {"body": "{\"run_id\": \"<uuid>\"}"} (or the dict directly).
See main/supabase/migrations/20260918_case_pipeline_runs.sql.
"""
import json
import os
import urllib.request
from datetime import datetime

import boto3
from supabase import create_client, Client

import redaction_core
from redaction_core import RunSuperseded

S3_BUCKET = "vmtb-bedrock-qwen-bucket-v2"
ANONYMIZED_PREFIX = "ANO_NNCMFAGSSS_22246_"

# /extract (VMTB-EXTRACT-SUMMARIZE-V2) and /trigger-converter-files-to-png
# (200-OK-V2 -> VMTB-CONVERT-DOC2PNG-V2). Both run far longer than the 5s we
# wait here; like every other hop in this pipeline, the request is sent and
# the response deliberately not awaited.
EXTRACT_API_URL = os.environ.get("EXTRACT_API_URL")
CONVERTER_TRIGGER_URL = os.environ.get(
    "CONVERTER_TRIGGER_URL",
    "https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/trigger-converter-files-to-png",
)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

s3 = boto3.client("s3")

supabase: Client = None
if SUPABASE_URL and SUPABASE_ANON_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] WARNING: Failed to initialize Supabase client: {str(e)}")


def log(msg):
    print(f"[{datetime.utcnow().isoformat()}] {msg}")


def fire_and_forget(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass  # the downstream Lambda keeps running; its outcome is recorded on the run


def apply_removals(case_id, request_id):
    rows = (
        supabase.table("case_documents")
        .select("id, document_name, file_name")
        .eq("case_id", case_id)
        .not_.is_("deleted_at", "null")
        .is_("deleted_s3_key", "null")
        .execute()
    ).data or []
    live_names = {
        r["document_name"]
        for r in (
            supabase.table("case_documents").select("document_name").eq("case_id", case_id).is_("deleted_at", "null").execute()
        ).data or []
    }
    for row in rows:
        if row["document_name"] in live_names:
            # Removed and then re-added under the same name before this ran:
            # the file in storage now belongs to the new document. Leave it.
            supabase.table("case_documents").update({"deleted_s3_key": "(superseded by re-added document)"}).eq("id", row["id"]).execute()
            log(f"• '{row['document_name']}' was re-added after removal — keeping the new file")
            continue
        renamed = []
        # The finished anonymized file, and the raw upload if it was never converted.
        for filename in {f"{ANONYMIZED_PREFIX}{row['document_name']}.pdf", row["file_name"]}:
            new_key = redaction_core.soft_delete_data_file(s3, S3_BUCKET, request_id, filename)
            if new_key:
                renamed.append(new_key)
        supabase.table("case_documents").update(
            {"deleted_s3_key": renamed[0] if renamed else "(not in storage)"}
        ).eq("id", row["id"]).execute()
        log(f"✓ Removed '{row['document_name']}' ({', '.join(renamed) or 'no live file'})")
    return len(rows)


def documents_needing_regeneration(case_id):
    """Live documents whose redactions changed after their latest published version."""
    changes = (
        supabase.table("case_document_redactions")
        .select("document_name, created_generation, removed_generation")
        .eq("case_id", case_id)
        .or_("created_generation.not.is.null,removed_generation.not.is.null")
        .execute()
    ).data or []
    last_change = {}
    for r in changes:
        g = max(r.get("created_generation") or 0, r.get("removed_generation") or 0)
        last_change[r["document_name"]] = max(last_change.get(r["document_name"], 0), g)

    versions = (
        supabase.table("case_document_versions").select("document_name, generation").eq("case_id", case_id).execute()
    ).data or []
    last_published = {}
    for v in versions:
        last_published[v["document_name"]] = max(last_published.get(v["document_name"], 0), v.get("generation") or 0)

    deleted = redaction_core.deleted_document_names(supabase, case_id)
    return sorted(
        name for name, g in last_change.items()
        if g > last_published.get(name, 0) and name not in deleted
    )


def lambda_handler(event, context):
    log("=" * 80)
    log("APPLY (MATERIALIZE) STARTED")

    body = event.get("body") if isinstance(event, dict) and "body" in event else event
    body = json.loads(body) if isinstance(body, str) else (body or {})
    run_id = body.get("run_id")
    if not run_id:
        return {"statusCode": 400, "body": json.dumps({"error": "run_id is required"})}
    if not supabase:
        log("ERROR: Supabase client not initialized (SUPABASE_URL/SUPABASE_ANON_KEY missing?)")
        return {"statusCode": 500, "body": json.dumps({"error": "Supabase client not initialized"})}

    run = redaction_core.pipeline_begin(supabase, run_id)
    if not run:
        log(f"Run {run_id} not found")
        return {"statusCode": 404, "body": json.dumps({"error": "run not found"})}
    if not run.get("current"):
        log(f"Run {run_id} is {run.get('status')} / no longer current — nothing to do")
        return {"statusCode": 200, "body": json.dumps({"status": run.get("status")})}

    case_id, request_id, generation = run["case_id"], run["request_id"], run["generation"]
    log(f"run={run_id} kind={run['kind']} case={case_id} generation={generation} uploads={run['has_uploads']}")

    try:
        if not run["materialize_done"]:
            removed = apply_removals(case_id, request_id)

            to_regenerate = documents_needing_regeneration(case_id)
            log(f"Documents to regenerate: {to_regenerate or 'none'}")
            for name in to_regenerate:
                redaction_core.ensure_current(supabase, run_id)
                redaction_core.write_document_version(
                    s3, S3_BUCKET, supabase, case_id, request_id, name,
                    render=lambda name=name: redaction_core.regenerate_document_pdf(
                        s3, S3_BUCKET, supabase, case_id, request_id, name),
                    generation=generation,
                    anonymized_prefix=ANONYMIZED_PREFIX,
                    is_current=lambda: redaction_core.pipeline_is_current(supabase, run_id),
                    created_by=run.get("created_by"),
                    log=log,
                )

            if not redaction_core.pipeline_mark_step(supabase, run_id, "materialize"):
                raise RunSuperseded()
            log(f"✓ Materialized: {removed} removal(s), {len(to_regenerate)} regenerated document(s)")

        next_payload = {"run_id": run_id, "request_id": request_id, "case_id": case_id}
        if run["has_uploads"] and not run["anonymize_done"]:
            # The conversion pipeline anonymizes the new files and summarizes.
            fire_and_forget(CONVERTER_TRIGGER_URL, {**next_payload, "upload_files": run["upload_files"]})
            log("→ Handed off to conversion (new uploads)")
        elif not run["summary_done"]:
            if not EXTRACT_API_URL:
                raise RuntimeError("EXTRACT_API_URL is not configured")
            fire_and_forget(EXTRACT_API_URL, next_payload)
            log("→ Triggered summarization")

        return {"statusCode": 200, "body": json.dumps({"status": "materialized"})}

    except RunSuperseded:
        log(f"Run {run_id} was superseded by a newer save — stopping")
        return {"statusCode": 200, "body": json.dumps({"status": "superseded"})}
    except Exception as e:
        import traceback
        log(f"FATAL: {e}")
        log(traceback.format_exc())
        redaction_core.pipeline_fail(
            supabase, run_id, "APPLY_FAILED",
            f"Your document changes couldn't be applied: {str(e)[:300]}", log=log,
        )
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
