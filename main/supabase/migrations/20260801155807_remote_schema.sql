


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."case_additional_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "document_title" "text" NOT NULL,
    "document_data" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."case_additional_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid",
    "file_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "size" character varying(50),
    "type" character varying(50),
    "storage_path" character varying(500)
);


ALTER TABLE "public"."case_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_follow_ups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "follow_up" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid"
);


ALTER TABLE "public"."case_follow_ups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_opinions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid",
    "user_id" "uuid",
    "opinion_text" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "question_id" "uuid",
    "parent_id" "uuid",
    "mtb_id" "uuid"
);


ALTER TABLE "public"."case_opinions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid",
    "question_text" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."case_questions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_treatment_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "treatment_plan_id" "uuid" NOT NULL,
    "followup_date" "date" NOT NULL,
    "disease_progression_date" "date",
    "current_patient_status" "text",
    "discontinuation_or_ltfu_reason" "text",
    "additional_clinical_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "case_treatment_followups_current_patient_status_check" CHECK (("current_patient_status" = ANY (ARRAY['Alive'::"text", 'Deceased'::"text"])))
);


ALTER TABLE "public"."case_treatment_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_treatment_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "vmtb_discussion_date" "date" NOT NULL,
    "participants" "text"[],
    "consensus_predominant_pathway" "text",
    "consensus_therapy_recommendation" "text",
    "amp_level_of_evidence" "text",
    "escat_level" "text",
    "overall_evidence_strength" "text",
    "is_treatment_implemented" boolean NOT NULL,
    "treatment_initiation_date" "date",
    "treatment_discontinuation_date" "date",
    "treatment_administered" "text",
    "non_implementation_reason" "text",
    "non_implementation_notes" "text",
    "alternative_treatment_plan" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "case_treatment_plans_check" CHECK (((("is_treatment_implemented" = true) AND ("non_implementation_reason" IS NULL)) OR (("is_treatment_implemented" = false) AND ("non_implementation_reason" IS NOT NULL))))
);


ALTER TABLE "public"."case_treatment_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid",
    "case_name" "text" NOT NULL,
    "patient_name" "text",
    "patient_age" integer,
    "patient_sex" "text",
    "cancer_type" "text",
    "summary" "text",
    "treatment_plan" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "summary_status" "text" DEFAULT 'verified'::"text" NOT NULL,
    "request_id" "text",
    "report_status" "text" DEFAULT 'not_ready'::"text",
    "ai_generated_summary" "text" DEFAULT ''::"text"
);


ALTER TABLE "public"."cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "feedback_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'resolved'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."feedback" OWNER TO "postgres";


COMMENT ON TABLE "public"."feedback" IS 'Stores user feedback submissions from the platform';



COMMENT ON COLUMN "public"."feedback"."status" IS 'Feedback status: pending, reviewed, resolved, dismissed';



CREATE TABLE IF NOT EXISTS "public"."meeting_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meeting_session_id" "uuid" NOT NULL,
    "participant_id" "text" NOT NULL,
    "display_name" "text",
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "left_at" timestamp with time zone,
    "duration_seconds" integer,
    "left_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."meeting_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "mtb_id" "uuid" NOT NULL,
    "room_name" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "total_duration_seconds" integer,
    "max_participants" integer DEFAULT 0,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_heartbeat" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "meeting_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'ended'::"text"])))
);


ALTER TABLE "public"."meeting_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mtb_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "mtb_id" "uuid",
    "case_id" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."mtb_cases" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."mtb_meeting_stats" AS
 SELECT "mtb_id",
    "count"(*) AS "total_meetings",
    "count"(
        CASE
            WHEN ("status" = 'ended'::"text") THEN 1
            ELSE NULL::integer
        END) AS "completed_meetings",
    "round"("avg"("total_duration_seconds"), 0) AS "avg_duration_seconds",
    "sum"("total_duration_seconds") AS "total_time_seconds",
    "round"("avg"("max_participants"), 1) AS "avg_participants",
    "max"("max_participants") AS "peak_participants",
    "min"("started_at") AS "first_meeting_at",
    "max"("started_at") AS "last_meeting_at"
   FROM "public"."meeting_sessions"
  WHERE ("status" = 'ended'::"text")
  GROUP BY "mtb_id";


