"""
Shared redaction drawing/merging/versioning logic for the manual
anonymization editor feature.

Canonical source of this file. It is duplicated verbatim into each Lambda
folder that needs it (VMTB-OCR2ANO-V2, VMTB-APPLY-REDACTION-CHANGES-V2,
VMTB-EXTRACT-SUMMARIZE-V2)
because those are container-image (ECR) Lambdas built independently, each
with its own Dockerfile `COPY . .`-style build context scoped to its own
folder — there is no existing build tooling in this repo that assembles a
shared context across sibling Lambda folders, so introducing one here
risked silently breaking deployability. If a real shared-layer/build-context
mechanism gets added later, this duplication can be collapsed. Until then:
**any change here must be copied into every one of those folders.**
"""
import io
import re
import uuid

from PIL import Image, ImageDraw, ImageFilter

VALID_STYLES = ("blur", "whiteout", "blackout")
DEFAULT_BLUR_RADIUS = 25


def extract_page_number(name):
    """Extract the integer page number from 'page_3.png' etc. Defaults to 0."""
    match = re.search(r"page_(\d+)", name)
    return int(match.group(1)) if match else 0


def clamp01(value):
    """Clamp a number into the inclusive [0.0, 1.0] range."""
    return max(0.0, min(1.0, value))


def normalized_bbox_to_pixel_bbox(bbox_normalized, image_width, image_height):
    """
    Convert a {x0,y0,x1,y1} box in normalized 0..1 coordinates (top-left
    origin, x right, y down) into a pixel-space [x0,y0,x1,y1] list against
    the given image dimensions. Same convention (and same defensiveness) as
    VMTB-OCR2ANO-V2's pre-existing visual-PII coordinate math: clamps
    out-of-range values, corrects reversed coordinates, and rejects
    degenerate (zero-area) boxes by returning None. Callers must always pass
    the ACTUAL dimensions of the image being drawn on right now — never
    whatever resolution the region was originally drawn against — which is
    the entire point of storing normalized coordinates in the first place.
    """
    try:
        x0 = clamp01(float(bbox_normalized["x0"]))
        y0 = clamp01(float(bbox_normalized["y0"]))
        x1 = clamp01(float(bbox_normalized["x1"]))
        y1 = clamp01(float(bbox_normalized["y1"]))
    except (TypeError, ValueError, KeyError):
        return None

    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    if x1 <= x0 or y1 <= y0:
        return None

    px0 = max(0, min(image_width, round(x0 * image_width)))
    px1 = max(0, min(image_width, round(x1 * image_width)))
    py0 = max(0, min(image_height, round(y0 * image_height)))
    py1 = max(0, min(image_height, round(y1 * image_height)))

    if px1 <= px0 or py1 <= py0:
        return None

    return [px0, py0, px1, py1]


def apply_redaction(image, bbox_normalized, style="whiteout", blur_radius=DEFAULT_BLUR_RADIUS):
    """
    Draw one redaction region directly onto `image` (mutated in place) and
    return it, for chaining. `bbox_normalized` is a {x0,y0,x1,y1} dict in the
    [0,1] range, converted here against `image`'s actual current dimensions.
    Unknown styles fall back to whiteout. A degenerate/invalid bbox is a
    silent no-op, matching the existing visual-PII code's fail-open
    philosophy — one bad region must never abort an entire regeneration.
    """
    pixel_bbox = normalized_bbox_to_pixel_bbox(bbox_normalized, image.width, image.height)
    if pixel_bbox is None:
        return image
    x0, y0, x1, y1 = pixel_bbox

    if style == "blur":
        region = image.crop((x0, y0, x1, y1))
        blurred = region.filter(ImageFilter.GaussianBlur(blur_radius))
        image.paste(blurred, (x0, y0))
    elif style == "blackout":
        ImageDraw.Draw(image).rectangle([x0, y0, x1, y1], fill="black")
    else:
        ImageDraw.Draw(image).rectangle([x0, y0, x1, y1], fill="white")

    return image


