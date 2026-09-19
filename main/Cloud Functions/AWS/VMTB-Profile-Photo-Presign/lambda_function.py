import json
import os
import urllib.error
import urllib.request

import boto3

s3 = boto3.client("s3")

BUCKET_NAME = "vmtb-bedrock-qwen-bucket-v2"
URL_EXPIRATION_SECONDS = 900  # 15 minutes, matches the other presign Lambdas
MAX_UPLOAD_BYTES = 2_000_000  # 2 MB, matches the "max 2MB" advertised in the profile UI

ALLOWED_CONTENT_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _get_header(headers, name):
    if not headers:
        return None
    name = name.lower()
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def _authenticate(headers):
    """Resolves the caller's Supabase user id from their bearer token by asking
    Supabase to validate it. Never trust a client-supplied user id — the S3 key
    prefix a caller can write to or read from is built only from this value."""
    auth_header = _get_header(headers, "authorization")
    if not auth_header:
        return None

    token = auth_header[7:] if auth_header.lower().startswith("bearer ") else auth_header
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={
            "Authorization": f"Bearer {token}",
            "apikey": SUPABASE_ANON_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("id")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError):
        return None


def _handle_upload(user_id, body):
    try:
        payload = json.loads(body or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid request body"})

    content_type = payload.get("content_type")
    ext = ALLOWED_CONTENT_TYPES.get(content_type)
    if not ext:
        return _response(
            400,
            {"error": "content_type must be one of: " + ", ".join(sorted(ALLOWED_CONTENT_TYPES))},
        )

    key = f"profile-pics/{user_id}/avatar.{ext}"

    # No ACL field: this bucket has Object Ownership set to BucketOwnerEnforced,
    # so ACLs are disabled entirely — privacy comes from the bucket's Public
    # Access Block, not from a per-object ACL.
    presigned_post = s3.generate_presigned_post(
        Bucket=BUCKET_NAME,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            ["eq", "$Content-Type", content_type],
            ["content-length-range", 1, MAX_UPLOAD_BYTES],
        ],
        ExpiresIn=URL_EXPIRATION_SECONDS,
    )

    return _response(200, {
        "bucket": BUCKET_NAME,
        "key": key,
        "url": presigned_post["url"],
        "fields": presigned_post["fields"],
    })


def _handle_view(user_id, query_params):
    key = (query_params or {}).get("key")
    if not key:
        return _response(400, {"error": "key is required"})

    # Scoped to the caller's own folder — this endpoint only ever serves the
    # logged-in user's own avatar today.
    if not key.startswith(f"profile-pics/{user_id}/"):
        return _response(403, {"error": "You can only view your own profile photo."})

    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET_NAME, "Key": key},
        ExpiresIn=URL_EXPIRATION_SECONDS,
    )
    return _response(200, {"url": url, "expiresIn": URL_EXPIRATION_SECONDS})


def lambda_handler(event, context):
    try:
        method = event.get("requestContext", {}).get("http", {}).get("method", "")
        headers = event.get("headers") or {}

        user_id = _authenticate(headers)
        if not user_id:
            return _response(401, {"error": "Authentication required."})

        if method == "POST":
            return _handle_upload(user_id, event.get("body"))
        if method == "GET":
            return _handle_view(user_id, event.get("queryStringParameters"))

        return _response(405, {"error": "Method not allowed"})
    except Exception as e:
        return _response(500, {"error": str(e)})
