"""
Unit tests for redaction_core.write_document_version — the guarantee that an
older render never overwrites a newer anonymized PDF. Fake S3/Supabase, no AWS.

Run: pytest "main/Cloud Functions/AWS/_shared/test_write_document_version.py"
 or: python3 "main/Cloud Functions/AWS/_shared/test_write_document_version.py"
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import redaction_core as rc  # noqa: E402

BUCKET = "bucket"
REQ = "req"
CANONICAL = f"uploads/{REQ}/data/ANO_x.pdf"


class S3Error(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}, "Error": {"Code": code}}


class FakeS3:
    """Objects with ETags; honours IfMatch / IfNoneMatch / CopySourceIfMatch."""

    def __init__(self):
        self.objects = {}
        self.counter = 0
        self.before_canonical_put = None  # hook: simulate a concurrent writer

    def _etag(self):
        self.counter += 1
        return f'"e{self.counter}"'

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise S3Error(404, "404")
        return {"ETag": self.objects[Key][1]}

    def put_object(self, Bucket, Key, Body, ContentType=None, IfMatch=None, IfNoneMatch=None):
        if Key == CANONICAL and self.before_canonical_put:
            hook, self.before_canonical_put = self.before_canonical_put, None
            hook()
        current = self.objects.get(Key)
        if IfMatch is not None and (current is None or current[1] != IfMatch):
            raise S3Error(412, "PreconditionFailed")
        if IfNoneMatch == "*" and current is not None:
            raise S3Error(412, "PreconditionFailed")
        self.objects[Key] = (Body, self._etag())

    def copy_object(self, Bucket, CopySource, Key, CopySourceIfMatch=None):
        src = self.objects[CopySource["Key"]]
        if CopySourceIfMatch is not None and src[1] != CopySourceIfMatch:
            raise S3Error(412, "PreconditionFailed")
        self.objects[Key] = (src[0], self._etag())

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.op, self.payload, self.order_desc, self.lim = db, table, [], "select", None, False, None

    def select(self, *_):
        self.op = "select"
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def eq(self, col, val):
        self.filters.append((col, val))
        return self

    def order(self, col, desc=False):
        self.order_col, self.order_desc = col, desc
        return self

    def limit(self, n):
        self.lim = n
        return self

    def execute(self):
        rows = self.db.setdefault(self.table, [])
        match = [r for r in rows if all(r.get(c) == v for c, v in self.filters)]

        class Resp:
            pass

        resp = Resp()
        if self.op == "insert":
            key = (self.payload["case_id"], self.payload["document_name"], self.payload["version"])
            if any((r["case_id"], r["document_name"], r["version"]) == key for r in rows):
                raise Exception("duplicate key value violates unique constraint (23505)")
            row = dict(self.payload, id=f"v{len(rows) + 1}")
            rows.append(row)
            resp.data = [row]
        elif self.op == "update":
            for r in match:
                r.update(self.payload)
            resp.data = match
        else:
            if getattr(self, "order_col", None):
                match = sorted(match, key=lambda r: r[self.order_col], reverse=self.order_desc)
            resp.data = match[: self.lim] if self.lim else match
        return resp


class FakeSupabase:
    def __init__(self):
        self.db = {}

    def table(self, name):
        return FakeQuery(self.db, name)


def write(s3, sb, render, generation=2, is_current=None):
    return rc.write_document_version(
        s3, BUCKET, sb, "case", REQ, "x", render, generation, "ANO_", is_current=is_current, log=lambda *_: None
    )


def test_first_write_creates_canonical_and_version_row():
    s3, sb = FakeS3(), FakeSupabase()
    assert write(s3, sb, lambda: io.BytesIO(b"v1")) == 1
    assert s3.objects[CANONICAL][0] == b"v1"
    row = sb.db["case_document_versions"][0]
    assert row["generation"] == 2 and row["s3_key"].startswith(f"uploads/{REQ}/versions/x/g2-")
    assert s3.objects[row["s3_key"]][0] == b"v1"


def test_concurrent_write_forces_rerender_and_newest_content_wins():
    s3, sb = FakeS3(), FakeSupabase()
    write(s3, sb, lambda: io.BytesIO(b"old"))
    renders = []

    def render():
        renders.append(len(renders))
        # the second render sees the newer committed redactions
        return io.BytesIO(b"stale-render" if len(renders) == 1 else b"fresh-render")

    # another run publishes between our ETag read and our canonical put
    s3.before_canonical_put = lambda: s3.objects.__setitem__(CANONICAL, (b"other-run", s3._etag()))
    write(s3, sb, render, generation=3)
    assert len(renders) == 2, "a 412 must trigger a re-render"
    assert s3.objects[CANONICAL][0] == b"fresh-render"
    # the failed attempt's immutable copy was cleaned up
    assert not any(v[0] == b"stale-render" for v in s3.objects.values())


def test_superseded_run_never_publishes():
    s3, sb = FakeS3(), FakeSupabase()
    write(s3, sb, lambda: io.BytesIO(b"current"))
    try:
        write(s3, sb, lambda: io.BytesIO(b"stale"), generation=1, is_current=lambda: False)
        raise AssertionError("expected RunSuperseded")
    except rc.RunSuperseded:
        pass
    assert s3.objects[CANONICAL][0] == b"current"
    assert len(sb.db["case_document_versions"]) == 1


def test_legacy_version_pointing_at_canonical_is_preserved_before_overwrite():
    s3, sb = FakeS3(), FakeSupabase()
    s3.objects[CANONICAL] = (b"legacy-v1", '"legacy"')
    sb.db["case_document_versions"] = [
        {"id": "old", "case_id": "case", "document_name": "x", "version": 1, "s3_key": CANONICAL}
    ]
    assert write(s3, sb, lambda: io.BytesIO(b"v2")) == 2
    legacy = sb.db["case_document_versions"][0]
    assert legacy["s3_key"] != CANONICAL and s3.objects[legacy["s3_key"]][0] == b"legacy-v1"
    assert s3.objects[CANONICAL][0] == b"v2"


def test_gives_up_after_repeated_conflicts():
    s3, sb = FakeS3(), FakeSupabase()
    write(s3, sb, lambda: io.BytesIO(b"v1"))

    def keep_conflicting():
        s3.objects[CANONICAL] = (b"other", s3._etag())
        s3.before_canonical_put = keep_conflicting

    s3.before_canonical_put = keep_conflicting
    try:
        write(s3, sb, lambda: io.BytesIO(b"mine"))
        raise AssertionError("expected RuntimeError")
    except RuntimeError:
        pass


def test_soft_delete_is_idempotent():
    s3 = FakeS3()
    s3.objects[f"uploads/{REQ}/data/a.pdf"] = (b"a", '"1"')
    assert rc.soft_delete_data_file(s3, BUCKET, REQ, "a.pdf") == f"uploads/{REQ}/data/{rc.DELETE_PREFIX}a.pdf"
    assert rc.soft_delete_data_file(s3, BUCKET, REQ, "a.pdf") is None


class RowsQuery:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_):
        return self

    def eq(self, *_):
        return self

    def execute(self):
        class R:
            pass
        r = R()
        r.data = self.rows
        return r


class RowsSupabase:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _):
        return RowsQuery(self.rows)


def test_removed_then_readded_name_counts_as_live():
    rows = [
        {"document_name": "a", "deleted_at": "2026-09-17T00:00:00Z"},
        {"document_name": "a", "deleted_at": None},   # re-added with the same name
        {"document_name": "b", "deleted_at": "2026-09-17T00:00:00Z"},
        {"document_name": "c", "deleted_at": None},
    ]
    assert rc.deleted_document_names(RowsSupabase(rows), "case") == {"b"}


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
