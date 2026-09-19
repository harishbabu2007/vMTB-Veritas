import json
import io
import re
import os
import boto3
from datetime import datetime, timezone
from PIL import Image, ImageDraw
from concurrent.futures import ThreadPoolExecutor, as_completed
from supabase import create_client, Client

import redaction_core

# =========================
# CONFIG
# =========================
AWS_REGION = "ap-south-1"
MODEL_ID = "qwen.qwen3-235b-a22b-2507-v1:0"
S3_BUCKET = "vmtb-bedrock-qwen-bucket-v2"
ANONYMIZED_PREFIX = "ANO_NNCMFAGSSS_22246_"

# Phase 3: visual/non-text PII detection (logos, signatures, stamps, QR/barcodes,
# photographs, handwritten identifiers, patient labels). See
# PHASE3_VISUAL_ANONYMIZATION.md in this directory for the full design writeup.
VISION_MODEL_ID = "qwen.qwen3-vl-235b-a22b"
VISUAL_PII_CONFIDENCE_THRESHOLD = 0.7
VISION_MAX_LONG_EDGE = 1600  # px, provisional — see PHASE3_VISUAL_ANONYMIZATION.md
VISION_JPEG_QUALITY = 90
VISUAL_PII_CATEGORIES = {
    "logo", "hospital_logo", "hospital_name_visual", "signature", "stamp",
    "qr_code", "barcode", "photograph", "handwritten_identifier", "patient_label",
}
PROMPT_PREFIX = "prompts/"
VISUAL_PII_PROMPT_FILE = "visual_pii_prompt.txt"

# Supabase config
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

# =========================
# CLIENTS
# =========================
s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)


def load_prompt_from_s3(filename):
    """Load a prompt text file from the shared prompts/ prefix in S3."""
    response = s3.get_object(Bucket=S3_BUCKET, Key=f"{PROMPT_PREFIX}{filename}")
    return response["Body"].read().decode("utf-8")


# Loaded at cold start, same convention as the sibling VMTB-EXTRACT-SUMMARIZE-V2
# Lambda. Deliberately non-fatal on failure (unlike that sibling): if the S3
# object is briefly unavailable, the EXISTING text-PII pipeline must keep
# working — only the new visual-detection call degrades (see
# call_vision_pii_detector, which checks for None and skips cleanly). This
# also keeps the module importable without live AWS credentials, e.g. for
# the unit tests in test_visual_pii.py.
try:
    VISUAL_PII_PROMPT = load_prompt_from_s3(VISUAL_PII_PROMPT_FILE)
except Exception as e:
    VISUAL_PII_PROMPT = None
    print(f"[{datetime.utcnow().isoformat()}] WARNING: Failed to load {VISUAL_PII_PROMPT_FILE} "
          f"from S3 — visual PII detection will be skipped: {str(e)}")

# Initialize Supabase client
supabase: Client = None
if SUPABASE_URL and SUPABASE_ANON_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        print(f"[{datetime.utcnow().isoformat()}] Supabase client initialized successfully")
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] WARNING: Failed to initialize Supabase client: {str(e)}")

# Manual anonymization editor (case_document_redactions/_versions/_retention)
# writes through this SAME anon-key client, not a separate service-role one
# — RLS is deliberately left off on those 3 tables for now (this feature has
# no real users yet); see docs/LEGACY_AND_KNOWN_ISSUES.md and
# main/supabase/migrations_deferred/ for the tracked follow-up that will
# require switching this to a real service-role client once RLS is enabled.

# =========================
# LOGGING
# =========================
def log(msg):
    print(f"[{datetime.utcnow().isoformat()}] {msg}")

# =========================
# SUPABASE UPDATE
# =========================
def update_report_status(request_id, status="unverified"):
    """
    Update report_status in Supabase cases table
    """
    if not supabase:
        log("ERROR: Supabase client not initialized")
        raise Exception("Supabase client not initialized. Check environment variables.")
    
    try:
        log(f"Updating Supabase: request_id={request_id}, report_status={status}")
        
        response = supabase.table("cases").update({
            "report_status": status
        }).eq("request_id", request_id).execute()
        
        if response.data:
            log(f"✓ Supabase updated successfully for request_id: {request_id}")
            return True
        else:
            log(f"WARNING: No rows updated in Supabase for request_id: {request_id}")
            return False
            
    except Exception as e:
        log(f"ERROR: Supabase update failed: {str(e)}")
        raise


def get_case_id_for_request(request_id):
    """
    Resolve the owning case's id from request_id, for tagging
    case_document_redactions/case_document_versions rows. Uses the existing
    anon-key client (RLS is not enabled on `cases`, so this read already
    works today via the blanket grant). Returns None on any failure —
    callers must treat that as "skip persistence for this run", not fatal.
    """
    if not supabase:
        return None
    try:
        resp = supabase.table("cases").select("id").eq("request_id", request_id).single().execute()
        return resp.data["id"] if resp.data else None
    except Exception as e:
        log(f"WARNING: Failed to resolve case_id for request_id={request_id}: {str(e)}")
        return None

# =========================
# HELPER: CHECK IF FOLDER IS ALREADY ANONYMIZED
# =========================
def is_already_anonymized(folder_name):
    """
    Check if folder name contains ANONYMIZED_PREFIX anywhere in the name (continuously)
    Returns True if already anonymized, False otherwise
    """
    return ANONYMIZED_PREFIX in folder_name

