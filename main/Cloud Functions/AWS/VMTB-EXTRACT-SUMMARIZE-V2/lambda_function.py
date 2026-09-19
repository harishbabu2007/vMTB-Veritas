import boto3

s3 = boto3.client("s3")

PROMPT_BUCKET = "vmtb-bedrock-qwen-bucket-v2"
PROMPT_PREFIX = "prompts/"

def load_prompt_from_s3(filename: str) -> str:
    response = s3.get_object(
        Bucket=PROMPT_BUCKET,
        Key=f"{PROMPT_PREFIX}{filename}"
    )
    return response["Body"].read().decode("utf-8")

OCR_PROMPT = load_prompt_from_s3("ocr_prompt.txt")
SUMMARY_PROMPT = load_prompt_from_s3("summary_prompt.txt")

import json
import boto3
from botocore.config import Config
import io
import os
import uuid
import time
import re
import requests
from typing import TypedDict, List, Dict, Any, Annotated, Optional, Tuple
from PIL import Image
from langgraph.graph import StateGraph, END
from langsmith import traceable
import operator
from concurrent.futures import ThreadPoolExecutor, as_completed
from supabase import create_client, Client
from document_listing import plan_documents
import redaction_core
from redaction_core import RunSuperseded

# ============================================================================
# Configuration
# ============================================================================
BUCKET = "vmtb-bedrock-qwen-bucket-v2"
MODEL_ID_VL = "qwen.qwen3-vl-235b-a22b"  # For OCR/extraction
MODEL_ID_TEXT = "qwen.qwen3-235b-a22b-2507-v1:0"  # For summarization
BATCH_SIZE = 1
# ANONYMIZE_API = "https://gzgrswe52e.execute-api.ap-south-1.amazonaws.com/dev/anonymize"

# Bedrock native structured-output schema for the summarization call: forces the
# response to be a JSON object with the clinical summary plus patient age/sex,
# instead of free text we'd otherwise have to scrape with regex/prompt-hoping.
# Supported on MODEL_ID_TEXT via the bedrock-runtime Converse API's
# outputConfig.textFormat (json_schema) — see docs/DOCUMENT_AI_PIPELINE.md.
SUMMARY_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "The full clinical case summary, formatted exactly as instructed in the prompt"
        },
        "patient_age": {
            "type": ["integer", "null"],
            "description": "Patient age in years if explicitly stated in the documents, otherwise null"
        },
        "patient_sex": {
            "type": ["string", "null"],
            "enum": ["Male", "Female", "Other", None],
            "description": "Patient sex if explicitly stated in the documents, otherwise null"
        }
    },
    "required": ["summary", "patient_age", "patient_sex"],
    "additionalProperties": False
}

# Bedrock Pricing
INPUT_PRICE_PER_1K_TOKENS = 0.00053
OUTPUT_PRICE_PER_1K_TOKENS = 0.00266

# Supabase Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

# ============================================================================
# Clients
# ============================================================================
boto_config = Config(
    read_timeout=1000,
    connect_timeout=10,
    retries={'max_attempts': 3, 'mode': 'adaptive'}
)

s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime", region_name="ap-south-1", config=boto_config)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

# ============================================================================
# State Definition
# ============================================================================
class GraphState(TypedDict):
    clinical_data: Dict[str, List[str]]
    additional_data: str
    ocr_results: Annotated[Dict[str, str], operator.or_]
    timing_metrics: Annotated[Dict[str, Any], operator.or_]
    cost_metrics: Annotated[Dict[str, Any], operator.or_]
    final_summary: str
    patient_age: Optional[int]
    patient_sex: Optional[str]
    pipeline_start_time: float
    pipeline_end_time: float
    intermediate_ocr_combined: str
    request_id: str
    case_id: str

# ============================================================================
# Supabase Service
# ============================================================================
def update_case_summary(
    case_id: str,
    summary_text: str,
    patient_age: Optional[int] = None,
    patient_sex: Optional[str] = None,
) -> None:
    """Update case summary after ML processing completion.

    patient_age/patient_sex are only included in the update when extraction
    actually produced a value — never write a null over a value the user may
    have already filled in manually via the Edit Patient Details modal.
    """
    updates = {
        "summary": summary_text,
        "ai_generated_summary": summary_text,
        "summary_status": "unverified"
    }
    if patient_age is not None:
        updates["patient_age"] = patient_age
    if patient_sex is not None:
        updates["patient_sex"] = patient_sex

    supabase.table("cases").update(updates).eq("id", case_id).execute()

