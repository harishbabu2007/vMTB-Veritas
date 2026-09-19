"""
Which page images VMTB-EXTRACT-SUMMARIZE-V2 should summarize for a request.

Kept free of AWS clients so it can be unit-tested without credentials
(lambda_function.py loads prompts from S3 at import time).

The set of documents is defined by what is LIVE under
uploads/{request_id}/data/, never by what happens to exist elsewhere:
  - a direct-child file ANO_NNCMFAGSSS_22246_{name}.pdf is a finished
    document named {name};
  - a sub-folder data/{folder}/ holding page_N.png files is a document still
    being processed ({folder}, or {name} if the folder carries the ANO_
    prefix from an older re-run);
  - soft-deleted files (DELETE_ prefix) are not documents.

For each live document, pages come from data/{folder}/ when present, else
from the retained unredacted originals/{name}/. The previous logic used
data/ if it held ANY pages and otherwise fell back to ALL of originals/,
which (a) dropped every finished document from the summary whenever a new
upload was mid-conversion, and (b) summarized deleted documents, because
their originals outlive the delete.
"""
import re
from typing import Dict, Iterable, List, Tuple

ANONYMIZED_PREFIX = "ANO_NNCMFAGSSS_22246_"
DELETE_PREFIX = "DELETE_NNCMFAGSSS_22246_"

_PAGE_RE = re.compile(r"page_(\d+)\.png$")


def _strip_anonymized(name: str) -> str:
    return name[len(ANONYMIZED_PREFIX):] if name.startswith(ANONYMIZED_PREFIX) else name


def _pages_by_folder(keys: Iterable[str], prefix: str) -> Dict[str, List[Tuple[int, str]]]:
    """{folder: [(page_num, key)]} for keys shaped {prefix}{folder}/page_N.png."""
    folders: Dict[str, List[Tuple[int, str]]] = {}
    for key in keys:
        if not key.startswith(prefix):
            continue
        parts = key[len(prefix):].split("/")
        if len(parts) != 2:
            continue
        match = _PAGE_RE.fullmatch(parts[1])
        if not match:
            continue
        folders.setdefault(parts[0], []).append((int(match.group(1)), key))
    return folders


def plan_documents(request_id: str, data_keys: Iterable[str], originals_keys: Iterable[str],
                   removed: Iterable[str] = ()) -> Dict[str, List[str]]:
    """
    Return {document_name: [page keys in page order]} for every live document with pages.

    removed: document names the database records as removed from the case.
    Removals are committed there before S3 is touched, so a document whose
    file hasn't been renamed yet (or that a superseded run re-created) is
    still excluded.
    """
    removed = set(removed)
    data_prefix = f"uploads/{request_id}/data/"
    originals_prefix = f"uploads/{request_id}/originals/"
    data_keys = list(data_keys)

    data_pages = _pages_by_folder(data_keys, data_prefix)
    originals_pages = _pages_by_folder(originals_keys, originals_prefix)

    # document name -> data/ folder holding its in-progress pages (if any)
    live: Dict[str, str] = {}
    for key in data_keys:
        if not key.startswith(data_prefix):
            continue
        filename = key[len(data_prefix):]
        if not filename or "/" in filename or filename.startswith(DELETE_PREFIX):
            continue
        if filename.startswith(ANONYMIZED_PREFIX) and filename.lower().endswith(".pdf"):
            live.setdefault(_strip_anonymized(filename[:-4]), "")
    for folder in data_pages:
        if folder.startswith(DELETE_PREFIX):
            continue
        live[_strip_anonymized(folder)] = folder

    documents: Dict[str, List[str]] = {}
    for name in sorted(n for n in live if n not in removed):
        folder = live[name]
        pages = data_pages.get(folder) if folder else None
        if not pages:
            pages = originals_pages.get(name)
        if pages:
            documents[name] = [key for _, key in sorted(pages)]
    return documents
