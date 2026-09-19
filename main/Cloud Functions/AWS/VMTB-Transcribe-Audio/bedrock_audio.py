import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import (
    bedrock,
    AUDIO_MODEL_ID,
    MAX_PARALLEL_REQUESTS
)


# ============================================================
# Transcribe One Chunk
# ============================================================

def transcribe_chunk(chunk):

    with open(chunk["local_path"], "rb") as f:
        audio_bytes = f.read()

    response = bedrock.converse(

        modelId=AUDIO_MODEL_ID,

        messages=[
            {
                "role": "user",
                "content": [

                    {
                        "audio": {
                            "format": "mp3",
                            "source": {
                                "bytes": audio_bytes
                            }
                        }
                    },

                    {
                        "text": "Transcribe this audio exactly as spoken. Do not summarize. Return only the transcription."
                    }

                ]
            }
        ]

    )

    transcript = response["output"]["message"]["content"][0]["text"]

    usage = response.get("usage", {})

    return {

        "chunk_index": chunk["chunk_index"],

        "start_time": chunk["start_time"],

        "end_time": chunk["end_time"],

        "duration": chunk["duration"],

        "transcript": transcript,

        "input_tokens": usage.get("inputTokens", 0),

        "output_tokens": usage.get("outputTokens", 0)

    }


# ============================================================
# Parallel Transcription
# ============================================================

def transcribe_chunks_parallel(chunks):

    results = []

    future_to_chunk = {}

    with ThreadPoolExecutor(
        max_workers=MAX_PARALLEL_REQUESTS
    ) as executor:

        for chunk in chunks:

            future = executor.submit(
                transcribe_chunk,
                chunk
            )

            future_to_chunk[future] = chunk["chunk_index"]

        for future in as_completed(future_to_chunk):

            result = future.result()

            results.append(result)

    results.sort(
        key=lambda x: x["chunk_index"]
    )

    return results