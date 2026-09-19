"""
Unit tests for document_listing.plan_documents — pure logic, no AWS.

Run with: pytest "main/Cloud Functions/AWS/VMTB-EXTRACT-SUMMARIZE-V2/test_document_listing.py"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from document_listing import plan_documents

R = "req"
D = f"uploads/{R}/data/"
O = f"uploads/{R}/originals/"
ANO = "ANO_NNCMFAGSSS_22246_"
DEL = "DELETE_NNCMFAGSSS_22246_"


def test_first_run_uses_data_pages_in_page_order():
    data = [D + "a/page_1.png", D + "a/page_0.png", D + "a/page_10.png", D + "notes.txt"]
    assert plan_documents(R, data, []) == {
        "a": [D + "a/page_0.png", D + "a/page_1.png", D + "a/page_10.png"],
    }


def test_finished_documents_use_originals():
    data = [D + f"{ANO}a.pdf", D + f"{ANO}b.pdf"]
    originals = [O + "a/page_0.png", O + "b/page_0.png", O + "b/page_1.png"]
    assert plan_documents(R, data, originals) == {
        "a": [O + "a/page_0.png"],
        "b": [O + "b/page_0.png", O + "b/page_1.png"],
    }


def test_deleted_document_is_excluded_even_though_originals_remain():
    data = [D + f"{ANO}a.pdf", D + f"{DEL}{ANO}b.pdf"]
    originals = [O + "a/page_0.png", O + "b/page_0.png"]
    assert plan_documents(R, data, originals) == {"a": [O + "a/page_0.png"]}


def test_new_upload_mid_conversion_does_not_drop_finished_documents():
    data = [D + f"{ANO}a.pdf", D + "new/page_0.png"]
    originals = [O + "a/page_0.png"]
    assert plan_documents(R, data, originals) == {
        "a": [O + "a/page_0.png"],
        "new": [D + "new/page_0.png"],
    }


def test_legacy_prefixed_rerun_folder_maps_to_unprefixed_name():
    data = [D + f"{ANO}a/page_0.png"]
    assert plan_documents(R, data, [O + "a/page_0.png"]) == {"a": [D + f"{ANO}a/page_0.png"]}


def test_document_without_any_pages_is_skipped():
    assert plan_documents(R, [D + f"{ANO}gone.pdf"], []) == {}


def test_database_removals_win_over_live_s3_files():
    data = [D + f"{ANO}a.pdf", D + f"{ANO}b.pdf", D + "c/page_0.png"]
    originals = [O + "a/page_0.png", O + "b/page_0.png"]
    assert plan_documents(R, data, originals, removed={"b", "c"}) == {"a": [O + "a/page_0.png"]}


def test_ignores_non_page_and_deeply_nested_keys():
    data = [D + "a/page_0.png", D + "a/thumb.png", D + "a/x/page_1.png"]
    assert plan_documents(R, data, []) == {"a": [D + "a/page_0.png"]}
