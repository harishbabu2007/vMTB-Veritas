import os
import boto3
from botocore.config import Config

# ============================================================================
# AWS Clients
# ============================================================================

boto_config = Config(
    read_timeout=1000,
    connect_timeout=10,
    retries={
        "max_attempts": 3,
        "mode": "adaptive"
    }
)

s3 = boto3.client(
    "s3",
    region_name=os.environ["AWS_REGION"],
    config=boto_config
)

bedrock = boto3.client(
    "bedrock-runtime",
    region_name=os.environ["AWS_REGION"],
    config=boto_config
)

# ============================================================================
# Bucket Configuration
# ============================================================================

BUCKET_NAME = os.environ["BUCKET_NAME"]

RECORDINGS_FOLDER = os.environ.get(
    "RECORDINGS_FOLDER",
    "recordings"
)

PROMPTS_FOLDER = os.environ.get(
    "PROMPTS_FOLDER",
    "prompts"
)

TRANSCRIPTION_PROMPT = os.environ.get(
    "TRANSCRIPTION_PROMPT",
    "transcription_prompt.txt"
)

# ============================================================================
# Models
# ============================================================================

AUDIO_MODEL_ID = os.environ.get(
    "AUDIO_MODEL_ID",
    "mistral.voxtral-small-24b-2507-v1:0"
)

TEXT_MODEL_ID = os.environ.get(
    "TEXT_MODEL_ID",
    "qwen.qwen3-235b-a22b-2507-v1:0"
)

# ============================================================================
# Chunk Settings
# ============================================================================

CHUNK_DURATION = int(
    os.environ.get("CHUNK_DURATION", "20")
)

CHUNK_OVERLAP = int(
    os.environ.get("CHUNK_OVERLAP", "3")
)

# ============================================================================
# Parallel Processing
# ============================================================================

MAX_PARALLEL_REQUESTS = int(
    os.environ.get("MAX_PARALLEL_REQUESTS", "8")
)

# ============================================================================
# FFmpeg
# ============================================================================

FFMPEG_PATH = os.environ.get(
    "FFMPEG_PATH",
    "./ffmpeg"
)

# ============================================================================
# Temporary Directory
# ============================================================================

TMP_DIR = "/tmp"

# ============================================================================
# Merge Model
# ============================================================================

TEXT_MODEL_MAX_TOKENS = int(
    os.environ.get("TEXT_MODEL_MAX_TOKENS", "4096")
)

TEXT_MODEL_TEMPERATURE = float(
    os.environ.get("TEXT_MODEL_TEMPERATURE", "0.2")
)