def apply_active_redactions(image, redactions):
    """
    Apply every redaction in `redactions` (rows from case_document_redactions,
    each with a normalized `bbox` dict {x0,y0,x1,y1} and a `style`) to
    `image`, in order, and return it. Callers must pre-filter to only the
    regions that belong to the page `image` represents and are currently
    active.
    """
    for r in redactions:
        apply_redaction(image, r["bbox"], style=r.get("style", "whiteout"))
    return image


def merge_pages_to_pdf(page_images):
    """
    Merge an ordered list of PIL Images (one per page, already redacted) into
    a single in-memory multi-page PDF. Returns a seek(0)'d BytesIO buffer.
    """
    if not page_images:
        raise ValueError("merge_pages_to_pdf: page_images must be non-empty")

    pdf_buf = io.BytesIO()
    page_images[0].save(
        pdf_buf,
        format="PDF",
        save_all=True,
        append_images=page_images[1:] if len(page_images) > 1 else [],
    )
    pdf_buf.seek(0)
    return pdf_buf


def item_name_from_document_name(document_name, anonymized_prefix):
    """
    Strip the ANONYMIZED_PREFIX and .pdf extension from a filename as
    returned by VMTB-GET-REPORTS (e.g. 'ANO_NNCMFAGSSS_22246_SomeDoc.pdf')
    to recover the bare item_name used as the DB `document_name` value and
    for locating S3 objects under the originals/ and versions/ prefixes.
    """
    name = document_name
    if name.startswith(anonymized_prefix):
        name = name[len(anonymized_prefix):]
    if name.lower().endswith(".pdf"):
        name = name[:-4]
    return name


def list_original_pages(s3_client, bucket, request_id, item_name):
    """List retained unredacted page PNGs for a document, in page order."""
    prefix = f"uploads/{request_id}/originals/{item_name}/"
    resp = s3_client.list_objects_v2(Bucket=bucket, Prefix=prefix)
    names = [
        obj["Key"].split("/")[-1]
        for obj in resp.get("Contents", [])
        if obj["Key"].lower().endswith(".png")
    ]
    names.sort(key=extract_page_number)
    return names


def regenerate_document_pdf(s3_client, bucket, supabase_client, case_id, request_id, item_name):
    """
    Rebuild a document's PDF from scratch: every retained unredacted
    original page, redrawn with whatever redactions are currently active in
    Supabase. There is no incremental patching of a previous PDF — always a
    full redraw from the pristine source, which is what makes both "add a
    redaction" and "remove a redaction" correct and idempotent regardless of
    how many edits came before.

    Raises if no retained originals exist (document predates this feature,
    or its retention window already expired) — callers should surface this
    as a clear error rather than silently producing an unredacted PDF.
    """
    page_files = list_original_pages(s3_client, bucket, request_id, item_name)
    if not page_files:
        raise RuntimeError(
            f"No retained unredacted originals found for '{item_name}' — "
            f"either this document predates the manual anonymization editor, "
            f"or its retention window has expired."
        )

    active = fetch_active_redactions(supabase_client, case_id, request_id, item_name)
    by_page = {}
    for r in active:
        by_page.setdefault(r["page_number"], []).append(r)

    images = []
    for page_file in page_files:
        page_num = extract_page_number(page_file)
        key = f"uploads/{request_id}/originals/{item_name}/{page_file}"
        obj = s3_client.get_object(Bucket=bucket, Key=key)
        image = Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")
        apply_active_redactions(image, by_page.get(page_num, []))
        images.append(image)

    return merge_pages_to_pdf(images)


ORIGINALS_RETENTION_DAYS = 30


