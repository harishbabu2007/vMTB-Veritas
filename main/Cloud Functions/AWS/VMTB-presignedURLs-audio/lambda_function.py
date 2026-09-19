import json
import os
import boto3

# ============================================================
# Configuration
# ============================================================

s3 = boto3.client("s3")

BUCKET_NAME = os.environ["BUCKET_NAME"]
RECORDINGS_FOLDER = os.environ["RECORDINGS_FOLDER"]
URL_EXPIRY = int(os.environ.get("URL_EXPIRY", "900"))

# ============================================================
# Lambda
# ============================================================

def lambda_handler(event, context):

    try:

        body = json.loads(event["body"])

        recording_id = body["recording_id"]
        user_id = body["user_id"]

        file_name = "original.webm"

        object_key = (
            f"{RECORDINGS_FOLDER}/"
            f"{user_id}/"
            f"{recording_id}/"
            f"{file_name}"
        )

        presigned_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": BUCKET_NAME,
                "Key": object_key,
            },
            ExpiresIn=URL_EXPIRY,
        )

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*",
            },
            "body": json.dumps({
                "success": True,
                "bucket": BUCKET_NAME,
                "object_key": object_key,
                "presigned_url": presigned_url,
                "expires_in": URL_EXPIRY,
                "mime_type": "audio/webm"
            }),
        }

    except Exception as e:

        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            "body": json.dumps({
                "success": False,
                "error": str(e),
            }),
        }