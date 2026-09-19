"""
Unit tests for the Phase 3 visual-PII helper functions in lambda_function.py.

These test only the pure, deterministic logic (coordinate math and JSON
parsing/validation) — no AWS credentials, no network calls, and no live
Bedrock invocation. Importing lambda_function here does execute its
module-level boto3/Supabase client construction and the (deliberately
non-fatal, see load_prompt_from_s3's try/except) S3 prompt load, none of
which require live credentials or a network call to succeed at import time.

Run with: pytest "main/Cloud Functions/AWS/VMTB-OCR2ANO-V2/test_visual_pii.py"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from lambda_function import (
    clamp01,
    normalized_bbox_to_pixels,
    parse_and_validate_visual_json,
)


# ---------------------------------------------------------------------------
# clamp01
# ---------------------------------------------------------------------------

def test_clamp01_in_range():
    assert clamp01(0.5) == 0.5


def test_clamp01_below_range():
    assert clamp01(-0.3) == 0.0


def test_clamp01_above_range():
    assert clamp01(1.7) == 1.0


def test_clamp01_boundaries():
    assert clamp01(0.0) == 0.0
    assert clamp01(1.0) == 1.0


# ---------------------------------------------------------------------------
# normalized_bbox_to_pixels
# ---------------------------------------------------------------------------

def test_normalized_bbox_to_pixels_basic_scaling():
    # A centered box on a 1000x2000 image.
    result = normalized_bbox_to_pixels([0.25, 0.25, 0.75, 0.75], 1000, 2000)
    assert result == [250, 500, 750, 1500]


def test_normalized_bbox_to_pixels_full_page():
    result = normalized_bbox_to_pixels([0.0, 0.0, 1.0, 1.0], 800, 600)
    assert result == [0, 0, 800, 600]


def test_normalized_bbox_to_pixels_clamps_out_of_range():
    # Model overshoots past 1.0 and undershoots below 0.0.
    result = normalized_bbox_to_pixels([-0.1, 0.0, 1.2, 0.5], 1000, 1000)
    assert result is not None
    px1, py1, px2, py2 = result
    assert px1 == 0
    assert px2 == 1000
    assert 0 <= py1 <= py2 <= 1000


def test_normalized_bbox_to_pixels_swaps_reversed_coords():
    # x2 < x1 should be corrected, not produce an inverted/empty rectangle.
    result = normalized_bbox_to_pixels([0.8, 0.2, 0.2, 0.6], 1000, 1000)
    assert result is not None
    px1, py1, px2, py2 = result
    assert px1 < px2
    assert px1 == 200
    assert px2 == 800


def test_normalized_bbox_to_pixels_rejects_degenerate_box():
    # Zero-area box after clamping.
    result = normalized_bbox_to_pixels([0.5, 0.5, 0.5, 0.5], 1000, 1000)
    assert result is None


def test_normalized_bbox_to_pixels_rejects_wrong_length():
    assert normalized_bbox_to_pixels([0.1, 0.2, 0.3], 1000, 1000) is None
    assert normalized_bbox_to_pixels(None, 1000, 1000) is None


def test_normalized_bbox_to_pixels_rejects_non_numeric():
    assert normalized_bbox_to_pixels(["a", "b", "c", "d"], 1000, 1000) is None


# ---------------------------------------------------------------------------
# parse_and_validate_visual_json
# ---------------------------------------------------------------------------

def test_parse_visual_json_happy_path():
    raw = '[{"category": "signature", "confidence": 0.9, "bbox_normalized": [0.1, 0.1, 0.2, 0.2]}]'
    result = parse_and_validate_visual_json(raw)
    assert len(result) == 1
    assert result[0]["category"] == "signature"
    assert result[0]["confidence"] == 0.9
    assert result[0]["bbox_normalized"] == [0.1, 0.1, 0.2, 0.2]


def test_parse_visual_json_empty_array():
    assert parse_and_validate_visual_json("[]") == []


def test_parse_visual_json_empty_string():
    assert parse_and_validate_visual_json("") == []
    assert parse_and_validate_visual_json(None) == []


def test_parse_visual_json_strips_markdown_fences():
    raw = '```json\n[{"category": "qr_code", "confidence": 0.8, "bbox_normalized": [0,0,0.1,0.1]}]\n```'
    result = parse_and_validate_visual_json(raw)
    assert len(result) == 1
    assert result[0]["category"] == "qr_code"


def test_parse_visual_json_drops_unknown_category():
    raw = json_two_items_one_bad_category()
    result = parse_and_validate_visual_json(raw)
    assert len(result) == 1
    assert result[0]["category"] == "stamp"


def json_two_items_one_bad_category():
    return (
        '[{"category": "made_up_thing", "confidence": 0.9, "bbox_normalized": [0,0,0.1,0.1]},'
        ' {"category": "stamp", "confidence": 0.8, "bbox_normalized": [0.2,0.2,0.3,0.3]}]'
    )


def test_parse_visual_json_repairs_trailing_comma():
    raw = '[{"category": "barcode", "confidence": 0.75, "bbox_normalized": [0.1,0.1,0.2,0.2]},]'
    result = parse_and_validate_visual_json(raw)
    assert len(result) == 1
    assert result[0]["category"] == "barcode"


def test_parse_visual_json_drops_missing_bbox():
    raw = '[{"category": "logo", "confidence": 0.9}]'
    result = parse_and_validate_visual_json(raw)
    assert result == []


def test_parse_visual_json_drops_non_list_top_level():
    raw = '{"category": "logo", "confidence": 0.9, "bbox_normalized": [0,0,1,1]}'
    result = parse_and_validate_visual_json(raw)
    assert result == []


def test_parse_visual_json_clamps_out_of_range_confidence():
    raw = '[{"category": "hospital_logo", "confidence": 1.4, "bbox_normalized": [0,0,0.1,0.1]}]'
    result = parse_and_validate_visual_json(raw)
    assert len(result) == 1
    assert result[0]["confidence"] == 1.0