# ============================================================================
# Helper Functions
# ============================================================================
def download_from_s3(bucket: str, key: str) -> str:
    """Download file from S3 to /tmp."""
    local_path = f"/tmp/{uuid.uuid4()}_{os.path.basename(key)}"
    s3.download_file(bucket, key, local_path)
    return local_path

def image_to_bytes(path: str) -> bytes:
    """Convert and optimize image to raw bytes for Bedrock."""
    img = Image.open(path).convert("RGB")
    img.thumbnail((800, 800), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue()

def calculate_cost(input_tokens: int, output_tokens: int) -> float:
    """Calculate cost based on token usage."""
    input_cost = (input_tokens / 1000) * INPUT_PRICE_PER_1K_TOKENS
    output_cost = (output_tokens / 1000) * OUTPUT_PRICE_PER_1K_TOKENS
    return round(input_cost + output_cost, 6)

@traceable(name="bedrock_converse")
def call_bedrock(
    prompt: str,
    image_paths: List[str] = None,
    model_id: str = MODEL_ID_VL,
    response_schema: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Call Bedrock with optional images.

    When response_schema is given, uses Bedrock's native structured-outputs
    (Converse API outputConfig.textFormat, json_schema) so the returned text
    is guaranteed to be a JSON object conforming to that schema — constrained
    at decode time by Bedrock itself, not just requested via the prompt.
    """
    content = []

    if image_paths:
        for image_path in image_paths:
            image_bytes = image_to_bytes(image_path)
            content.append({
                "image": {
                    "format": "jpeg",
                    "source": {"bytes": image_bytes}
                }
            })

    content.append({"text": prompt})

    converse_kwargs: Dict[str, Any] = {
        "modelId": model_id,
        "messages": [{
            "role": "user",
            "content": content
        }],
        "inferenceConfig": {
            "maxTokens": 4096,
            "temperature": 0.2
        }
    }

    if response_schema is not None:
        converse_kwargs["outputConfig"] = {
            "textFormat": {
                "type": "json_schema",
                "structure": {
                    "jsonSchema": {
                        "name": "case_summary_extraction",
                        "schema": json.dumps(response_schema)
                    }
                }
            }
        }

    response = bedrock.converse(**converse_kwargs)

    usage = response.get("usage", {})
    input_tokens = usage.get("inputTokens", 0)
    output_tokens = usage.get("outputTokens", 0)
    
    return {
        "text": response["output"]["message"]["content"][0]["text"],
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost": calculate_cost(input_tokens, output_tokens)
    }

def _validate_patient_fields(age_raw: Any, sex_raw: Any) -> Tuple[Optional[int], Optional[str]]:
    """Coerce and clamp AI-extracted age/sex to plausible values; never raises.

    Bedrock's structured outputs enforces the JSON *shape* (required keys) for
    this call, but schema/type conformance for a third-party model like Qwen
    is looser than true constrained decoding — it can legally return
    "patient_age": "45" (string) or "patient_sex": "male" (wrong case) while
    still being a correct extraction. This coerces those forms before the
    actual sanity check (age range, sex membership) instead of discarding
    them outright, which was silently dropping valid values to null.
    """
    age = None
    if isinstance(age_raw, bool):
        age = None
    elif isinstance(age_raw, int):
        age = age_raw
    elif isinstance(age_raw, float) and age_raw.is_integer():
        age = int(age_raw)
    elif isinstance(age_raw, str) and age_raw.strip().isdigit():
        age = int(age_raw.strip())
    if age is not None and not (0 <= age <= 120):
        age = None

    sex = None
    if isinstance(sex_raw, str):
        sex = {
            "male": "Male", "m": "Male",
            "female": "Female", "f": "Female",
            "other": "Other",
        }.get(sex_raw.strip().lower())

    return age, sex

# Appended in code (not in prompts/summary_prompt.txt) and only to the
# structured call: the S3 prompt is shared with whatever image is live, and
# the unstructured fallback must not be told to return JSON.
SUMMARY_OUTPUT_INSTRUCTIONS = """

Response format: return a JSON object with exactly these fields:
- "summary": the clinical summary, written exactly as instructed above.
- "patient_age": the patient's own current age in whole years as stated in the documents (e.g. "Age: 67"). Never use a family member's age or any number that is part of a date. null if the patient's age is not stated.
- "patient_sex": "Male", "Female", or "Other", as stated in the documents. null if not stated.
"""

def call_bedrock_for_summary(prompt: str, model_id: str = MODEL_ID_TEXT) -> Dict[str, Any]:
    """Call Bedrock for the final summary, with age/sex extracted as structured
    fields instead of scraped from prose (see SUMMARY_OUTPUT_SCHEMA).

    Retries the structured call once on a malformed/failed response. If both
    structured attempts fail, falls back to a single unstructured call (no
    schema) so the summary text itself still comes back — age/sex simply stay
    null in that case — instead of losing the summary too. If even that
    fails, degrades to an empty summary with null age/sex. Never raises: this
    extraction is not required to succeed deterministically, and a failure
    here must never break the case-creation pipeline.
    """
    structured_prompt = prompt + SUMMARY_OUTPUT_INSTRUCTIONS
    last_result = None
    last_error = None
    for attempt in range(2):
        try:
            last_result = call_bedrock(structured_prompt, image_paths=None, model_id=model_id, response_schema=SUMMARY_OUTPUT_SCHEMA)
            parsed = json.loads(last_result["text"])
            summary_text = parsed.get("summary")
            if not isinstance(summary_text, str) or not summary_text.strip():
                raise ValueError("structured response contained no summary text")
            raw_age, raw_sex = parsed.get("patient_age"), parsed.get("patient_sex")
            print(f"[Summarization] Raw structured output: patient_age={raw_age!r} patient_sex={raw_sex!r}")
            age, sex = _validate_patient_fields(raw_age, raw_sex)
            return {**last_result, "text": summary_text, "patient_age": age, "patient_sex": sex}
        except Exception as err:
            last_error = err
            print(f"[Summarization] Structured extraction attempt {attempt + 1} failed: {err}")

    print(f"[Summarization] Giving up on structured extraction after 2 attempts ({last_error}); falling back to an unstructured summary call")
    try:
        fallback = call_bedrock(prompt, image_paths=None, model_id=model_id)
        return {**fallback, "patient_age": None, "patient_sex": None}
    except Exception as err:
        print(f"[Summarization] Unstructured fallback also failed: {err}")
        return {
            "text": "no data",
            "patient_age": None,
            "patient_sex": None,
            "input_tokens": last_result["input_tokens"] if last_result else 0,
            "output_tokens": last_result["output_tokens"] if last_result else 0,
            "cost": last_result["cost"] if last_result else 0.0,
        }

def list_keys(prefix: str) -> List[str]:
    keys = []
    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        keys.extend(obj['Key'] for obj in page.get('Contents', []))
    return keys


def list_documents_from_s3(request_id: str, removed=()) -> Dict[str, List[str]]:
    """
    List every live document's page PNGs for OCR + summarization. Which
    documents count as live, and where each one's pages come from, is
    decided by document_listing.plan_documents — see that module.
    """
    return plan_documents(
        request_id,
        list_keys(f"uploads/{request_id}/data/"),
        list_keys(f"uploads/{request_id}/originals/"),
        removed=removed,
    )


def read_text_documents(case_id: str, request_id: str) -> str:
    """
    The content of the case's live .txt documents, labelled by file name.
    Text files aren't converted to page images, so the OCR pipeline never
    sees them; before this, their content never reached the summary.
    """
    rows = (
        supabase.table("case_documents")
        .select("file_name")
        .eq("case_id", case_id)
        .is_("deleted_at", "null")
        .ilike("file_name", "%.txt")
        .execute()
    ).data or []
    parts = []
    for row in rows:
        key = f"uploads/{request_id}/data/{row['file_name']}"
        try:
            text = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read().decode("utf-8", errors="ignore").strip()
        except Exception as e:
            print(f"WARNING: couldn't read text document {key}: {e}")
            continue
        if text:
            parts.append(f"DOCUMENT: {row['file_name']}\n{text}")
    return "\n\n".join(parts)

def process_single_batch(batch_s3_keys: List[str], batch_info: Dict[str, Any]) -> Dict[str, Any]:
    """Process a single batch of images."""
    batch_id = batch_info["batch_id"]
    doc_id = batch_info["doc_id"]
    total_pages = batch_info["total_pages"]
    page_start = batch_info["page_start"]
    page_end = batch_info["page_end"]
    
    print(f"  [Doc {doc_id}] Batch {batch_id}: Processing pages {page_start}-{page_end}")
    
    batch_start_time = time.time()
    
    # Download images for this batch
    batch_local_images = []
    for s3_key in batch_s3_keys:
        local_path = download_from_s3(BUCKET, s3_key)
        batch_local_images.append(local_path)
    
    batch_prompt = f"""{OCR_PROMPT}

Context: This is a {total_pages}-page clinical document. You are processing pages {page_start} to {page_end}.
Extract all text exactly as it appears on these pages."""
    
    try:
        result = call_bedrock(batch_prompt, batch_local_images)
        
        batch_end_time = time.time()
        batch_duration = batch_end_time - batch_start_time
        
        print(f"  [Doc {doc_id}] Batch {batch_id}: Completed in {batch_duration:.2f}s "
              f"(tokens: {result['input_tokens']}in/{result['output_tokens']}out, "
              f"cost: ${result['cost']:.6f})")
        
        return {
            "batch_id": batch_id,
            "text": result["text"],
            "page_range": f"{page_start}-{page_end}",
            "duration_seconds": round(batch_duration, 2),
            "input_tokens": result["input_tokens"],
            "output_tokens": result["output_tokens"],
            "cost_usd": result["cost"]
        }
    
    finally:
        for local_path in batch_local_images:
            try:
                if os.path.exists(local_path):
                    os.remove(local_path)
            except Exception as e:
                print(f"  [Doc {doc_id}] Batch {batch_id}: Warning - could not remove {local_path}: {e}")

# ============================================================================
# Graph Nodes
# ============================================================================
@traceable(name="start_node")
def start_node(state: GraphState) -> Dict:
    """Initialize pipeline and record start time."""
    print(f"Starting pipeline with {len(state['clinical_data'])} documents")
    return {
        "pipeline_start_time": time.time()
    }

@traceable(name="ocr_document")
def ocr_document_node(state: GraphState, document_id: str) -> Dict:
    """Process a single document with parallel batch processing."""
    doc_start_time = time.time()
    print(f"\n[Document {document_id}] Starting OCR")
    
    image_keys = state["clinical_data"][document_id]
    total_pages = len(image_keys)
    print(f"[Document {document_id}] Total pages: {total_pages}")
    
    batches = []
    batch_results = []
    
    for i in range(0, total_pages, BATCH_SIZE):
        batch_s3_keys = image_keys[i:i + BATCH_SIZE]
        batch_id = (i // BATCH_SIZE) + 1
        page_start = i + 1
        page_end = min(i + len(batch_s3_keys), total_pages)
        
        batches.append({
            "batch_id": batch_id,
            "doc_id": document_id,
            "s3_keys": batch_s3_keys,
            "total_pages": total_pages,
            "page_start": page_start,
            "page_end": page_end
        })
    
    total_batches = len(batches)
    print(f"[Document {document_id}] Split into {total_batches} batch(es)")
    print(f"[Document {document_id}] Starting parallel batch processing...")
    
    with ThreadPoolExecutor(max_workers=total_batches) as executor:
        future_to_batch = {
            executor.submit(process_single_batch, batch["s3_keys"], batch): batch
            for batch in batches
        }
        
        for future in as_completed(future_to_batch):
            try:
                batch_result = future.result()
                batch_results.append(batch_result)
            except Exception as e:
                batch = future_to_batch[future]
                print(f"  [Doc {document_id}] Batch {batch['batch_id']} FAILED: {e}")
                raise
    
    batch_results.sort(key=lambda x: x["batch_id"])
    
    combined_text = "\n\n".join([
        f"=== Pages {br['page_range']} ===\n{br['text']}"
        for br in batch_results
    ])
    
    doc_end_time = time.time()
    doc_duration = doc_end_time - doc_start_time
    
    total_input_tokens = sum(br["input_tokens"] for br in batch_results)
    total_output_tokens = sum(br["output_tokens"] for br in batch_results)
    total_cost = sum(br["cost_usd"] for br in batch_results)
    max_batch_duration = max(br["duration_seconds"] for br in batch_results)
    
    print(f"[Document {document_id}] ✓ Completed in {doc_duration:.2f}s")
    print(f"[Document {document_id}] Max batch duration: {max_batch_duration:.2f}s")
    print(f"[Document {document_id}] Total cost: ${total_cost:.6f}")
    
    return {
        "ocr_results": {
            document_id: combined_text
        },
        "timing_metrics": {
            document_id: {
                "document_duration_seconds": round(doc_duration, 2),
                "max_batch_duration_seconds": max_batch_duration,
                "total_batches": total_batches,
                "batch_details": [
                    {
                        "batch_id": br["batch_id"],
                        "page_range": br["page_range"],
                        "duration_seconds": br["duration_seconds"]
                    }
                    for br in batch_results
                ]
            }
        },
        "cost_metrics": {
            document_id: {
                "total_cost_usd": round(total_cost, 6),
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
                "batch_costs": [
                    {
                        "batch_id": br["batch_id"],
                        "page_range": br["page_range"],
                        "cost_usd": br["cost_usd"],
                        "input_tokens": br["input_tokens"],
                        "output_tokens": br["output_tokens"]
                    }
                    for br in batch_results
                ]
            }
        }
    }

@traceable(name="summarization_node")
def summarization_node(state: GraphState) -> Dict:
    """Combine all OCR results and produce final summary."""
    summary_start_time = time.time()
    print("\n[Summarization] Starting final summarization")
    
    ocr_results = state.get("ocr_results", {})
    additional_data = state.get("additional_data", "").strip()
    
    if not ocr_results and not additional_data:
        print("[Summarization] No OCR data and no additional text. Skipping summarization.")
        return {
            "final_summary": "no data",
            "patient_age": None,
            "patient_sex": None,
            "intermediate_ocr_combined": "No OCR data extracted",
            "pipeline_end_time": time.time(),
            "timing_metrics": {
                "summarization": {
                    "duration_seconds": 0
                }
            },
            "cost_metrics": {
                "summarization": {
                    "cost_usd": 0.0,
                    "input_tokens": 0,
                    "output_tokens": 0
                }
            }
        }
    
    print(f"[Summarization] Documents processed: {len(ocr_results)}")
    
    # Format extracted documents in order
    extracted_docs = []
    clinical_data = state.get("clinical_data", {})
    
    # Sort document names (preserve original order from S3)
    doc_names_ordered = sorted(clinical_data.keys())
    
    for doc_name in doc_names_ordered:
        if doc_name in ocr_results and ocr_results[doc_name].strip():
            extracted_docs.append(f"--- Document: {doc_name} ---\n{ocr_results[doc_name]}\n")
    
    extracted_documents_str = "\n".join(extracted_docs)
    
    intermediate_combined = f"""INTERMEDIATE OCR EXTRACTION
{'='*80}

EXTRACTED DOCUMENTS:
{extracted_documents_str}

{'='*80}

ADDITIONAL DATA:
{additional_data if additional_data else "(None provided)"}
"""
    
    prompt = SUMMARY_PROMPT.format(
        extracted_documents=extracted_documents_str,
        additional_data=additional_data
    )
    
    result = call_bedrock_for_summary(prompt, model_id=MODEL_ID_TEXT)

    summary_duration = time.time() - summary_start_time

    print(f"[Summarization] ✓ Completed in {summary_duration:.2f}s")
    print(f"[Summarization] Cost: ${result['cost']:.6f}")
    print(f"[Summarization] Extracted patient_age={result['patient_age']!r} patient_sex={result['patient_sex']!r}")

    return {
        "final_summary": result["text"],
        "patient_age": result["patient_age"],
        "patient_sex": result["patient_sex"],
        "pipeline_end_time": time.time(),
        "intermediate_ocr_combined": intermediate_combined,
        "timing_metrics": {
            "summarization": {
                "duration_seconds": round(summary_duration, 2)
            }
        },
        "cost_metrics": {
            "summarization": {
                "cost_usd": result["cost"],
                "input_tokens": result["input_tokens"],
                "output_tokens": result["output_tokens"]
            }
        }
    }

# ============================================================================
# Dynamic Graph Construction
# ============================================================================
def build_parallel_ocr_graph(clinical_data: Dict[str, List[str]]) -> StateGraph:
    """Dynamically build a LangGraph with parallel OCR nodes."""
    graph = StateGraph(GraphState)
    
    graph.add_node("start", start_node)
    
    document_ids = [
        doc_id for doc_id, pages in clinical_data.items()
        if pages and len(pages) > 0
    ]
    
    for doc_id in document_ids:
        node_name = f"ocr_doc_{doc_id}"
        
        def create_ocr_node(document_id: str):
            @traceable(name=f"ocr_document_{document_id}")
            def node_func(state: GraphState) -> Dict:
                return ocr_document_node(state, document_id)
            return node_func
        
        graph.add_node(node_name, create_ocr_node(doc_id))
    
    graph.add_node("summarize", summarization_node)
    
    for doc_id in document_ids:
        graph.add_edge("start", f"ocr_doc_{doc_id}")
    
    for doc_id in document_ids:
        graph.add_edge(f"ocr_doc_{doc_id}", "summarize")
    
    graph.add_edge("summarize", END)
    graph.set_entry_point("start")
    
    return graph.compile()

# ============================================================================
# Main Execution Function
# ============================================================================
@traceable(name="parallel_ocr_pipeline")
def run_parallel_ocr_pipeline(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Execute the parallel OCR pipeline with full metrics."""
    clinical_data = input_data.get("clinical_data", {})
    additional_data = input_data.get("additional_data", "").strip()
    request_id = input_data.get("request_id", "")
    case_id = input_data.get("case_id", "")
    
    print(f"\n{'='*80}")
    print("PARALLEL OCR PIPELINE STARTED")
    print(f"{'='*80}")
    print(f"Request ID: {request_id}")
    print(f"Case ID: {case_id}")
    print(f"Total Documents: {len(clinical_data)}")
    for doc_id, pages in clinical_data.items():
        print(f"  Document {doc_id}: {len(pages)} page(s)")
    print(f"Batch Size: {BATCH_SIZE} pages per batch")
    print(f"{'='*80}\n")
    
    has_any_images = any(
        pages and len(pages) > 0
        for pages in clinical_data.values()
    )
    
    if not has_any_images:
        if additional_data:
            print("[Pipeline] No images found. Running summarization-only pipeline.")
            summary_start = time.time()
            
            result = call_bedrock_for_summary(
                SUMMARY_PROMPT.format(
                    extracted_documents="",
                    additional_data=additional_data
                ),
                model_id=MODEL_ID_TEXT
            )

            summary_duration = time.time() - summary_start

            return {
                "final_summary": result["text"],
                "patient_age": result["patient_age"],
                "patient_sex": result["patient_sex"],
                "intermediate_ocr_combined": f"ADDITIONAL DATA:\n{additional_data}",
                "metadata": {
                    "timing": {
                        "total_pipeline_duration_seconds": round(summary_duration, 2),
                        "summarization_duration_seconds": round(summary_duration, 2)
                    },
                    "cost": {
                        "total_cost_usd": result["cost"],
                        "summarization_cost_usd": result["cost"],
                        "total_input_tokens": result["input_tokens"],
                        "total_output_tokens": result["output_tokens"]
                    },
                    "processing_info": {
                        "note": "Summarization-only run (no images provided)",
                        "total_documents": len(clinical_data),
                        "model_id_vl": MODEL_ID_VL,
                        "model_id_text": MODEL_ID_TEXT
                    }
                }
            }
        
        print("[Pipeline] No images and no additional text. Returning no data.")
        return {
            "final_summary": "no data",
            "patient_age": None,
            "patient_sex": None,
            "intermediate_ocr_combined": "No data provided",
            "metadata": {
                "processing_info": {
                    "note": "No images and no additional text provided"
                }
            }
        }
    
    app = build_parallel_ocr_graph(clinical_data)
    
    initial_state = {
        "clinical_data": clinical_data,
        "additional_data": additional_data,
        "ocr_results": {},
        "timing_metrics": {},
        "cost_metrics": {},
        "final_summary": "",
        "patient_age": None,
        "patient_sex": None,
        "pipeline_start_time": 0.0,
        "pipeline_end_time": 0.0,
        "intermediate_ocr_combined": "",
        "request_id": request_id,
        "case_id": case_id
    }
    
    final_state = app.invoke(initial_state)
    
    total_pipeline_duration = (
        final_state["pipeline_end_time"] - final_state["pipeline_start_time"]
    )
    
    doc_durations = [
        final_state["timing_metrics"][doc_id]["document_duration_seconds"]
        for doc_id, pages in clinical_data.items()
        if pages
    ]
    max_document_duration = max(doc_durations) if doc_durations else 0
    
    total_ocr_cost = sum(
        final_state["cost_metrics"][doc_id]["total_cost_usd"]
        for doc_id, pages in clinical_data.items()
        if pages
    )
    
    summary_cost = final_state["cost_metrics"]["summarization"]["cost_usd"]
    total_cost = total_ocr_cost + summary_cost
    
    total_input_tokens = (
        sum(
            final_state["cost_metrics"][doc_id]["input_tokens"]
            for doc_id, pages in clinical_data.items()
            if pages
        )
        + final_state["cost_metrics"]["summarization"]["input_tokens"]
    )
    
    total_output_tokens = (
        sum(
            final_state["cost_metrics"][doc_id]["output_tokens"]
            for doc_id, pages in clinical_data.items()
            if pages
        )
        + final_state["cost_metrics"]["summarization"]["output_tokens"]
    )
    
    print(f"\n{'='*80}")
    print("PIPELINE COMPLETED")
    print(f"{'='*80}")
    print(f"Total Pipeline Duration: {total_pipeline_duration:.2f}s")
    print(f"Max Document Duration: {max_document_duration:.2f}s")
    print(f"Total Cost: ${total_cost:.6f}")
    print(f"Total Tokens: {total_input_tokens} input / {total_output_tokens} output")
    print(f"{'='*80}\n")
    
    return {
        "final_summary": final_state["final_summary"],
        "patient_age": final_state.get("patient_age"),
        "patient_sex": final_state.get("patient_sex"),
        "intermediate_oc_combined": final_state.get("intermediate_ocr_combined", ""),
        "metadata": {
            "timing": {
                "total_pipeline_duration_seconds": round(total_pipeline_duration, 2),
                "max_document_duration_seconds": round(max_document_duration, 2),
                "summarization_duration_seconds": final_state["timing_metrics"]["summarization"]["duration_seconds"],
                "per_document": {
                    doc_id: final_state["timing_metrics"][doc_id]
                    for doc_id, pages in clinical_data.items()
                    if pages
                }
            },
            "cost": {
                "total_cost_usd": round(total_cost, 6),
                "ocr_cost_usd": round(total_ocr_cost, 6),
                "summarization_cost_usd": round(summary_cost, 6),
                "total_input_tokens": total_input_tokens,
                "total_output_tokens": total_output_tokens,
                "per_document": {
                    doc_id: final_state["cost_metrics"][doc_id]
                    for doc_id, pages in clinical_data.items()
                    if pages
                },
                "summarization": final_state["cost_metrics"]["summarization"]
            },
            "processing_info": {
                "total_documents": len(clinical_data),
                "batch_size": BATCH_SIZE,
                "model_id_vl": MODEL_ID_VL,
                "model_id_text": MODEL_ID_TEXT,
                "parallelism": "Documents process in parallel; batches within documents process in parallel"
            }
        }
    }

# ============================================================================
# Lambda Handler
# ============================================================================
def lambda_handler(event, context):
    """
    AWS Lambda handler (API Gateway compatible).

    With a run_id (every caller since 20260918_case_pipeline_runs.sql), the
    case is summarized as the database says it is NOW — live documents,
    current additional data, .txt documents — and the result is written with
    pipeline_write_summary, which only applies it if no newer save has
    superseded this run. Failures are recorded on the run so the owner sees
    them with a Retry, instead of the case staying "processing" forever.
    Without a run_id (legacy callers) it behaves as before.
    """
    run_id = None
    request_id = None
    try:
        if "body" not in event or not event["body"]:
            raise ValueError("Request body is required")

        body = json.loads(event["body"]) if isinstance(event["body"], str) else event["body"]
        run_id = body.get("run_id")
        request_id = body["request_id"]
        case_id = body["case_id"]
        additional_data = body.get("additional_data", "") or ""
        removed = set()

        if run_id:
            run = redaction_core.pipeline_begin(supabase, run_id)
            if not run or not run.get("current"):
                print(f"Run {run_id} is {run and run.get('status')} / no longer current — not summarizing")
                return {"statusCode": 200, "body": json.dumps({"status": "superseded"})}
            case_id, request_id = run["case_id"], run["request_id"]
            additional_data = redaction_core.fetch_additional_data(supabase, case_id)
            removed = redaction_core.deleted_document_names(supabase, case_id)
            text_documents = read_text_documents(case_id, request_id)
            if text_documents:
                additional_data = f"{additional_data}\n\n{text_documents}".strip()

        print(f"\n{'='*80}")
        print(f"Processing Request ID: {request_id}")
        print(f"Case ID: {case_id}   Run: {run_id or '(legacy)'}")
        print(f"{'='*80}\n")

        clinical_data = list_documents_from_s3(request_id, removed)
        print(f"Found {len(clinical_data)} documents in S3:")
        for doc_name, pages in clinical_data.items():
            print(f"  - {doc_name}: {len(pages)} pages")

        if run_id and not clinical_data and not additional_data.strip():
            redaction_core.pipeline_fail(
                supabase, run_id, "NO_CONTENT",
                "There's nothing to summarize: the case has no documents or notes.")
            return {"statusCode": 200, "body": json.dumps({"status": "no_content"})}

        if run_id:
            redaction_core.ensure_current(supabase, run_id)

        input_data = {
            "clinical_data": clinical_data,
            "additional_data": additional_data,
            "request_id": request_id,
            "case_id": case_id
        }

        result = run_parallel_ocr_pipeline(input_data)

        intermediate_text = result.get("intermediate_oc_combined", "")
        print(f"Intermediate OCR text length: {len(intermediate_text)}")
        intermediate_key = f"uploads/{request_id}/results/intermediate_step.json"
        s3.put_object(
            Bucket=BUCKET,
            Key=intermediate_key,
            Body=json.dumps({"intermediate_ocr_combined": intermediate_text}, indent=2),
            ContentType="application/json"
        )

        final_key = f"uploads/{request_id}/results/final_summary.json"
        s3.put_object(
            Bucket=BUCKET,
            Key=final_key,
            Body=json.dumps({
                "final_summary": result["final_summary"],
                "patient_age": result.get("patient_age"),
                "patient_sex": result.get("patient_sex"),
                "metadata": result.get("metadata", {}),
                "run_id": run_id,
            }, indent=2),
            ContentType="application/json"
        )

        if run_id:
            applied = supabase.rpc("pipeline_write_summary", {
                "p_run_id": run_id,
                "p_summary": result["final_summary"],
                "p_patient_age": result.get("patient_age"),
                "p_patient_sex": result.get("patient_sex"),
            }).execute().data
            if not applied:
                print(f"Run {run_id} was superseded while summarizing — result discarded")
                return {"statusCode": 200, "body": json.dumps({"status": "superseded"})}
        else:
            update_case_summary(case_id, result["final_summary"], result.get("patient_age"), result.get("patient_sex"))
        print(f"✓ Updated Supabase case {case_id}")

        metadata = result.get("metadata", {})
        print(f"\n✓ Job {request_id} completed successfully")
        print(f"  Duration: {metadata.get('timing', {}).get('total_pipeline_duration_seconds')}s")
        print(f"  Cost: ${metadata.get('cost', {}).get('total_cost_usd')}")

        return {"statusCode": 200, "body": json.dumps({"status": "completed", "request_id": request_id})}

    except RunSuperseded:
        print(f"Run {run_id} was superseded by a newer save — stopping")
        return {"statusCode": 200, "body": json.dumps({"status": "superseded"})}

    except Exception as e:
        print(f"\n✗ Job failed: {str(e)}")
        import traceback
        traceback.print_exc()

        if request_id:
            try:
                s3.put_object(
                    Bucket=BUCKET,
                    Key=f"uploads/{request_id}/results/error.json",
                    Body=json.dumps({"error": str(e), "error_type": type(e).__name__, "run_id": run_id}, indent=2),
                    ContentType="application/json"
                )
            except Exception:
                pass
        if run_id:
            redaction_core.pipeline_fail(
                supabase, run_id, "SUMMARY_FAILED",
                f"The summary couldn't be generated: {str(e)[:300]}")

        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