def upsert_originals_retention(supabase_client, case_id, request_id, document_name, log=print):
    """
    Stamp/reset the "originals retained since" clock for a document. Called
    every time VMTB-OCR2ANO-V2 actually writes fresh originals to
    uploads/{request_id}/originals/ — both a document's first anonymization
    and any later full reprocess (Reports.tsx's "Save All" edit flow),
    since a reprocess resets the S3 object's age and this must track that,
    not just record the very first pass. Mirrors (and must stay in sync
    with, in days) the S3 Lifecycle Rule on that prefix — see
    ORIGINALS_RETENTION_DAYS and docs/DOCUMENT_AI_PIPELINE.md.
    """
    try:
        supabase_client.table("case_document_retention").upsert({
            "case_id": case_id,
            "request_id": request_id,
            "document_name": document_name,
            "originals_retained_at": datetime_now_iso(),
        }, on_conflict="case_id,document_name").execute()
    except Exception as e:
        log(f"WARNING: failed to upsert originals retention for '{document_name}': {str(e)}")


def datetime_now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def insert_redaction_records(supabase_client, records, log=print):
    """
    Bulk-insert rows into case_document_redactions. Never raises — a failure
    to persist redaction metadata must not break the underlying anonymization
    or regeneration work that already succeeded.
    """
    if not records:
        return
    try:
        supabase_client.table("case_document_redactions").insert(records).execute()
    except Exception as e:
        log(f"WARNING: failed to persist {len(records)} redaction record(s): {str(e)}")


# ============================================================================
# Pipeline runs — see main/supabase/migrations/20260918_case_pipeline_runs.sql
# ============================================================================
#
# A user's save is committed to Postgres (commit_case_edits) before any Lambda
# runs; Lambdas get only a run id. They rebuild from the database's CURRENT
# state, and every result they write back goes through a pipeline_* function
# that applies it only while the run's generation is still current.


class RunSuperseded(Exception):
    """A newer save replaced this run. Stop quietly: the newer run does the work."""


def _rpc(supabase_client, name, params):
    return supabase_client.rpc(name, params).execute().data


def pipeline_begin(supabase_client, run_id):
    """Claim a run (pending -> running). Returns the run + {current, request_id}, or None."""
    return _rpc(supabase_client, "pipeline_begin", {"p_run_id": run_id})


def pipeline_is_current(supabase_client, run_id):
    return bool(_rpc(supabase_client, "pipeline_is_current", {"p_run_id": run_id}))


def ensure_current(supabase_client, run_id):
    if not pipeline_is_current(supabase_client, run_id):
        raise RunSuperseded()


def pipeline_mark_step(supabase_client, run_id, step):
    """step: 'materialize' | 'summary'. False if the run is no longer current."""
    return bool(_rpc(supabase_client, "pipeline_mark_step", {"p_run_id": run_id, "p_step": step}))


def pipeline_fail(supabase_client, run_id, error_code, message, log=print):
    """Record a failure the user will see (with Retry). Never raises."""
    try:
        return bool(_rpc(supabase_client, "pipeline_fail", {
            "p_run_id": run_id, "p_error_code": error_code, "p_error": message,
        }))
    except Exception as e:
        log(f"WARNING: could not record failure for run {run_id}: {e}")
        return False


DELETE_PREFIX = "DELETE_NNCMFAGSSS_22246_"


def _is_missing(err):
    return getattr(err, "response", {}).get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound")


def _is_precondition_failure(err):
    response = getattr(err, "response", {})
    return (
        response.get("ResponseMetadata", {}).get("HTTPStatusCode") in (409, 412)
        or response.get("Error", {}).get("Code") in ("PreconditionFailed", "ConditionalRequestConflict")
    )


def soft_delete_data_file(s3_client, bucket, request_id, filename):
    """
    Soft-delete one file under uploads/{request_id}/data/ by renaming it with
    DELETE_PREFIX (every listing skips that prefix). Idempotent: returns the
    new key, or None if the file isn't there (already renamed, never
    converted, or never uploaded).
    """
    old_key = f"uploads/{request_id}/data/{filename}"
    new_key = f"uploads/{request_id}/data/{DELETE_PREFIX}{filename}"
    try:
        s3_client.head_object(Bucket=bucket, Key=old_key)
    except Exception as e:
        if _is_missing(e):
            return None
        raise
    s3_client.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": old_key}, Key=new_key)
    s3_client.delete_object(Bucket=bucket, Key=old_key)
    return new_key