ALTER VIEW "public"."mtb_meeting_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mtb_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "mtb_id" "uuid",
    "user_id" "uuid",
    "joined_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."mtb_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mtbs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "owner_id" "uuid",
    "join_code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "notification_enabled" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."mtbs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."mtbs"."notification_enabled" IS 'Controls whether WhatsApp notifications are sent to members when a meeting is started. Default is TRUE.';



CREATE TABLE IF NOT EXISTS "public"."opinion_answers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "opinion_id" "uuid",
    "question_id" "uuid",
    "answer_text" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."opinion_answers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "profession" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "hospital" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "whatsapp_number" "text",
    "whatsapp_opt_in" boolean DEFAULT false NOT NULL,
    "whatsapp_verified" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."hospital" IS 'Hospital or institution where the user practices';



CREATE TABLE IF NOT EXISTS "public"."whatsapp_otps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone" "text" NOT NULL,
    "otp_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "verified" boolean DEFAULT false NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 5 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."whatsapp_otps" OWNER TO "postgres";


ALTER TABLE ONLY "public"."case_additional_documents"
    ADD CONSTRAINT "case_additional_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_documents"
    ADD CONSTRAINT "case_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_follow_ups"
    ADD CONSTRAINT "case_follow_ups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "case_opinions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_questions"
    ADD CONSTRAINT "case_questions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_treatment_followups"
    ADD CONSTRAINT "case_treatment_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cases"
    ADD CONSTRAINT "cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cases"
    ADD CONSTRAINT "cases_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting_participants"
    ADD CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting_sessions"
    ADD CONSTRAINT "meeting_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mtb_cases"
    ADD CONSTRAINT "mtb_cases_mtb_id_case_id_key" UNIQUE ("mtb_id", "case_id");



ALTER TABLE ONLY "public"."mtb_cases"
    ADD CONSTRAINT "mtb_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mtb_cases"
    ADD CONSTRAINT "mtb_cases_unique" UNIQUE ("mtb_id", "case_id");



ALTER TABLE ONLY "public"."mtb_members"
    ADD CONSTRAINT "mtb_members_mtb_id_user_id_key" UNIQUE ("mtb_id", "user_id");



ALTER TABLE ONLY "public"."mtb_members"
    ADD CONSTRAINT "mtb_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mtb_members"
    ADD CONSTRAINT "mtb_members_unique" UNIQUE ("mtb_id", "user_id");



ALTER TABLE ONLY "public"."mtbs"
    ADD CONSTRAINT "mtbs_join_code_key" UNIQUE ("join_code");



ALTER TABLE ONLY "public"."mtbs"
    ADD CONSTRAINT "mtbs_join_code_unique" UNIQUE ("join_code");



ALTER TABLE ONLY "public"."mtbs"
    ADD CONSTRAINT "mtbs_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."mtbs"
    ADD CONSTRAINT "mtbs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_additional_documents"
    ADD CONSTRAINT "one_document_per_case" UNIQUE ("case_id");



ALTER TABLE ONLY "public"."opinion_answers"
    ADD CONSTRAINT "opinion_answers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "unique_case_treatment_plan" UNIQUE ("case_id");



ALTER TABLE ONLY "public"."whatsapp_otps"
    ADD CONSTRAINT "whatsapp_otps_pkey" PRIMARY KEY ("id");



CREATE INDEX "case_follow_ups_case_id_created_at_idx" ON "public"."case_follow_ups" USING "btree" ("case_id", "created_at" DESC);



CREATE INDEX "idx_case_opinions_case_id" ON "public"."case_opinions" USING "btree" ("case_id");



CREATE INDEX "idx_case_opinions_parent_id" ON "public"."case_opinions" USING "btree" ("parent_id");



CREATE INDEX "idx_case_opinions_question_id" ON "public"."case_opinions" USING "btree" ("question_id");



