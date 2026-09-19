import os
import json
from pathlib import Path

from config import (
    s3,
    BUCKET_NAME,
    RECORDINGS_FOLDER
)

# ============================================================
# Download Original Audio
# ============================================================

def download_original_audio(
    user_id: str,
    recording_id: str
):

    object_key = (
        f"{RECORDINGS_FOLDER}/"
        f"{user_id}/"
        f"{recording_id}/"
        f"original.webm"
    )

    local_file = f"/tmp/original.webm"

    s3.download_file(
        BUCKET_NAME,
        object_key,
        local_file
    )

    return local_file


# ============================================================
# Upload Chunk Audio
# ============================================================

def upload_chunk_audio(
    user_id: str,
    recording_id: str,
    chunk_index: int,
    local_file: str
):

    object_key = (
        f"{RECORDINGS_FOLDER}/"
        f"{user_id}/"
        f"{recording_id}/"
        f"chunks/"
        f"chunk_{chunk_index:03d}/"
        f"audio.mp3"
    )

    s3.upload_file(
        local_file,
        BUCKET_NAME,
        object_key
    )

    return object_key


# ============================================================
# Upload Chunk Result
# ============================================================

def upload_chunk_result(
    user_id: str,
    recording_id: str,
    chunk_index: int,
    result: dict
):

    object_key = (
        f"{RECORDINGS_FOLDER}/"
        f"{user_id}/"
        f"{recording_id}/"
        f"chunks/"
        f"chunk_{chunk_index:03d}/"
        f"result.json"
    )

    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=object_key,
        Body=json.dumps(
            result,
            indent=4
        ).encode(),
        ContentType="application/json"
    )

    return object_key


# ============================================================
# Upload Final Result
# ============================================================

def upload_final_result(
    user_id: str,
    recording_id: str,
    transcript: str
):

    object_key = (
        f"{RECORDINGS_FOLDER}/"
        f"{user_id}/"
        f"{recording_id}/"
        f"final_result.json"
    )

    body = {

        "transcript": transcript

    }

    s3.put_object(

        Bucket=BUCKET_NAME,

        Key=object_key,

        Body=json.dumps(
            body,
            indent=4
        ).encode(),

        ContentType="application/json"

    )

    return object_key