import json
import traceback

from s3_utils import (
    download_original_audio,
    upload_chunk_audio
)

from audio_utils import (
    split_audio,
    cleanup_chunks
)

from bedrock_audio import (
    transcribe_chunks_parallel
)

from merge import (
    complete_pipeline,
    update_failed
)

# ============================================================
# Upload All Chunks
# ============================================================

def upload_chunks(
    user_id,
    recording_id,
    chunks
):

    for chunk in chunks:

        upload_chunk_audio(

            user_id=user_id,

            recording_id=recording_id,

            chunk_index=chunk["chunk_index"],

            local_file=chunk["local_path"]

        )

    return chunks

def lambda_handler(event, context):
    recording_id = None
    user_id = None
    try:

        body = json.loads(event["body"])

        recording_id = body["recording_id"]

        user_id = body["user_id"]

        original_audio = download_original_audio(
            user_id,
            recording_id
        )

        chunks = split_audio(
            original_audio
        )

        upload_chunks(
            user_id,
            recording_id,
            chunks
        )

        # ========================================================
        # Transcribe All Chunks
        # ========================================================

        chunk_results = transcribe_chunks_parallel(
            chunks
        )

        # ========================================================
        # Merge + Upload + Update DB
        # ========================================================

        final_result = complete_pipeline(
            user_id=user_id,
            recording_id=recording_id,
            chunk_results=chunk_results
        )

        # ========================================================
        # Cleanup
        # ========================================================

        try:
            cleanup_chunks()
        except Exception:
            pass

        return {

            "statusCode": 200,

            "headers": {

                "Content-Type": "application/json",

                "Access-Control-Allow-Origin": "*"

            },

            "body": json.dumps(

                {

                    "success": True,

                    "recording_id": recording_id,

                    "transcript": final_result["transcript"]

                }

            )

        }

    except Exception as e:
        print(str(e))
        try:

            if recording_id is not None:
                try:
                    update_failed(
                        recording_id,
                        str(e)
                    )
                except Exception:
                    pass

        except Exception:
            pass

        try:
            cleanup_chunks()
        except Exception:
            pass

        traceback.print_exc()

        return {

            "statusCode": 500,

            "headers": {

                "Content-Type": "application/json",

                "Access-Control-Allow-Origin": "*"

            },

            "body": json.dumps(

                {

                    "success": False,

                    "error": str(e)

                }

            )

        }