CREATE INDEX "idx_case_opinions_user_id" ON "public"."case_opinions" USING "btree" ("user_id");



CREATE INDEX "idx_case_treatment_followups_plan_id" ON "public"."case_treatment_followups" USING "btree" ("treatment_plan_id");



CREATE INDEX "idx_case_treatment_plans_case_id" ON "public"."case_treatment_plans" USING "btree" ("case_id");



CREATE INDEX "idx_cases_owner" ON "public"."cases" USING "btree" ("owner_id");



CREATE INDEX "idx_documents_case" ON "public"."case_documents" USING "btree" ("case_id");



CREATE INDEX "idx_feedback_status" ON "public"."feedback" USING "btree" ("status");



CREATE INDEX "idx_feedback_user_id" ON "public"."feedback" USING "btree" ("user_id");



CREATE INDEX "idx_meeting_participants_session_id" ON "public"."meeting_participants" USING "btree" ("meeting_session_id");



CREATE INDEX "idx_meeting_participants_session_left" ON "public"."meeting_participants" USING "btree" ("meeting_session_id", "left_at");



CREATE INDEX "idx_meeting_sessions_mtb_id" ON "public"."meeting_sessions" USING "btree" ("mtb_id");



CREATE INDEX "idx_meeting_sessions_room_status" ON "public"."meeting_sessions" USING "btree" ("room_name", "status");



CREATE INDEX "idx_meeting_sessions_started_at" ON "public"."meeting_sessions" USING "btree" ("started_at");



CREATE INDEX "idx_mtb_owner" ON "public"."mtbs" USING "btree" ("owner_id");



CREATE INDEX "idx_opinions_case" ON "public"."case_opinions" USING "btree" ("case_id");



CREATE INDEX "idx_questions_case" ON "public"."case_questions" USING "btree" ("case_id");



CREATE INDEX "idx_whatsapp_otps_expires" ON "public"."whatsapp_otps" USING "btree" ("expires_at");



CREATE INDEX "idx_whatsapp_otps_phone" ON "public"."whatsapp_otps" USING "btree" ("phone");



-- CREATE OR REPLACE TRIGGER "Case Created Notification" AFTER INSERT ON "public"."mtb_cases" FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"('https://<REMOVED>.supabase.co/functions/v1/notify_case_created', 'POST', '{"Content-type":"application/json","Authorization":"Bearer <REMOVED>"}', '{}', '10000');



-- CREATE OR REPLACE TRIGGER "notify_meeting" AFTER INSERT ON "public"."meeting_sessions" FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"('https://<REMOVED>.supabase.co/functions/v1/notify_meeting', 'POST', '{"Content-type":"application/json","Authorization":"Bearer <REMOVED>"}', '{}', '10000');



-- CREATE OR REPLACE TRIGGER "notify_opinion_added" AFTER INSERT ON "public"."case_opinions" FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"('https://<REMOVED>.supabase.co/functions/v1/notify_opinion_added', 'POST', '{"Content-type":"application/json","Authorization":"Bearer <REMOVED>"}', '{}', '9998');



