import json
import os

import boto3

# Starts a committed pipeline run (POST /trigger-apply-redaction-changes).
#
# By the time this is called, the user's changes are already saved: the
# browser committed them with the commit_case_edits() RPC (or started a
# regenerate/retry/initial run), which returned a run id. This only queues
# VMTB-APPLY-REDACTION-CHANGES-V2 for that run, with an asynchronous
# (InvocationType='Event') invoke that returns as soon as Lambda accepts the
# event — an earlier version called Apply over HTTP with a 5s timeout and
# held every Save for the full 5s.
#
# Configure the target with maximum-retry-attempts 0: Apply records its own
# failures on the run (shown to the user with a Retry), and a run that never
# starts is expired to "failed" by get_case_run_state after 2 minutes.
# Re-sending the same run id is harmless — Apply is idempotent.

lambda_client = boto3.client("lambda")

TARGET_FUNCTION_NAME = os.environ.get("TARGET_FUNCTION_NAME", "VMTB-APPLY-REDACTION-CHANGES-V2")

HEADERS = {"Content-Type": "application/json"}


def lambda_handler(event, context):
    try:
        body = event.get("body")
        body = json.loads(body) if body else {}
        run_id = body.get("run_id")
        if not run_id:
            return {"statusCode": 400, "headers": HEADERS, "body": json.dumps({"error": "run_id is required"})}

        lambda_client.invoke(
            FunctionName=TARGET_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({"body": json.dumps({"run_id": run_id})}).encode("utf-8"),
        )
        return {"statusCode": 202, "headers": HEADERS, "body": json.dumps({"status": "queued", "run_id": run_id})}

    except Exception as e:
        print(f"Failed to queue run: {e}")
        return {"statusCode": 502, "headers": HEADERS, "body": json.dumps({"error": "Couldn't start processing"})}