def deleted_document_names(supabase_client, case_id):
    """
    document_name of every document that is removed from the case NOW:
    it has removed rows and no live row. A name can have both — removed and
    later re-added with the same file name — and must then count as live,
    or the re-added document would be skipped by anonymization and left out
    of the summary. (Removals are committed in the DB before S3 is touched.)
    """
    resp = (
        supabase_client.table("case_documents")
        .select("document_name, deleted_at")
        .eq("case_id", case_id)
        .execute()
    )
    removed, live = set(), set()
    for r in resp.data or []:
        name = r.get("document_name")
        if not name:
            continue
        (removed if r.get("deleted_at") else live).add(name)
    return removed - live


def current_generation(supabase_client, case_id):
    resp = supabase_client.table("cases").select("content_generation").eq("id", case_id).execute()
    rows = resp.data or []
    return rows[0]["content_generation"] if rows else None


def fetch_active_redactions(supabase_client, case_id, request_id, document_name):
    """Return all currently-active redaction rows for a document, across all pages."""
    resp = (
        supabase_client.table("case_document_redactions")
        .select("*")
        .eq("case_id", case_id)
        .eq("request_id", request_id)
        .eq("document_name", document_name)
        .eq("is_active", True)
        .execute()
    )
    return resp.data or []


def deactivate_all_redactions(supabase_client, case_id, request_id, document_name, log=print):
    """
    Deactivate every currently-active redaction for a document without
    touching their audit fields (no removed_by — this isn't a user removing
    one region, it's the automated pipeline re-processing the document from
    scratch). Called before a fresh (re-)run of VMTB-OCR2ANO-V2's automated
    detection for a document that already has redaction history: the old
    rows describe regions against page content that a full reprocess just
    regenerated from scratch, so they no longer describe anything real.
    """
    try:
        supabase_client.table("case_document_redactions").update({
            "is_active": False,
        }).eq("case_id", case_id).eq("request_id", request_id) \
          .eq("document_name", document_name).eq("is_active", True).execute()
    except Exception as e:
        log(f"WARNING: failed to deactivate prior redactions for '{document_name}': {str(e)}")


def _insert_version_row(supabase_client, case_id, request_id, document_name, s3_key,
                        generation, created_by=None, redaction_id=None):
    """Insert the next version number; retry if a concurrent writer took it."""
    for _ in range(5):
        resp = (
            supabase_client.table("case_document_versions")
            .select("version")
            .eq("case_id", case_id)
            .eq("document_name", document_name)
            .order("version", desc=True)
            .limit(1)
            .execute()
        )
        version = ((resp.data or [{}])[0].get("version") or 0) + 1
        try:
            supabase_client.table("case_document_versions").insert({
                "case_id": case_id,
                "request_id": request_id,
                "document_name": document_name,
                "version": version,
                "s3_key": s3_key,
                "generation": generation,
                "redaction_id": redaction_id,
                "created_by": created_by,
            }).execute()
            return version
        except Exception as e:
            if "23505" not in str(e):  # unique_violation: someone took this number
                raise
    raise RuntimeError(f"Couldn't record a new version of '{document_name}'.")


def _preserve_replaced_versions(s3_client, bucket, supabase_client, case_id, document_name,
                                canonical_key, etag, request_id):
    """
    Version rows written before per-version files existed point at the
    canonical data/ key, which is about to be overwritten. Copy exactly the
    content we're replacing (CopySourceIfMatch) to its own key first, so
    older versions stay viewable (MTB members see the last verified one).
    Returns False if the canonical file changed since `etag` was read.
    """
    rows = (
        supabase_client.table("case_document_versions")
        .select("id, version")
        .eq("case_id", case_id)
        .eq("document_name", document_name)
        .eq("s3_key", canonical_key)
        .execute()
    ).data or []
    for row in rows:
        archive_key = f"uploads/{request_id}/versions/{document_name}/v{row['version']}-{uuid.uuid4().hex[:12]}.pdf"
        try:
            s3_client.copy_object(
                Bucket=bucket,
                CopySource={"Bucket": bucket, "Key": canonical_key},
                CopySourceIfMatch=etag,
                Key=archive_key,
            )
        except Exception as e:
            if _is_precondition_failure(e):
                return False
            raise
        updated = (
            supabase_client.table("case_document_versions")
            .update({"s3_key": archive_key})
            .eq("id", row["id"])
            .eq("s3_key", canonical_key)
            .execute()
        ).data
        if not updated:  # a concurrent writer preserved it first
            s3_client.delete_object(Bucket=bucket, Key=archive_key)
    return True