CREATE OR REPLACE TRIGGER "trg_update_case_treatment_plans_updated_at" BEFORE UPDATE ON "public"."case_treatment_plans" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_feedback_updated_at" BEFORE UPDATE ON "public"."feedback" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_meeting_participants_updated_at" BEFORE UPDATE ON "public"."meeting_participants" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_meeting_sessions_updated_at" BEFORE UPDATE ON "public"."meeting_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."case_additional_documents"
    ADD CONSTRAINT "case_additional_documents_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_documents"
    ADD CONSTRAINT "case_documents_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_follow_ups"
    ADD CONSTRAINT "case_follow_ups_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_follow_ups"
    ADD CONSTRAINT "case_follow_ups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "case_opinions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "case_opinions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_questions"
    ADD CONSTRAINT "case_questions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_treatment_followups"
    ADD CONSTRAINT "case_treatment_followups_treatment_plan_id_fkey" FOREIGN KEY ("treatment_plan_id") REFERENCES "public"."case_treatment_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cases"
    ADD CONSTRAINT "cases_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."feedback"
    ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "fk_case_opinions_mtb" FOREIGN KEY ("mtb_id") REFERENCES "public"."mtbs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "fk_case_opinions_parent" FOREIGN KEY ("parent_id") REFERENCES "public"."case_opinions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "fk_case_opinions_question" FOREIGN KEY ("question_id") REFERENCES "public"."case_questions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_opinions"
    ADD CONSTRAINT "fk_case_opinions_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_participants"
    ADD CONSTRAINT "meeting_participants_meeting_session_id_fkey" FOREIGN KEY ("meeting_session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_sessions"
    ADD CONSTRAINT "meeting_sessions_mtb_id_fkey" FOREIGN KEY ("mtb_id") REFERENCES "public"."mtbs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mtb_cases"
    ADD CONSTRAINT "mtb_cases_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mtb_cases"
    ADD CONSTRAINT "mtb_cases_mtb_id_fkey" FOREIGN KEY ("mtb_id") REFERENCES "public"."mtbs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mtb_members"
    ADD CONSTRAINT "mtb_members_mtb_id_fkey" FOREIGN KEY ("mtb_id") REFERENCES "public"."mtbs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mtb_members"
    ADD CONSTRAINT "mtb_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mtbs"
    ADD CONSTRAINT "mtbs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."opinion_answers"
    ADD CONSTRAINT "opinion_answers_opinion_id_fkey" FOREIGN KEY ("opinion_id") REFERENCES "public"."case_opinions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."opinion_answers"
    ADD CONSTRAINT "opinion_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."case_questions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "MTB members can view MTB cases" ON "public"."mtb_cases" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."mtb_members"
  WHERE (("mtb_members"."mtb_id" = "mtb_cases"."mtb_id") AND ("mtb_members"."user_id" = "auth"."uid"())))));



CREATE POLICY "MTB owner can add cases to MTB" ON "public"."mtb_cases" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."mtbs"
  WHERE (("mtbs"."id" = "mtb_cases"."mtb_id") AND ("mtbs"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Owners can delete own cases" ON "public"."cases" FOR DELETE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Service can insert meeting participants" ON "public"."meeting_participants" FOR INSERT WITH CHECK (true);



CREATE POLICY "Service can insert meeting sessions" ON "public"."meeting_sessions" FOR INSERT WITH CHECK (true);



CREATE POLICY "Service can update meeting participants" ON "public"."meeting_participants" FOR UPDATE USING (true) WITH CHECK (true);



CREATE POLICY "Service can update meeting sessions" ON "public"."meeting_sessions" FOR UPDATE USING (true) WITH CHECK (true);



CREATE POLICY "Users can delete own membership" ON "public"."mtb_members" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert MTB members" ON "public"."mtb_members" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM "public"."mtbs"
  WHERE (("mtbs"."id" = "mtb_members"."mtb_id") AND ("mtbs"."owner_id" = "auth"."uid"()))))));



