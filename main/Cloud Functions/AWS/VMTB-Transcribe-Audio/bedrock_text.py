from config import (
    bedrock,
    TEXT_MODEL_ID,
    TEXT_MODEL_MAX_TOKENS,
    TEXT_MODEL_TEMPERATURE
)

from prompt_loader import load_transcription_prompt


# ============================================================
# Build Prompt
# ============================================================

def build_merge_prompt(chunk_results):

    prompt = load_transcription_prompt()

    final_prompt = ""

    for chunk in chunk_results:

        final_prompt += (
            f"Chunk {chunk['chunk_index']}\n"
            f"{'-'*50}\n"
            f"{chunk['transcript']}\n\n"
        )

    final_prompt += "\n"
    final_prompt += "=" * 80
    final_prompt += "\n\n"

    final_prompt += prompt

    return final_prompt


# ============================================================
# Merge Chunks
# ============================================================

def merge_transcriptions(chunk_results):

    prompt = build_merge_prompt(chunk_results)

    response = bedrock.converse(

        modelId=TEXT_MODEL_ID,

        messages=[

            {

                "role": "user",

                "content": [

                    {

                        "text": prompt

                    }

                ]

            }

        ],

        inferenceConfig={

            "maxTokens": TEXT_MODEL_MAX_TOKENS,

            "temperature": TEXT_MODEL_TEMPERATURE

        }

    )

    usage = response.get("usage", {})

    transcript = response["output"]["message"]["content"][0]["text"]

    return {

        "transcript": transcript,

        "input_tokens": usage.get("inputTokens", 0),

        "output_tokens": usage.get("outputTokens", 0)

    }