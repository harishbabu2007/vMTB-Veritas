import os
import json
from datetime import datetime, timezone
from supabase import create_client

from config import (
    BUCKET_NAME
)

from bedrock_text import merge_transcriptions

from s3_utils import (
    upload_chunk_result,
    upload_final_result
)


# ============================================================
# Supabase
# ============================================================

supabase = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"]
)


# ============================================================
# Save Chunk Results
# ============================================================

def save_chunk_results(
    user_id,
    recording_id,
    chunk_results
):

    for chunk in chunk_results:

        upload_chunk_result(
            user_id=user_id,
            recording_id=recording_id,
            chunk_index=chunk["chunk_index"],
            result=chunk
        )


# ============================================================
# Save Final Result
# ============================================================

def save_final_result(
    user_id,
    recording_id,
    final_result
):

    upload_final_result(
        user_id=user_id,
        recording_id=recording_id,
        transcript=final_result["transcript"]
    )


# ============================================================
# Update Database
# ============================================================

def update_database(
    recording_id,
    final_result
):

    supabase.table(
        "speech_transcriptions"
    ).update(

        {

            "status": "completed",

            "transcript": final_result["transcript"],

            "completed_at": datetime.now(timezone.utc).isoformat()

        }

    ).eq(

        "recording_id",
        recording_id

    ).execute()


# ============================================================
# Error Update
# ============================================================

def update_failed(
    recording_id,
    error_message
):

    supabase.table(
        "speech_transcriptions"
    ).update(

        {

            "status": "failed",

            "error_message": error_message

        }

    ).eq(

        "recording_id",
        recording_id

    ).execute()


# ============================================================
# Complete Merge Pipeline
# ============================================================

def complete_pipeline(
    user_id,
    recording_id,
    chunk_results
):

    save_chunk_results(
        user_id,
        recording_id,
        chunk_results
    )

    final_result = merge_transcriptions(
        chunk_results
    )

    save_final_result(
        user_id,
        recording_id,
        final_result
    )

    update_database(
        recording_id,
        final_result
    )

    return final_result