import os
import math
import shutil
import subprocess
from pathlib import Path

from config import (
    FFMPEG_PATH,
    TMP_DIR,
    CHUNK_DURATION,
    CHUNK_OVERLAP
)

# ============================================================
# Working Directories
# ============================================================

CHUNK_FOLDER = Path(TMP_DIR) / "chunks"

CHUNK_FOLDER.mkdir(parents=True, exist_ok=True)


# ============================================================
# Run FFmpeg
# ============================================================

def run_ffmpeg(command):

    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    if result.returncode != 0:
        raise RuntimeError(result.stderr)


# ============================================================
# Audio Duration
# ============================================================

import re

def get_audio_duration(audio_path: str):

    command = [
        FFMPEG_PATH,
        "-i",
        audio_path,
        "-f",
        "null",
        "-"
    ]

    process = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    stderr = process.stderr

    # Try normal metadata first
    for line in stderr.splitlines():
        if "Duration:" in line:
            duration = line.split("Duration:")[1].split(",")[0].strip()

            if duration != "N/A":
                hh, mm, ss = duration.split(":")
                return (
                    int(hh) * 3600 +
                    int(mm) * 60 +
                    float(ss)
                )

    # Fallback: use the last decoded timestamp
    matches = re.findall(
        r"time=(\d+):(\d+):([\d\.]+)",
        stderr
    )

    if matches:
        hh, mm, ss = matches[-1]
        return (
            int(hh) * 3600 +
            int(mm) * 60 +
            float(ss)
        )

    raise RuntimeError(
        "Unable to determine duration.\n\n" + stderr
    )

# ============================================================
# Split Audio
# ============================================================

def split_audio(audio_path: str):

    duration = get_audio_duration(audio_path)

    stride = CHUNK_DURATION - CHUNK_OVERLAP

    total_chunks = math.ceil(duration / stride)

    chunks = []

    for index in range(total_chunks):

        start = index * stride

        chunk_duration = min(
            CHUNK_DURATION,
            duration - start
        )

        folder = CHUNK_FOLDER / f"chunk_{index+1:03d}"

        folder.mkdir(
            parents=True,
            exist_ok=True
        )

        output_file = folder / "audio.mp3"

        command = [

            FFMPEG_PATH,

            "-y",

            "-i",
            audio_path,

            "-ss",
            str(start),

            "-t",
            str(chunk_duration),

            "-codec:a",
            "libmp3lame",

            "-q:a",
            "2",

            str(output_file)

        ]

        run_ffmpeg(command)

        chunks.append(

            {

                "chunk_index": index + 1,

                "start_time": start,

                "end_time": start + chunk_duration,

                "duration": chunk_duration,

                "local_path": str(output_file)

            }

        )

    return chunks

# ============================================================
# Cleanup
# ============================================================

def cleanup_chunks():

    if CHUNK_FOLDER.exists():

        shutil.rmtree(CHUNK_FOLDER)

    CHUNK_FOLDER.mkdir(
        parents=True,
        exist_ok=True
    )