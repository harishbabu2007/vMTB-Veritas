-- Scenario tests for 20260918_case_pipeline_runs.sql (commit/supersede/verify/
-- regenerate/retry/expiry/empty-case), run against a REAL database without
-- leaving any trace: the migration and this block run inside one transaction,
-- and the block ends by raising TEST_RESULTS <json>, which aborts it.
--
--   { echo "BEGIN;"; cat ../migrations/20260918_case_pipeline_runs.sql; \
--     cat case_pipeline_runs_test.sql; echo "ROLLBACK;"; } > /tmp/run.sql
--   supabase db query --linked -f /tmp/run.sql
--
-- (Once the migration is applied, run just "BEGIN;" + this file + "ROLLBACK;".)
-- `owner` must be the id of an existing auth user; the test case it creates
-- is rolled back with everything else. Expected results are listed in
-- docs/DOCUMENT_AI_PIPELINE.md ("Edits and pipeline runs").
DO $test$
DECLARE
    owner CONSTANT uuid := '9edb105e-6319-4cb1-a200-ec517144716f';
    stranger CONSTANT uuid := '00000000-0000-0000-0000-00000000beef';
    cid uuid := gen_random_uuid();
    res jsonb := '{}'::jsonb;
    r jsonb;
    run1 uuid := gen_random_uuid(); run2 uuid := gen_random_uuid(); run3 uuid := gen_random_uuid();
    run4 uuid := gen_random_uuid(); run5 uuid := gen_random_uuid(); run6 uuid := gen_random_uuid();
    reg_a uuid;
    b boolean;
    c public.cases;
    err text;
    n int;
BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated')::text, true);

    INSERT INTO public.cases (id, owner_id, case_name, cancer_type, summary_status, request_id, report_status, patient_age, patient_sex)
    VALUES (cid, owner, 'claude-txn-test', 'Test', 'verified', 'claude-test-req', 'verified', 50, 'Female');
    INSERT INTO public.case_documents (case_id, file_name, document_name) VALUES (cid, 'a.pdf', 'a'), (cid, 'b.pdf', 'b');
    INSERT INTO public.case_document_retention (case_id, request_id, document_name, originals_retained_at)
    VALUES (cid, 'claude-test-req', 'b', now());
    INSERT INTO public.case_document_redactions (case_id, request_id, document_name, page_number, bbox, style, source, is_active)
    VALUES (cid, 'claude-test-req', 'b', 0, '{"x0":0.1,"y0":0.1,"x1":0.2,"y1":0.2}', 'whiteout', 'automated_text', true)
    RETURNING id INTO reg_a;

    -- T1 delete one document
    r := public.commit_case_edits(cid, run1, '[]', ARRAY['ANO_NNCMFAGSSS_22246_a.pdf']);
    SELECT * INTO c FROM public.cases WHERE id = cid;
    res := res || jsonb_build_object('T1', jsonb_build_object('gen', r->'generation', 'status', r->>'status',
        'case_gen', c.content_generation, 'summary_status', c.summary_status,
        'a_deleted', (SELECT deleted_at IS NOT NULL FROM case_documents WHERE case_id=cid AND document_name='a')));

    -- T2 same session again is a no-op
    r := public.commit_case_edits(cid, run1, '[]', ARRAY['ANO_NNCMFAGSSS_22246_a.pdf']);
    res := res || jsonb_build_object('T2', jsonb_build_object('duplicate', r->'duplicate',
        'case_gen', (SELECT content_generation FROM cases WHERE id=cid)));

    -- T3 second batch while run1 still pending: reveal reg_a + add a box on b
    r := public.commit_case_edits(cid, run2, jsonb_build_array(jsonb_build_object('document_filename','ANO_NNCMFAGSSS_22246_b.pdf',
        'changes', jsonb_build_array(
            jsonb_build_object('action','remove','redaction_id',reg_a),
            jsonb_build_object('action','add','page_number',0,'bbox','{"x0":0.5,"y0":0.5,"x1":0.6,"y1":0.6}'::jsonb,'style','blackout')))));
    res := res || jsonb_build_object('T3', jsonb_build_object('gen', r->'generation', 'docs_changed', r->'documents_changed',
        'run1_status', (SELECT status FROM case_pipeline_runs WHERE id=run1),
        'reg_a_active', (SELECT is_active FROM case_document_redactions WHERE id=reg_a)));

    -- T13 repeating the identical add in a new session doesn't duplicate
    BEGIN PERFORM public.commit_case_edits(cid, gen_random_uuid(), jsonb_build_array(jsonb_build_object('document_filename','ANO_NNCMFAGSSS_22246_b.pdf',
        'changes', jsonb_build_array(jsonb_build_object('action','add','page_number',0,'bbox','{"x0":0.5005,"y0":0.5,"x1":0.6,"y1":0.6}'::jsonb,'style','blackout'))))); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T13', jsonb_build_object('manual_active',
        (SELECT count(*) FROM case_document_redactions WHERE case_id=cid AND source='manual' AND is_active), 'result', err,
        'gen_unchanged', (SELECT content_generation FROM cases WHERE id=cid)));
    -- the case is now at gen 3; run2 got superseded by that no-op-ish save. Use the latest run for T5.
    SELECT id INTO run2 FROM case_pipeline_runs WHERE case_id=cid ORDER BY generation DESC LIMIT 1;

    -- T4 stale run can't write
    r := public.pipeline_begin(run1);
    b := public.pipeline_write_summary(run1, 'STALE', 99, 'Male');
    res := res || jsonb_build_object('T4', jsonb_build_object('current', r->'current', 'status', r->>'status', 'write_applied', b,
        'summary_is_stale', (SELECT summary = 'STALE' FROM cases WHERE id=cid)));

    -- T5 current run completes
    r := public.pipeline_begin(run2);
    b := public.pipeline_mark_step(run2, 'materialize');
    res := res || jsonb_build_object('T5a', jsonb_build_object('begin_current', r->'current', 'mark', b));
    b := public.pipeline_write_summary(run2, 'NEW SUMMARY', NULL, NULL);
    SELECT * INTO c FROM public.cases WHERE id = cid;
    res := res || jsonb_build_object('T5', jsonb_build_object('write_applied', b, 'summary', c.summary, 'status', c.summary_status,
        'summary_gen', c.summary_generation, 'age_kept', c.patient_age,
        'run_status', (SELECT status FROM case_pipeline_runs WHERE id=run2)));

    -- T6 verify: stale generation refused, current accepted
    BEGIN PERFORM public.verify_case_summary(cid, c.content_generation - 1); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    PERFORM public.verify_case_summary(cid, c.content_generation);
    res := res || jsonb_build_object('T6', jsonb_build_object('stale', err,
        'snapshot_has_notes_key', (SELECT verified_snapshot ? 'notes' FROM cases WHERE id=cid),
        'status', (SELECT summary_status FROM cases WHERE id=cid),
        'snapshot_summary', (SELECT verified_snapshot->>'summary' FROM cases WHERE id=cid)));

    -- T12 stranger can't commit
    PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger)::text, true);
    BEGIN PERFORM public.commit_case_edits(cid, gen_random_uuid(), '[]', ARRAY['ANO_NNCMFAGSSS_22246_b.pdf']); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T12', err);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', owner)::text, true);

    -- T7 regenerate, then an edit supersedes it and refunds the cap
    r := public.start_regeneration(cid, run3);
    n := (SELECT summary_regeneration_count FROM cases WHERE id=cid);
    r := public.commit_case_edits(cid, run4, '[]', '{}', '[]', '{"title":"Additional Data","content":"some notes"}');
    res := res || jsonb_build_object('T7', jsonb_build_object('count_after_regen', n,
        'count_after_edit', (SELECT summary_regeneration_count FROM cases WHERE id=cid),
        'regen_status', (SELECT status FROM case_pipeline_runs WHERE id=run3)));

    -- T8 regenerate refused while run4 is in progress
    BEGIN PERFORM public.start_regeneration(cid, gen_random_uuid()); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T8', err);

    -- T5b verify refused while processing
    BEGIN PERFORM public.verify_case_summary(cid, (SELECT content_generation FROM cases WHERE id=cid)); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T5b_verify_while_processing', err);

    -- T9 failure then retry
    PERFORM public.pipeline_begin(run4);
    b := public.pipeline_fail(run4, 'BEDROCK_ERROR', 'Summary generation failed.');
    res := res || jsonb_build_object('T9a', jsonb_build_object('fail_applied', b,
        'status', (SELECT summary_status FROM cases WHERE id=cid)));
    r := public.retry_case_run(cid, run5);
    res := res || jsonb_build_object('T9', jsonb_build_object('kind', r->>'kind', 'gen', r->'generation',
        'status', (SELECT summary_status FROM cases WHERE id=cid)));

    -- T11 redaction on a document without originals
    BEGIN PERFORM public.commit_case_edits(cid, gen_random_uuid(), '[{"document_filename":"ANO_NNCMFAGSSS_22246_zzz.pdf","changes":[{"action":"add","page_number":0,"bbox":{"x0":0,"y0":0,"x1":0.1,"y1":0.1},"style":"whiteout"}]}]'); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T11', err);

    -- T15 uploading a name that already exists
    BEGIN PERFORM public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[{"file_name":"b.docx","size":"1","type":"x"}]'); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T15', err);

    -- T10 removing the last document while notes exist continues; clearing notes too needs archive
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', ARRAY['ANO_NNCMFAGSSS_22246_b.pdf']);
    res := res || jsonb_build_object('T10a_text_only_ok', r->>'status');
    BEGIN PERFORM public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[]', '{"title":"Additional Data","content":"  "}'); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    r := public.commit_case_edits(cid, run6, '[]', '{}', '[]', '{"title":"Additional Data","content":""}', 'archive');
    SELECT * INTO c FROM public.cases WHERE id = cid;
    res := res || jsonb_build_object('T10', jsonb_build_object('without_action', err, 'archived', r->'archived',
        'archived_at_set', c.archived_at IS NOT NULL, 'summary_status', c.summary_status, 'run_summary_done', r->'summary_done'));

    -- T14 stale pending run expires on read
    INSERT INTO public.case_pipeline_runs (id, case_id, generation, kind, status, created_at, updated_at)
    VALUES (gen_random_uuid(), cid, c.content_generation + 1, 'edit', 'pending', now() - interval '5 minutes', now() - interval '5 minutes');
    UPDATE public.cases SET content_generation = content_generation + 1, summary_status = 'processing' WHERE id = cid;
    r := public.get_case_run_state(cid);
    res := res || jsonb_build_object('T14', jsonb_build_object('run_status', r->'run'->>'status', 'code', r->'run'->>'error_code',
        'summary_status', r->>'summary_status'));

    -- T16 anonymize marker
    UPDATE public.cases SET archived_at = NULL WHERE id = cid;
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[{"file_name":"new.pdf","size":"1","type":"application/pdf"}]');
    b := (r->>'anonymize_done')::boolean;
    PERFORM public.pipeline_mark_anonymized('claude-test-req', now());
    res := res || jsonb_build_object('T16', jsonb_build_object('anon_before', b,
        'anon_after', (SELECT anonymize_done FROM case_pipeline_runs WHERE id=(r->>'id')::uuid),
        'report_status', (SELECT report_status FROM cases WHERE id=cid)));

    -- T18 a save that supersedes an unfinished upload run takes its uploads over,
    -- minus any document removed in the same save
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[{"file_name":"up1.pdf","size":"1","type":"application/pdf"},{"file_name":"up2.pdf","size":"1","type":"application/pdf"}]');
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', ARRAY['up2.pdf']);
    res := res || jsonb_build_object('T18', jsonb_build_object('has_uploads', r->'has_uploads', 'upload_files', r->'upload_files',
        'anonymize_done', r->'anonymize_done'));

    -- T19 a removed name re-added with the same file name is carried as live
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', ARRAY['up1.pdf']);
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[{"file_name":"up1.pdf","size":"1","type":"application/pdf"}]');
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[]', '{"title":"Additional Data","content":"notes for T19"}');
    res := res || jsonb_build_object('T19_readded_carried', r->'upload_files');

    -- T20 anonymization integrity: a run whose uploaded document didn't come out
    -- as a PDF fails with its name; one whose uploads all did completes.
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[{"file_name":"t20a.pdf","size":"1","type":"application/pdf"}]');
    PERFORM public.pipeline_begin((r->>'id')::uuid);
    PERFORM public.pipeline_finish_anonymize('claude-test-req', now(), ARRAY['something-else']);
    res := res || jsonb_build_object('T20_missing', (SELECT jsonb_build_object('status', status, 'code', error_code, 'error', error)
        FROM case_pipeline_runs WHERE id = (r->>'id')::uuid));
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[{"file_name":"t20b.pdf","size":"1","type":"application/pdf"}]');
    PERFORM public.pipeline_finish_anonymize('claude-test-req', now(), ARRAY['t20a', 't20b']);
    res := res || jsonb_build_object('T20_complete', (SELECT anonymize_done FROM case_pipeline_runs WHERE id = (r->>'id')::uuid));

    -- T17 re-saving identical notes is not a change
    BEGIN PERFORM public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[]', '{"title":"Additional Data","content":"notes for T19"}'); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T17_same_notes', err);

    -- T21 a manual summary save is refused while a run is processing, and a
    -- save against an older generation is refused once it finished
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[]', '{"title":"Additional Data","content":"notes for T21"}');
    BEGIN PERFORM public.save_case_summary_edit(cid, (r->>'generation')::bigint, 'manual', NULL, 50, 'Female', 'Test'); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    PERFORM public.pipeline_begin((r->>'id')::uuid);
    PERFORM public.pipeline_mark_step((r->>'id')::uuid, 'materialize');
    b := public.pipeline_write_summary((r->>'id')::uuid, 'from run', 50, 'Female');
    res := res || jsonb_build_object('T21', jsonb_build_object('while_processing', err, 'run_wrote', b));
    BEGIN PERFORM public.save_case_summary_edit(cid, (r->>'generation')::bigint - 1, 'manual', NULL, 50, 'Female', 'Test'); err := 'accepted';
    EXCEPTION WHEN OTHERS THEN err := SQLERRM; END;
    res := res || jsonb_build_object('T21_stale', err);

    -- T22 a case archived while its run is active still gets the run's result
    r := public.commit_case_edits(cid, gen_random_uuid(), '[]', '{}', '[]', '{"title":"Additional Data","content":"notes for T22"}');
    UPDATE public.cases SET archived_at = now() WHERE id = cid;
    PERFORM public.pipeline_begin((r->>'id')::uuid);
    PERFORM public.pipeline_mark_step((r->>'id')::uuid, 'materialize');
    b := public.pipeline_write_summary((r->>'id')::uuid, 'archived run', 50, 'Female');
    res := res || jsonb_build_object('T22_archived', jsonb_build_object('wrote', b,
        'run_status', (SELECT status FROM case_pipeline_runs WHERE id = (r->>'id')::uuid),
        'summary', (SELECT summary FROM cases WHERE id = cid)));

    RAISE EXCEPTION 'TEST_RESULTS %', res;
END;
$test$;