def write_document_version(s3_client, bucket, supabase_client, case_id, request_id, document_name,
                           render, generation, anonymized_prefix, is_current=None,
                           created_by=None, redaction_id=None, log=print, max_attempts=3):
    """
    Publish a freshly rendered anonymized PDF as the document's current file
    (uploads/{request_id}/data/<prefix><name>.pdf) plus an immutable copy for
    its version row — without an older render ever overwriting a newer one.

    render()     -> BytesIO. Called again on every attempt, so a retry redraws
                    from the database's current redactions.
    is_current() -> bool. Checked just before publishing; a superseded run
                    raises RunSuperseded and leaves the write to the newer run.

    The canonical file is written with an S3 conditional write: If-Match the
    ETag read before rendering (If-None-Match for a first write). If anything
    wrote it in between, S3 answers 412 and we re-read, re-render and retry.
    Because rendering always reads the latest committed redactions, whichever
    write lands last was rendered from state at least as new as any earlier one.
    """
    canonical_key = f"uploads/{request_id}/data/{anonymized_prefix}{document_name}.pdf"
    for attempt in range(1, max_attempts + 1):
        try:
            etag = s3_client.head_object(Bucket=bucket, Key=canonical_key)["ETag"]
        except Exception as e:
            if not _is_missing(e):
                raise
            etag = None

        body = render().getvalue()
        if is_current is not None and not is_current():
            raise RunSuperseded()
        if etag and not _preserve_replaced_versions(
            s3_client, bucket, supabase_client, case_id, document_name, canonical_key, etag, request_id
        ):
            log(f"  '{document_name}' changed while rendering (attempt {attempt}) — retrying")
            continue

        version_key = f"uploads/{request_id}/versions/{document_name}/g{generation}-{uuid.uuid4().hex[:12]}.pdf"
        s3_client.put_object(Bucket=bucket, Key=version_key, Body=body, ContentType="application/pdf")
        condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
        try:
            s3_client.put_object(Bucket=bucket, Key=canonical_key, Body=body,
                                 ContentType="application/pdf", **condition)
        except Exception as e:
            s3_client.delete_object(Bucket=bucket, Key=version_key)
            if _is_precondition_failure(e):
                log(f"  '{document_name}' was written by another run (attempt {attempt}) — retrying")
                continue
            raise

        version = _insert_version_row(supabase_client, case_id, request_id, document_name, version_key,
                                      generation, created_by=created_by, redaction_id=redaction_id)
        log(f"  ✓ Published '{document_name}' version {version} (generation {generation})")
        return version

    raise RuntimeError(f"'{document_name}' kept changing while it was being written ({max_attempts} attempts).")


def fetch_additional_data(supabase_client, case_id, log=print):
    """
    Best-effort fetch of the free-text "additional clinical data" the case
    owner may have attached via Reports.tsx's additional-document flow
    (case_additional_documents.document_data). A re-summarize should
    reproduce what the original pipeline run would have produced, which
    means including this if it was there — silently dropping it would make
    a "successful" re-summarize quietly worse than the summary it replaces.
    """
    try:
        resp = (
            supabase_client.table("case_additional_documents")
            .select("document_data")
            .eq("case_id", case_id)
            .maybe_single()
            .execute()
        )
        # supabase-py returns None (not a response with data=None) from
        # maybe_single() when no row matches — the old `resp.data` access
        # raised on every case without additional data, logged as a warning.
        if resp is None:
            return ""
        return (resp.data or {}).get("document_data") or ""
    except Exception as e:
        log(f"WARNING: failed to fetch additional data for case {case_id}: {str(e)}")
        return ""
