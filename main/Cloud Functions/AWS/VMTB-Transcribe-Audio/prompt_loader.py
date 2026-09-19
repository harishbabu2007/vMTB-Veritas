from config import (
    s3,
    BUCKET_NAME,
    PROMPTS_FOLDER,
    TRANSCRIPTION_PROMPT
)


def load_transcription_prompt() -> str:
    """
    Load the transcription merge prompt from S3.
    """

    key = (
        f"{PROMPTS_FOLDER}/"
        f"{TRANSCRIPTION_PROMPT}"
    )

    response = s3.get_object(
        Bucket=BUCKET_NAME,
        Key=key
    )

    prompt = (
        response["Body"]
        .read()
        .decode("utf-8")
    )

    return prompt