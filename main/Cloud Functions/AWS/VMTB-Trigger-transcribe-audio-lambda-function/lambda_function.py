import json
import os
import boto3

# ============================================================
# Configuration
# ============================================================

lambda_client = boto3.client("lambda")

TRANSCRIBE_LAMBDA_NAME = os.environ["TRANSCRIBE_LAMBDA_NAME"]

# ============================================================
# Lambda
# ============================================================

def lambda_handler(event, context):

    try:

        body = json.loads(event["body"])

        recording_id = body["recording_id"]
        user_id = body["user_id"]

        payload = {
            "body": json.dumps({
                "recording_id": recording_id,
                "user_id": user_id
            })
        }

        # Invoke asynchronously
        lambda_client.invoke(
            FunctionName=TRANSCRIBE_LAMBDA_NAME,
            InvocationType="Event",   # Async invocation
            Payload=json.dumps(payload)
        )

        return {
            "statusCode": 202,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*"
            },
            "body": json.dumps({
                "success": True,
                "message": "Transcription started.",
                "recording_id": recording_id
            })
        }

    except Exception as e:

        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            "body": json.dumps({
                "success": False,
                "error": str(e)
            })
        }