# =========================
# HELPER: CHECK IF IT'S A FILE (NOT A FOLDER)
# =========================
def is_existing_file(doc_name):
    """
    Check if the document name represents an existing file (e.g., ends with .pdf)
    Returns True if it's a file, False if it's a folder
    """
    # Check if it has a file extension like .pdf, .doc, .docx, etc.
    return doc_name.lower().endswith(('.pdf', '.doc', '.docx', '.txt', '.jpg', '.jpeg', '.png'))

# =========================
# HELPER: GET FOLDER NAME FOR OCR MATCHING
# =========================
def get_ocr_matching_name(folder_name):
    """
    Remove .pdf extension from folder name to match with OCR document keys
    OCR keys don't have .pdf extension
    """
    # Remove .pdf extension if present
    if folder_name.lower().endswith('.pdf'):
        return folder_name[:-4]
    return folder_name

# =========================
# HELPER: DELETE FOLDER FROM S3
# =========================
def delete_s3_folder(request_id, folder_name):
    """
    Delete an entire folder (all contents) from S3
    """
    folder_prefix = f"uploads/{request_id}/data/{folder_name}/"
    log(f"  Deleting folder from S3: {folder_prefix}")
    
    try:
        # List all objects in the folder
        continuation_token = None
        delete_count = 0
        
        while True:
            if continuation_token:
                response = s3.list_objects_v2(
                    Bucket=S3_BUCKET,
                    Prefix=folder_prefix,
                    ContinuationToken=continuation_token
                )
            else:
                response = s3.list_objects_v2(
                    Bucket=S3_BUCKET,
                    Prefix=folder_prefix
                )
            
            if 'Contents' in response:
                # Delete objects in batches
                objects_to_delete = [{'Key': obj['Key']} for obj in response['Contents']]
                
                if objects_to_delete:
                    s3.delete_objects(
                        Bucket=S3_BUCKET,
                        Delete={'Objects': objects_to_delete}
                    )
                    delete_count += len(objects_to_delete)
            
            # Check if there are more objects to list
            if response.get('IsTruncated'):
                continuation_token = response.get('NextContinuationToken')
            else:
                break
        
        log(f"  ✓ Deleted folder with {delete_count} objects")
        return True
    except Exception as e:
        log(f"  ERROR: Failed to delete folder: {str(e)}")
        return False

# =========================
# HELPER: RETAIN UNREDACTED ORIGINALS (manual anonymization editor)
# =========================
ORIGINALS_RETENTION_TAG_KEY = "ManualRedactionOriginal"
ORIGINALS_RETENTION_TAG_VALUE = "true"


def copy_pages_to_originals(request_id, item_name, page_filenames):
    """
    Copy each unredacted page PNG to uploads/{request_id}/originals/{item_name}/
    BEFORE it gets redacted and its data/ copy is deleted below. This is what
    makes "remove a redaction" possible later — without it, redaction stays
    fully destructive. Never presigned/exposed to the browser; only read back
    by VMTB-APPLY-REDACTION-CHANGES-V2 (via VMTB-GET-ORIGINALS-V2 for the
    editor UI itself).

    Retention here is intentionally bounded operationally, not in code — an
    S3 Lifecycle Rule expires these after a fixed window (see
    docs/DOCUMENT_AI_PIPELINE.md). That rule is keyed on the
    ManualRedactionOriginal=true object TAG applied below, not on key
    prefix — S3 Lifecycle Rules only match a literal prefix, and
    uploads/{request_id}/originals/ has a different request_id in the
    middle of the path for every upload, so no single prefix can match all
    of them. Best-effort: a failed copy is logged, not fatal, since the
    primary anonymization pipeline must keep working even if retention
    degrades for one page.
    """
    for page_filename in page_filenames:
        src_key = f"uploads/{request_id}/data/{item_name}/{page_filename}"
        dst_key = f"uploads/{request_id}/originals/{item_name}/{page_filename}"
        try:
            s3.copy_object(
                Bucket=S3_BUCKET,
                CopySource={"Bucket": S3_BUCKET, "Key": src_key},
                Key=dst_key,
                Tagging=f"{ORIGINALS_RETENTION_TAG_KEY}={ORIGINALS_RETENTION_TAG_VALUE}",
                TaggingDirective="REPLACE",
            )
        except Exception as e:
            log(f"  WARNING: Failed to retain unredacted original for {page_filename}: {str(e)}")

# =========================
# HELPER: LIST FOLDERS IN S3 DATA DIRECTORY
# =========================
def list_folders_in_data(request_id):
    """
    List all folders (and files) in the data directory
    Returns: list of folder/file names
    """
    prefix = f"uploads/{request_id}/data/"
    log(f"Listing contents in: s3://{S3_BUCKET}/{prefix}")
    
    try:
        response = s3.list_objects_v2(
            Bucket=S3_BUCKET,
            Prefix=prefix,
            Delimiter='/'
        )
        
        folders = []
        
        # Get folders (CommonPrefixes)
        if 'CommonPrefixes' in response:
            for prefix_obj in response['CommonPrefixes']:
                folder_path = prefix_obj['Prefix']
                # Extract folder name (remove prefix and trailing slash)
                folder_name = folder_path.replace(prefix, '').rstrip('/')
                folders.append(folder_name)
        
        # Get files in root data directory
        if 'Contents' in response:
            for obj in response['Contents']:
                file_path = obj['Key']
                # Skip the directory itself
                if file_path == prefix:
                    continue
                # Extract file name
                file_name = file_path.replace(prefix, '')
                # Only add if it's a direct child (no slashes)
                if '/' not in file_name:
                    folders.append(file_name)
        
        log(f"Found {len(folders)} items in data directory: {folders}")
        return folders
        
    except Exception as e:
        log(f"ERROR: Failed to list folders: {str(e)}")
        return []

