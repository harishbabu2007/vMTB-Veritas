import json
import boto3

s3 = boto3.client("s3")

BUCKET_NAME = "vmtb-bedrock-qwen-bucket-v2"
URL_EXPIRATION = 900  # 15 minutes
DELETE_PREFIX = "DELETE_NNCMFAGSSS_22246_"

CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
}


def list_document_filenames(s3_client, request_id):
    """
    Filenames of the user-facing documents for a request: only DIRECT
    children of uploads/{request_id}/data/, never anything nested below it.

    The pipeline writes per-page working files into sub-folders
    (data/{doc}/page_N.png) while a document is being converted/anonymized.
    Those are internal artifacts, not documents — listing recursively is what
    made the Reports tab show page_0.png, page_1.png, ... in place of whole
    documents whenever it refreshed during a (re)processing run. Delimiter='/'
    returns sub-folders as CommonPrefixes, which are ignored here.
    """
    prefix = f"uploads/{request_id}/data/"
    paginator = s3_client.get_paginator("list_objects_v2")
    filenames = []
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=prefix, Delimiter="/"):
        for obj in page.get("Contents", []):
            filename = obj["Key"][len(prefix):]
            if not filename or "/" in filename:
                continue
            if filename.startswith(DELETE_PREFIX):
                continue
            filenames.append(filename)
    return filenames


def presign(s3_client, request_id, filename):
    return s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET_NAME, "Key": f"uploads/{request_id}/data/{filename}"},
        ExpiresIn=URL_EXPIRATION
    )


def signable_keys(request_id, raw_keys):
    """
    Keys a caller may have signed: only this request's own documents and
    their archived versions (data/ and versions/), never originals/ (unredacted)
    or results/, and nothing that escapes the prefix.
    """
    allowed = (f"uploads/{request_id}/data/", f"uploads/{request_id}/versions/")
    keys = []
    for key in raw_keys:
        key = key.strip()
        if key and ".." not in key and key.startswith(allowed):
            keys.append(key)
    return keys


def lambda_handler(event, context):
    try:
        params = event.get("queryStringParameters") or {}
        request_id = params.get("request_id")
        # Optional: re-sign just one document. The frontend calls this right
        # before opening a document, so a list fetched long ago (URLs expire
        # after URL_EXPIRATION) can never hand the viewer an expired URL.
        only_filename = params.get("filename")
        # Optional: sign specific document versions (comma-separated keys).
        # MTB members viewing the last verified version of a case read the
        # document versions as they were when the owner verified it.
        version_keys = params.get("version_keys")

        if not request_id:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "request_id is required"})
            }

        if version_keys is not None:
            keys = signable_keys(request_id, version_keys.split(","))
            files = [{
                "key": key,
                "url": s3.generate_presigned_url(
                    "get_object", Params={"Bucket": BUCKET_NAME, "Key": key}, ExpiresIn=URL_EXPIRATION),
            } for key in keys]
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({"files": files, "expires_in": URL_EXPIRATION})
            }

        filenames = list_document_filenames(s3, request_id)
        if only_filename is not None:
            if only_filename not in filenames:
                return {
                    "statusCode": 404,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({"error": "file not found"})
                }
            filenames = [only_filename]

        files = [{"filename": f, "url": presign(s3, request_id, f)} for f in filenames]

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"files": files, "expires_in": URL_EXPIRATION})
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
