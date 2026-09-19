import json
import re

import boto3

s3 = boto3.client("s3")

BUCKET_NAME = "vmtb-bedrock-qwen-bucket-v2"
URL_EXPIRATION = 900  # 15 minutes — same convention as VMTB-GET-REPORTS
ANONYMIZED_PREFIX = "ANO_NNCMFAGSSS_22246_"

# Only ever serves uploads/{request_id}/originals/ — the retained unredacted
# page images the manual redaction editor renders against. This prefix is
# never referenced by VMTB-GET-REPORTS (which only lists .../data/) and
# these URLs must never be surfaced anywhere outside the editor UI, since
# unlike the anonymized files this route exists specifically to serve, these
# pages contain real, unredacted PII. Callers should only invoke this when
# a user has explicitly opened the redaction editor for one specific
# document, never for the general report-viewing path.


def item_name_from_document_name(document_name: str) -> str:
    name = document_name
    if name.startswith(ANONYMIZED_PREFIX):
        name = name[len(ANONYMIZED_PREFIX):]
    if name.lower().endswith(".pdf"):
        name = name[:-4]
    return name


def extract_page_number(name: str) -> int:
    match = re.search(r"page_(\d+)", name)
    return int(match.group(1)) if match else 0


def lambda_handler(event, context):
    try:
        params = event.get("queryStringParameters") or {}
        request_id = params.get("request_id")
        document_name = params.get("document_name")

        if not request_id or not document_name:
            return response(400, {"error": "request_id and document_name are required"})

        item_name = item_name_from_document_name(document_name)
        prefix = f"uploads/{request_id}/originals/{item_name}/"

        listing = s3.list_objects_v2(Bucket=BUCKET_NAME, Prefix=prefix)

        pages = []
        for obj in listing.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/") or not key.lower().endswith(".png"):
                continue
            filename = key.split("/")[-1]
            url = s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": BUCKET_NAME, "Key": key},
                ExpiresIn=URL_EXPIRATION,
            )
            pages.append({"page_number": extract_page_number(filename), "url": url})

        pages.sort(key=lambda p: p["page_number"])

        return response(200, {"pages": pages, "available": len(pages) > 0})

    except Exception as e:
        return response(500, {"error": str(e)})


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body),
    }