# =========================
# LLM CALL WITH ROBUST ERROR HANDLING
# =========================
def call_llm(entities, max_retries=2):
    """
    Call Qwen model to identify PII in OCR text
    entities: [{id, text}]
    Returns: list of PII detections
    """
    if not entities:
        return []
    
    numbered_text = "\n".join(f"{e['id']}. {e['text']}" for e in entities)

    prompt = f"""You are a medical document privacy classifier.

Below is OCR text extracted from a single page. Each line has a number.

Rules:
- Identify ONLY PII (names, IDs, doctor names, hospitals, addresses, phone, email, URLs)
- DO NOT mark clinical information as PII (age, gender, diseases, medications, symptoms, treatments, test results, dates)

Return ONLY valid JSON array. No explanations.

Format:
[
  {{"id": 1, "pii_type": "FULL"}},
  {{"id": 2, "pii_type": "PARTIAL", "substrings": ["exact text"]}}
]

If no PII found, return: []

Text:
{numbered_text}
"""

    for attempt in range(max_retries):
        try:
            response = bedrock.converse(
                modelId=MODEL_ID,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={
                    "temperature": 0.1,
                    "maxTokens": 2048,
                    "topP": 0.9
                }
            )
            
            raw_text = response["output"]["message"]["content"][0]["text"].strip()
            
            # Clean markdown wrappers
            if raw_text.startswith("```"):
                raw_text = re.sub(r"```(?:json)?\s*\n?", "", raw_text)
                raw_text = re.sub(r"\n?```\s*$", "", raw_text)
            
            raw_text = raw_text.strip()
            
            # Try to parse JSON
            try:
                result = json.loads(raw_text)
                
                if not isinstance(result, list):
                    log(f"    WARNING: LLM returned non-list (attempt {attempt + 1})")
                    if attempt < max_retries - 1:
                        continue
                    return []
                
                # Validate each item
                validated = []
                for item in result:
                    if isinstance(item, dict) and "id" in item and "pii_type" in item:
                        validated.append(item)
                
                return validated
                
            except json.JSONDecodeError as e:
                log(f"    JSON parse error (attempt {attempt + 1}): {str(e)}")
                log(f"    Raw response preview: {raw_text[:200]}...")
                
                # Try to fix common JSON issues
                fixed_text = fix_json_string(raw_text)
                if fixed_text != raw_text:
                    try:
                        result = json.loads(fixed_text)
                        if isinstance(result, list):
                            log(f"    Successfully fixed JSON!")
                            return result
                    except:
                        pass
                
                if attempt < max_retries - 1:
                    continue
                else:
                    log(f"    All parse attempts failed")
                    return []
        
        except Exception as e:
            log(f"    LLM API error (attempt {attempt + 1}): {str(e)}")
            if attempt < max_retries - 1:
                continue
            else:
                return []
    
    return []

def fix_json_string(text):
    """Attempt to fix common JSON issues"""
    # Remove trailing commas
    text = re.sub(r',\s*}', '}', text)
    text = re.sub(r',\s*]', ']', text)
    
    # Try to find JSON array boundaries
    start = text.find('[')
    end = text.rfind(']')
    
    if start != -1 and end != -1 and end > start:
        text = text[start:end+1]
    
    return text

# =========================
# VISUAL PII DETECTION (Phase 3)
# =========================
def clamp01(value):
    """Clamp a number into the inclusive [0.0, 1.0] range."""
    return max(0.0, min(1.0, value))


def normalized_bbox_to_pixels(bbox_normalized, image_width, image_height):
    """
    Convert a [x1, y1, x2, y2] box in normalized 0..1 coordinates (top-left
    origin, x right, y down) into a pixel-space [x1, y1, x2, y2] box against
    the given image dimensions.

    Defensive by design: clamps out-of-range values, corrects reversed
    coordinates, and rejects degenerate (zero-area) boxes by returning None.
    This is the function responsible for coordinate correctness end-to-end —
    it must be called with the ORIGINAL full-resolution image's width/height,
    never the (possibly resized) dimensions of whatever was sent to the
    vision model.
    """
    if not bbox_normalized or len(bbox_normalized) != 4:
        return None

    try:
        x1, y1, x2, y2 = (float(v) for v in bbox_normalized)
    except (TypeError, ValueError):
        return None

    x1, y1, x2, y2 = clamp01(x1), clamp01(y1), clamp01(x2), clamp01(y2)

    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1

    if x2 <= x1 or y2 <= y1:
        return None

    px1 = round(x1 * image_width)
    py1 = round(y1 * image_height)
    px2 = round(x2 * image_width)
    py2 = round(y2 * image_height)

    # Second defensive clamp, against the actual pixel bounds this time.
    px1 = max(0, min(image_width, px1))
    px2 = max(0, min(image_width, px2))
    py1 = max(0, min(image_height, py1))
    py2 = max(0, min(image_height, py2))

    if px2 <= px1 or py2 <= py1:
        return None

    return [px1, py1, px2, py2]