CREATE POLICY "Users can insert case documents" ON "public"."case_documents" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."cases"
  WHERE (("cases"."id" = "case_documents"."case_id") AND ("cases"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert case questions" ON "public"."case_questions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."cases"
  WHERE (("cases"."id" = "case_questions"."case_id") AND ("cases"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own feedback" ON "public"."feedback" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own MTB" ON "public"."mtbs" FOR INSERT WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "Users can insert their own cases" ON "public"."cases" FOR INSERT WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "Users can insert their own opinions" ON "public"."case_opinions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can update their own cases" ON "public"."cases" FOR UPDATE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view all MTB members" ON "public"."mtb_members" FOR SELECT USING (true);



CREATE POLICY "Users can view all MTBs" ON "public"."mtbs" FOR SELECT USING (true);



CREATE POLICY "Users can view all case documents" ON "public"."case_documents" FOR SELECT USING (true);



CREATE POLICY "Users can view all case questions" ON "public"."case_questions" FOR SELECT USING (true);



CREATE POLICY "Users can view all cases" ON "public"."cases" FOR SELECT USING (true);



CREATE POLICY "Users can view all opinions" ON "public"."case_opinions" FOR SELECT USING (true);



CREATE POLICY "Users can view all profiles" ON "public"."profiles" FOR SELECT USING (true);



CREATE POLICY "Users can view meeting participants for their MTBs" ON "public"."meeting_participants" FOR SELECT USING (("meeting_session_id" IN ( SELECT "ms"."id"
   FROM ("public"."meeting_sessions" "ms"
     JOIN "public"."mtb_members" "mm" ON (("ms"."mtb_id" = "mm"."mtb_id")))
  WHERE ("mm"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can view meeting sessions for their MTBs" ON "public"."meeting_sessions" FOR SELECT USING (("mtb_id" IN ( SELECT "mtb_members"."mtb_id"
   FROM "public"."mtb_members"
  WHERE ("mtb_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "Users can view own feedback" ON "public"."feedback" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."feedback" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";


















GRANT ALL ON TABLE "public"."case_additional_documents" TO "anon";
GRANT ALL ON TABLE "public"."case_additional_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."case_additional_documents" TO "service_role";



GRANT ALL ON TABLE "public"."case_documents" TO "anon";
GRANT ALL ON TABLE "public"."case_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."case_documents" TO "service_role";



GRANT ALL ON TABLE "public"."case_follow_ups" TO "anon";
GRANT ALL ON TABLE "public"."case_follow_ups" TO "authenticated";
GRANT ALL ON TABLE "public"."case_follow_ups" TO "service_role";



GRANT ALL ON TABLE "public"."case_opinions" TO "anon";
GRANT ALL ON TABLE "public"."case_opinions" TO "authenticated";
GRANT ALL ON TABLE "public"."case_opinions" TO "service_role";



GRANT ALL ON TABLE "public"."case_questions" TO "anon";
GRANT ALL ON TABLE "public"."case_questions" TO "authenticated";
GRANT ALL ON TABLE "public"."case_questions" TO "service_role";



GRANT ALL ON TABLE "public"."case_treatment_followups" TO "anon";
GRANT ALL ON TABLE "public"."case_treatment_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."case_treatment_followups" TO "service_role";



GRANT ALL ON TABLE "public"."case_treatment_plans" TO "anon";
GRANT ALL ON TABLE "public"."case_treatment_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."case_treatment_plans" TO "service_role";



GRANT ALL ON TABLE "public"."cases" TO "anon";
GRANT ALL ON TABLE "public"."cases" TO "authenticated";
GRANT ALL ON TABLE "public"."cases" TO "service_role";



GRANT ALL ON TABLE "public"."feedback" TO "anon";
GRANT ALL ON TABLE "public"."feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."feedback" TO "service_role";



GRANT ALL ON TABLE "public"."meeting_participants" TO "anon";
GRANT ALL ON TABLE "public"."meeting_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_participants" TO "service_role";



GRANT ALL ON TABLE "public"."meeting_sessions" TO "anon";
GRANT ALL ON TABLE "public"."meeting_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."mtb_cases" TO "anon";
GRANT ALL ON TABLE "public"."mtb_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."mtb_cases" TO "service_role";



GRANT ALL ON TABLE "public"."mtb_meeting_stats" TO "anon";
GRANT ALL ON TABLE "public"."mtb_meeting_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."mtb_meeting_stats" TO "service_role";



GRANT ALL ON TABLE "public"."mtb_members" TO "anon";
GRANT ALL ON TABLE "public"."mtb_members" TO "authenticated";
GRANT ALL ON TABLE "public"."mtb_members" TO "service_role";



GRANT ALL ON TABLE "public"."mtbs" TO "anon";
GRANT ALL ON TABLE "public"."mtbs" TO "authenticated";
GRANT ALL ON TABLE "public"."mtbs" TO "service_role";



GRANT ALL ON TABLE "public"."opinion_answers" TO "anon";
GRANT ALL ON TABLE "public"."opinion_answers" TO "authenticated";
GRANT ALL ON TABLE "public"."opinion_answers" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."whatsapp_otps" TO "anon";
GRANT ALL ON TABLE "public"."whatsapp_otps" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_otps" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