def parse_and_validate_visual_json(raw_text, allowed_categories=VISUAL_PII_CATEGORIES):
    """
    Parse the vision model's JSON array response, repairing common issues via
    the existing fix_json_string() helper, and drop any item that isn't a
    well-formed detection (unknown category, missing/invalid confidence or
    bbox_normalized). Never raises — returns [] on unrecoverable input.
    """
    if not raw_text:
        return []

    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    text = text.strip()

    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        fixed = fix_json_string(text)
        try:
            result = json.loads(fixed)
        except json.JSONDecodeError:
            return []

    if not isinstance(result, list):
        return []

    validated = []
    for item in result:
        if not isinstance(item, dict):
            continue

        category = item.get("category")
        if category not in allowed_categories:
            continue

        try:
            confidence = clamp01(float(item.get("confidence", 0.0)))
        except (TypeError, ValueError):
            continue

        bbox_normalized = item.get("bbox_normalized")
        if not isinstance(bbox_normalized, (list, tuple)) or len(bbox_normalized) != 4:
            continue

        validated.append({
            "category": category,
            "confidence": confidence,
            "bbox_normalized": list(bbox_normalized),
        })

    return validated


def encode_image_for_vision(image, max_long_edge=VISION_MAX_LONG_EDGE, jpeg_quality=VISION_JPEG_QUALITY):
    """
    Encode a (possibly downsized) copy of the page image as JPEG bytes for
    the Bedrock vision call. Never upscales. Operates on a copy — the caller's
    original `image` object (already loaded for drawing) is never mutated.
    """
    long_edge = max(image.width, image.height)
    scale = min(1.0, max_long_edge / long_edge) if long_edge else 1.0

    to_encode = image
    if scale < 1.0:
        new_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        to_encode = image.resize(new_size, Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    to_encode.convert("RGB").save(buf, format="JPEG", quality=jpeg_quality)
    return buf.getvalue()


def call_vision_pii_detector(image, max_retries=2):
    """
    Send the page image to the vision-capable Bedrock model and return a
    validated list of {category, confidence, bbox_normalized} visual PII
    detections. Fails open (returns []) on any error, exhausted retries, or
    unparseable response — a vision-call outage must never break a page's
    redaction, matching this Lambda's existing failure philosophy for call_llm.
    """
    if not VISUAL_PII_PROMPT:
        log("    WARNING: Visual PII prompt not loaded — skipping visual detection for this page")
        return []

    try:
        image_bytes = encode_image_for_vision(image)
    except Exception as e:
        log(f"    WARNING: Failed to encode image for vision call: {str(e)}")
        return []

    for attempt in range(max_retries):
        try:
            response = bedrock.converse(
                modelId=VISION_MODEL_ID,
                messages=[{
                    "role": "user",
                    "content": [
                        {"image": {"format": "jpeg", "source": {"bytes": image_bytes}}},
                        {"text": VISUAL_PII_PROMPT},
                    ],
                }],
                inferenceConfig={
                    "temperature": 0.1,
                    "maxTokens": 2048,
                    "topP": 0.9
                }
            )

            raw_text = response["output"]["message"]["content"][0]["text"].strip()
            return parse_and_validate_visual_json(raw_text)

        except Exception as e:
            log(f"    Vision PII API error (attempt {attempt + 1}): {str(e)}")
            if attempt < max_retries - 1:
                continue
            return []

    return []


# =========================
# CHUNKED LLM PROCESSING
# =========================
def call_llm_chunked(entities, chunk_size=30):
    """
    Process entities in chunks to avoid token limits and malformed JSON
    """
    all_results = []
    
    for i in range(0, len(entities), chunk_size):
        chunk = entities[i:i + chunk_size]
        log(f"    Processing entities {i+1}-{min(i+chunk_size, len(entities))} of {len(entities)}")
        
        chunk_results = call_llm(chunk)
        all_results.extend(chunk_results)
    
    return all_results

# =========================
# PARALLEL PAGE PROCESSING (WITH ANONYMIZATION)
# =========================
def process_single_page_with_anonymization(request_id, doc_name, page_name, entities, page_index, total_pages):
    """
    Process a single page: call LLM (text PII) and the vision model (visual
    PII) concurrently, then anonymize both.
    Returns: (anonymized_image, pii_count, visual_pii_count, page_name, redaction_records)
    """
    log(f"  [{page_index}/{total_pages}] Processing page: {page_name} ({len(entities)} entities)")

    # Add .png extension to page_name for S3 path
    page_file_name = f"{page_name}.png"
    page_key = f"uploads/{request_id}/data/{doc_name}/{page_file_name}"

    # Load image from S3
    try:
        image_obj = s3.get_object(Bucket=S3_BUCKET, Key=page_key)
        image_bytes = image_obj["Body"].read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        draw = ImageDraw.Draw(image)
        log(f"    Image loaded: {image.size[0]}x{image.size[1]} pixels")
    except Exception as e:
        log(f"    ERROR loading image from s3://{S3_BUCKET}/{page_key}: {str(e)}")
        # Use blank image as fallback
        image = Image.new("RGB", (1000, 1000), "white")
        draw = ImageDraw.Draw(image)

    llm_input = [{"id": e["id"], "text": e["text"]} for e in entities]

    # Run the text-PII call and the visual-PII call concurrently. Neither
    # touches `image`'s pixels (no drawing) until both have resolved below.
    with ThreadPoolExecutor(max_workers=2) as detector_executor:
        text_future = detector_executor.submit(
            lambda: (
                call_llm_chunked(llm_input, chunk_size=30)
                if len(llm_input) > 40 else call_llm(llm_input)
            ) if llm_input else []
        )
        visual_future = detector_executor.submit(call_vision_pii_detector, image)

        if len(llm_input) > 40:
            log(f"    Using chunked processing for {len(llm_input)} entities")

        try:
            pii_results = text_future.result()
        except Exception as e:
            log(f"    ERROR: text PII detection failed: {str(e)}")
            pii_results = []

        try:
            visual_results = visual_future.result()
        except Exception as e:
            log(f"    ERROR: visual PII detection failed: {str(e)}")
            visual_results = []

    log(f"    Found {len(pii_results)} text PII entities, {len(visual_results)} visual PII candidates")

    # Map id -> OCR entity
    entity_map = {e["id"]: e for e in entities}

    # Records for case_document_redactions (manual anonymization editor) —
    # one per rectangle actually drawn, so the editor can later show/undo
    # exactly what this Lambda did.
    page_number = extract_page_number(page_name)
    image_width, image_height = image.width, image.height
    redaction_records = []

    def record(bbox, source, category=None, confidence=None, already_normalized=False):
        """
        Persist one redaction as a case_document_redactions row. Text-PII
        bboxes arrive in pixel space (from OCR polygon math) and are
        normalized here against this page's own dimensions; visual-PII
        bboxes are already normalized (det["bbox_normalized"]) and are
        passed straight through via already_normalized=True — same
        normalized-coordinate convention the manual anonymization editor
        uses everywhere else, so a redraw never depends on matching
        resolutions between where a box was detected and where it's applied.
        """
        if already_normalized:
            x0, y0, x1, y1 = bbox
        else:
            x0, y0, x1, y1 = (
                bbox[0] / image_width, bbox[1] / image_height,
                bbox[2] / image_width, bbox[3] / image_height,
            )
        redaction_records.append({
            "request_id": request_id,
            "document_name": doc_name,
            "page_number": page_number,
            "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
            "category": category,
            "confidence": confidence,
            "style": "whiteout",
            "source": source,
        })

    # Anonymize detected text PII
    anonymized_count = 0
    for pii in pii_results:
        entity = entity_map.get(pii["id"])
        if not entity:
            log(f"    WARNING: PII id {pii['id']} not found in entities")
            continue

        bbox = polygon_to_bbox(entity["bbox"])

        if pii["pii_type"] == "FULL":
            draw.rectangle(bbox, fill="white")
            record(bbox, source="automated_text")
            anonymized_count += 1

        elif pii["pii_type"] == "PARTIAL":
            for sub in pii.get("substrings", []):
                try:
                    sub_bbox = compute_partial_bbox(
                        entity["text"], sub, bbox
                    )
                    draw.rectangle(sub_bbox, fill="white")
                    record(sub_bbox, source="automated_text")
                    anonymized_count += 1
                except Exception as e:
                    log(f"    WARNING: Partial bbox failed for '{sub}': {str(e)}")

    if anonymized_count > 0:
        log(f"    ✓ Anonymized {anonymized_count} text regions on this page")
    else:
        log(f"    ✓ No text anonymization needed for this page")

    # Anonymize detected visual PII (Phase 3)
    visual_anonymized_count = 0
    for det in visual_results:
        if det["confidence"] < VISUAL_PII_CONFIDENCE_THRESHOLD:
            log(f"    DISCARDED (below threshold {VISUAL_PII_CONFIDENCE_THRESHOLD}): "
                f"category={det['category']} confidence={det['confidence']:.2f} "
                f"bbox_normalized={det['bbox_normalized']}")
            continue

        pixel_bbox = normalized_bbox_to_pixels(det["bbox_normalized"], image.width, image.height)
        if pixel_bbox is None:
            log(f"    WARNING: invalid bbox for category={det['category']}, skipping")
            continue

        draw.rectangle(pixel_bbox, fill="white")
        record(det["bbox_normalized"], source="automated_visual", category=det["category"],
               confidence=det["confidence"], already_normalized=True)
        visual_anonymized_count += 1
        log(f"    Redacted visual PII: category={det['category']} "
            f"confidence={det['confidence']:.2f} bbox_px={pixel_bbox}")

    if visual_anonymized_count > 0:
        log(f"    ✓ Anonymized {visual_anonymized_count} visual regions on this page")
    else:
        log(f"    ✓ No visual anonymization needed for this page")

    return (image, len(pii_results), visual_anonymized_count, page_name, redaction_records)

# =========================
# PARALLEL PAGE PROCESSING (WITHOUT ANONYMIZATION - JUST LOAD)
# =========================
def process_single_page_without_anonymization(request_id, doc_name, page_file_name, page_index, total_pages):
    """
    Process a single page: just load the image without any LLM calls or anonymization
    page_file_name should already include .png extension
    Returns: (image, 0, page_file_name)
    """
    log(f"  [{page_index}/{total_pages}] Loading page: {page_file_name} (already anonymized, skipping LLM)")
    
    page_key = f"uploads/{request_id}/data/{doc_name}/{page_file_name}"
    
    # Load image from S3
    try:
        image_obj = s3.get_object(Bucket=S3_BUCKET, Key=page_key)
        image_bytes = image_obj["Body"].read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        log(f"    Image loaded: {image.size[0]}x{image.size[1]} pixels")
    except Exception as e:
        log(f"    ERROR loading image from s3://{S3_BUCKET}/{page_key}: {str(e)}")
        # Use blank image as fallback
        image = Image.new("RGB", (1000, 1000), "white")
    
    return (image, 0, page_file_name)

# =========================
# HELPER: LIST PNG FILES IN FOLDER
# =========================
def list_png_files_in_folder(request_id, folder_name):
    """
    List all PNG files in a specific folder
    Returns: sorted list of PNG filenames
    """
    folder_prefix = f"uploads/{request_id}/data/{folder_name}/"
    
    try:
        response = s3.list_objects_v2(
            Bucket=S3_BUCKET,
            Prefix=folder_prefix
        )
        
        png_files = []
        if 'Contents' in response:
            for obj in response['Contents']:
                file_path = obj['Key']
                file_name = file_path.replace(folder_prefix, '')
                if file_name.lower().endswith('.png'):
                    png_files.append(file_name)
        
        # Sort by page number
        png_files.sort(key=extract_page_number)
        
        log(f"  Found {len(png_files)} PNG files in folder '{folder_name}'")
        return png_files
        
    except Exception as e:
        log(f"  ERROR listing PNG files: {str(e)}")
        return []

# =========================
# GEOMETRY HELPERS
# =========================
def polygon_to_bbox(poly):
    """Convert polygon to bounding box [x1, y1, x2, y2]"""
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return [min(xs), min(ys), max(xs), max(ys)]

def compute_partial_bbox(full_text, substring, bbox):
    """Calculate bbox for a substring within full text"""
    if substring not in full_text:
        return bbox
    
    x1, y1, x2, y2 = bbox
    total_chars = max(len(full_text), 1)
    char_width = (x2 - x1) / total_chars

    start = full_text.index(substring)
    end = start + len(substring)

    return [
        int(x1 + start * char_width),
        y1,
        int(x1 + end * char_width),
        y2
    ]

# =========================
# PAGE SORTING
# =========================
def extract_page_number(page_name):
    """
    Extract page number from 'page_0.png', 'page_1.png', etc.
    Returns integer for sorting
    """
    match = re.search(r'page_(\d+)', page_name)
    if match:
        return int(match.group(1))
    return 0

# =========================
# MAIN HANDLER
# =========================
def lambda_handler(event, context):
    log("=" * 80)
    log("ANONYMIZATION LAMBDA STARTED")
    log("=" * 80)
    
    try:
        # Get request_id
        body = json.loads(event["body"])

        request_id = body["request_id"]
        if not request_id:
            log("ERROR: Missing request_id in event")
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Missing request_id"})
            }
        
        log(f"Request ID: {request_id}")

        # Resolved once per request for tagging case_document_redactions /
        # case_document_versions rows (manual anonymization editor feature).
        # None is a valid outcome (e.g. case_id lookup fails) — persistence
        # is best-effort and must never block the core anonymization work.
        case_id = get_case_id_for_request(request_id)
        if not case_id:
            log("WARNING: Could not resolve case_id for this request — redaction/version persistence will be skipped")

        # Pipeline runs (20260918_case_pipeline_runs.sql): remember when this
        # pass started (it completes the anonymize step of every upload run
        # committed before then), the generation it's working for, and which
        # documents the owner has removed — those are skipped even if their
        # pages are still sitting in data/.
        started_at = datetime.now(timezone.utc).isoformat()
        generation = 0
        removed_documents = set()
        if case_id and supabase:
            try:
                generation = redaction_core.current_generation(supabase, case_id) or 0
                removed_documents = redaction_core.deleted_document_names(supabase, case_id)
            except Exception as e:
                log(f"WARNING: couldn't read pipeline state: {e}")

        # Load OCR results
        ocr_key = f"uploads/{request_id}/results/ocr_full.json"
        log(f"Loading OCR results from: s3://{S3_BUCKET}/{ocr_key}")
        
        try:
            ocr_obj = s3.get_object(Bucket=S3_BUCKET, Key=ocr_key)
            ocr_data = json.loads(ocr_obj["Body"].read())
        except Exception as e:
            log(f"ERROR: Failed to load OCR results: {str(e)}")
            raise
        
        ocr_documents = ocr_data.get("documents", {})
        log(f"OCR contains {len(ocr_documents)} documents")
        log(f"OCR document keys: {list(ocr_documents.keys())}")

        # List actual folders/files in S3 data directory
        data_items = list_folders_in_data(request_id)
        
        if not data_items:
            log("WARNING: No folders or files found in data directory")
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "message": "No folders or files to process",
                    "request_id": request_id
                })
            }

        documents_processed = 0
        total_pages_processed = 0
        total_pii_found = 0
        total_visual_pii_found = 0
        files_skipped = 0

        # Process EACH item in data directory
        for item_index, item_name in enumerate(data_items, 1):
            log("-" * 80)
            log(f"[{item_index}/{len(data_items)}] Processing item: '{item_name}'")
            item_redaction_records = []
            
            # =========================
            # SKIP EXISTING FILES (ONLY PROCESS FOLDERS)
            # =========================
            if is_existing_file(item_name):
                log(f"  ⚠ SKIPPING: '{item_name}' is an existing file (not a folder)")
                log(f"  → This file will be left untouched")
                files_skipped += 1
                continue
            
            log(f"  ✓ '{item_name}' is a folder, proceeding with processing")

            document_key = item_name[len(ANONYMIZED_PREFIX):] if item_name.startswith(ANONYMIZED_PREFIX) else item_name
            if document_key in removed_documents:
                log(f"  ⚠ SKIPPING: '{document_key}' was removed from the case — discarding its pages")
                delete_s3_folder(request_id, item_name)
                files_skipped += 1
                continue
            
            # =========================
            # CHECK IF FOLDER IS ALREADY ANONYMIZED
            # =========================
            already_anonymized = is_already_anonymized(item_name)
            
            if already_anonymized:
                log(f"  ✓ Folder '{item_name}' is ALREADY ANONYMIZED (contains prefix)")
                log(f"  → Skipping LLM calls and OCR matching, will just merge pages into PDF")
                
                # List PNG files in the folder
                png_files = list_png_files_in_folder(request_id, item_name)
                
                if not png_files:
                    log(f"  WARNING: No PNG files found in folder '{item_name}', skipping")
                    continue
                
                # Process pages WITHOUT anonymization (just load images)
                log(f"  Loading {len(png_files)} pages without anonymization...")
                
                page_results = []
                max_workers = min(10, len(png_files))
                
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_to_page = {}
                    
                    for page_index, png_file in enumerate(png_files, 1):
                        future = executor.submit(
                            process_single_page_without_anonymization,
                            request_id,
                            item_name,
                            png_file,
                            page_index,
                            len(png_files)
                        )
                        future_to_page[future] = (page_index, png_file)
                    
                    for future in as_completed(future_to_page):
                        page_index, png_file = future_to_page[future]
                        try:
                            image, pii_count, _ = future.result()
                            page_results.append((page_index, image, pii_count))
                            log(f"  ✓ Page {page_index} loaded successfully")
                        except Exception as e:
                            log(f"  ERROR: Page {page_index} ({png_file}) failed: {str(e)}")
                            blank_image = Image.new("RGB", (1000, 1000), "white")
                            page_results.append((page_index, blank_image, 0))
                
                # Sort and extract images
                page_results.sort(key=lambda x: x[0])
                anonymized_images = [result[1] for result in page_results]
                total_pages_processed += len(anonymized_images)
                
                # Use existing name (already has prefix)
                anonymized_doc_name = item_name
                
            else:
                log(f"  → Folder '{item_name}' is NOT anonymized")
                log(f"  → Will perform LLM calls and anonymization")
                
                # Match folder name with OCR document keys
                ocr_matching_name = get_ocr_matching_name(item_name)
                log(f"  Matching folder name '{ocr_matching_name}' with OCR documents...")
                
                if ocr_matching_name not in ocr_documents:
                    log(f"  ERROR: No OCR data found for folder '{item_name}' (tried '{ocr_matching_name}')")
                    log(f"  Available OCR keys: {list(ocr_documents.keys())}")
                    continue
                
                pages = ocr_documents[ocr_matching_name]
                log(f"  ✓ Found OCR data with {len(pages)} pages")
                
                if not pages:
                    log(f"  WARNING: No pages in OCR data for '{item_name}', skipping")
                    continue
                
                # Sort pages by page number
                sorted_pages = sorted(pages.items(), key=lambda x: extract_page_number(x[0]))
                log(f"  Sorted page order: {[p[0] for p in sorted_pages]}")

                # Retain the unredacted originals BEFORE any redaction happens
                # below — this is what makes "remove a redaction" possible
                # later (see copy_pages_to_originals docstring).
                copy_pages_to_originals(request_id, item_name, [f"{page_name}.png" for page_name, _ in sorted_pages])
                if case_id and supabase:
                    redaction_core.upsert_originals_retention(supabase, case_id, request_id, item_name, log=log)

                # Process pages WITH anonymization
                log(f"  Starting parallel processing of {len(sorted_pages)} pages with anonymization...")
                
                page_results = []
                max_workers = min(10, len(sorted_pages))
                
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_to_page = {}
                    
                    for page_index, (page_name, entities) in enumerate(sorted_pages, 1):
                        future = executor.submit(
                            process_single_page_with_anonymization,
                            request_id,
                            item_name,
                            page_name,
                            entities,
                            page_index,
                            len(sorted_pages)
                        )
                        future_to_page[future] = (page_index, page_name)
                    
                    for future in as_completed(future_to_page):
                        page_index, page_name = future_to_page[future]
                        try:
                            image, pii_count, visual_pii_count, _, page_redaction_records = future.result()
                            page_results.append((page_index, image, pii_count))
                            total_pii_found += pii_count
                            total_visual_pii_found += visual_pii_count
                            item_redaction_records.extend(page_redaction_records)
                            log(f"  ✓ Page {page_index} completed with {pii_count} text PII entities, "
                                f"{visual_pii_count} visual PII regions")
                        except Exception as e:
                            log(f"  ERROR: Page {page_index} ({page_name}) failed: {str(e)}")
                            blank_image = Image.new("RGB", (1000, 1000), "white")
                            page_results.append((page_index, blank_image, 0))
                
                # Sort and extract images
                page_results.sort(key=lambda x: x[0])
                anonymized_images = [result[1] for result in page_results]
                total_pages_processed += len(anonymized_images)
                
                # Add prefix to name
                anonymized_doc_name = f"{ANONYMIZED_PREFIX}{item_name}"

            # =========================
            # BUILD PDF FROM IMAGES
            # =========================
            if not anonymized_images:
                log(f"  ERROR: No images to convert for folder '{item_name}'")
                continue
            
            log(f"  Creating PDF from {len(anonymized_images)} pages...")

            try:
                pdf_buf = redaction_core.merge_pages_to_pdf(anonymized_images)
                log(f"  PDF created successfully ({pdf_buf.getbuffer().nbytes} bytes)")
            except Exception as e:
                log(f"  ERROR creating PDF: {str(e)}")
                continue

            # =========================
            # PUBLISH PDF + PERSIST REDACTIONS
            # =========================
            # Any redaction rows left over from a prior pass describe regions
            # against page content a fresh automated reprocess just
            # regenerated from scratch, so they're deactivated first rather
            # than left stale and pointing at content that no longer exists.
            if case_id and supabase:
                if not already_anonymized:
                    redaction_core.deactivate_all_redactions(supabase, case_id, request_id, document_key, log=log)
                if item_redaction_records:
                    for r in item_redaction_records:
                        r["case_id"] = case_id
                        r["document_name"] = document_key
                        # Same generation as the version published below, so
                        # the Apply Lambda doesn't treat these as unpublished edits.
                        r["created_generation"] = generation
                    redaction_core.insert_redaction_records(supabase, item_redaction_records, log=log)

            pdf_bytes = pdf_buf.getvalue()
            try:
                if case_id and supabase:
                    # Conditional write + an immutable per-version copy (keyed by
                    # the unprefixed document name, even for legacy ANO_ folders).
                    redaction_core.write_document_version(
                        s3, S3_BUCKET, supabase, case_id, request_id, document_key,
                        render=lambda: io.BytesIO(pdf_bytes),
                        generation=generation,
                        anonymized_prefix=ANONYMIZED_PREFIX,
                        log=log,
                    )
                else:
                    pdf_key = f"uploads/{request_id}/data/{ANONYMIZED_PREFIX}{document_key}.pdf"
                    s3.put_object(Bucket=S3_BUCKET, Key=pdf_key, Body=pdf_bytes, ContentType="application/pdf")
                log(f"  ✓ PDF published")
            except Exception as e:
                log(f"  ERROR publishing PDF for '{document_key}': {str(e)}")
                continue

            # =========================
            # DELETE THE ENTIRE FOLDER
            # =========================
            log(f"  Deleting folder '{item_name}'...")
            delete_s3_folder(request_id, item_name)
            
            log(f"  ✓ Folder '{item_name}' processed successfully!")
            
            documents_processed += 1

        # =========================
        # UPDATE SUPABASE
        # =========================
        log("=" * 80)
        log("UPDATING SUPABASE DATABASE")
        log("=" * 80)
        
        try:
            # Reports don't carry their own verification step — only the case
            # summary does — so report_status just becomes ready ("verified").
            # This also completes the anonymize step of every upload run
            # committed before this pass started, and only marks reports ready
            # once no newer upload is still waiting (20260918_case_pipeline_runs.sql).
            # Tell the runs waiting on this pass which documents now exist as
            # anonymized PDFs. A run whose own uploads aren't all there fails
            # with the missing names (shown to the owner with a Retry)
            # instead of being reported complete.
            published = [
                obj["Key"].split("/")[-1][len(ANONYMIZED_PREFIX):-4]
                for page in s3.get_paginator("list_objects_v2").paginate(
                    Bucket=S3_BUCKET, Prefix=f"uploads/{request_id}/data/{ANONYMIZED_PREFIX}", Delimiter="/")
                for obj in page.get("Contents", [])
                if obj["Key"].lower().endswith(".pdf")
            ]
            outcome = supabase.rpc("pipeline_finish_anonymize", {
                "p_request_id": request_id, "p_started_at": started_at, "p_published": published,
            }).execute().data
            log(f"Runs finished by this pass: {outcome}")
            log("✓ Supabase database updated successfully")
        except Exception as e:
            log(f"ERROR: Failed to update Supabase: {str(e)}")
            return {
                "statusCode": 500,
                "body": json.dumps({
                    "error": f"Anonymization completed but Supabase update failed: {str(e)}",
                    "request_id": request_id
                })
            }

        # Final summary
        log("=" * 80)
        log("ANONYMIZATION COMPLETED SUCCESSFULLY")
        log(f"Folders processed: {documents_processed}")
        log(f"Files skipped (existing PDFs/files): {files_skipped}")
        log(f"Total pages processed: {total_pages_processed}")
        log(f"Total text PII entities found: {total_pii_found}")
        log(f"Total visual PII regions found: {total_visual_pii_found}")
        log(f"Supabase report_status updated to: verified")
        log("=" * 80)

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Anonymization completed successfully",
                "request_id": request_id,
                "folders_processed": documents_processed,
                "files_skipped": files_skipped,
                "total_pages": total_pages_processed,
                "total_pii_found": total_pii_found,
                "total_visual_pii_found": total_visual_pii_found,
                "supabase_updated": True,
                "report_status": "verified"
            })
        }

    except Exception as e:
        log("=" * 80)
        log(f"FATAL ERROR: {str(e)}")
        import traceback
        log(traceback.format_exc())
        log("=" * 80)
        
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }