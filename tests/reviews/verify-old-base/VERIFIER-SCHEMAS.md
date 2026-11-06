# Verifier schema audit

Source: `2c85dda1aa4e8973c7332075d1015b3c642c36f7`; 109 SQL files. PostgreSQL 17.6, disposable databases, READ ONLY execution at 013, 083, 137, 144, 150 and151. No production or real data.

Only release_preflight.sql is changed. It is intended to span versions: before084, literal regclass casts for integration_connections/integration_sends throw42P01 instead of reporting later releases absent. Replaced literal catalog lookups with to_regclass/to_regprocedure in that one script. Dedicated post-migration verifiers are unchanged: running one below its minimum may return false/null or raise a missing-object error, and neither is a pass.

“Minimum” is the supported contract, not a claim that all rows pass on later versions. Prechecks can deliberately refuse already-applied versions. Generic catalogue/data audits conservatively support013; earlier versions are not claimed. Only six representative stages were executed, not each exact minimum.

Legacy reconciliation source requires the separate legacy JNREng schema (quote quantity/unit_price columns). Target requires import_legacy_tenant.sql and legacy_audit_log. Their failures on an unimported fresh Tolra schema are expected profile mismatches; no legacy fixture or real data was supplied. They remain unverified on their intended profile.

## Reproduction

`VERIFY_AUDIT_SOURCE_ROOT=/workspace/work/fix-151-verifier VERIFY_AUDIT_OUTPUT=/tmp/verify-before.json node tests/reviews/verify-old-base/audit.cjs` reproduces the unchanged baseline.

`VERIFY_AUDIT_OUTPUT=/tmp/verify-after.json node tests/reviews/verify-old-base/audit.cjs` runs the fixed working tree. Requires this task’s disposable PostgreSQL on loopback54849, rolexero_test; it creates/deletes only nonce databases.

`npx vitest run --config tests/reviews/verify-old-base/vitest.db.config.ts` executes the old-base regression plus final-schema missing-required-table checks. A missing required table must never turn into an all-true result.

## Matrix

| Stage | Before: executed / errors | After: executed / errors | Genuine supported-schema execution defects |
|---|---:|---:|---|
| 013 | 41 / 68 | 42 / 67 | release_preflight.sql, fixed |
| 083 | 80 / 29 | 81 / 28 | release_preflight.sql, fixed |
| 137 | 94 / 15 | 94 / 15 | none; missing later releases or external legacy profile |
| 144 | 99 / 10 | 99 / 10 | none; missing later releases or external legacy profile |
| 150 | 106 / 3 | 106 / 3 | none; missing later releases or external legacy profile |
| 151 | 107 / 2 | 107 / 2 | none; missing later releases or external legacy profile |

## Minimum supported schema for every verifier

| Verifier | Minimum/profile | Basis/window |
|---|---|---|
| `072_customer_signoff.sql` | 072 | 072 applied (later-schema readiness is not claimed below this version) |
| `accountant_invite_129.sql` | 129 | 129 applied (later-schema readiness is not claimed below this version) |
| `accounting_connections_144.sql` | 144 | 144 applied (later-schema readiness is not claimed below this version) |
| `activity_labels_080.sql` | 080 | 080 applied (later-schema readiness is not claimed below this version) |
| `activity_one_row_per_change_094.sql` | 094 | 094 applied (later-schema readiness is not claimed below this version) |
| `admin_mfa_onboarding_065.sql` | 065 | 065 applied (later-schema readiness is not claimed below this version) |
| `ai_assistant_134.sql` | 134 | 134 applied (later-schema readiness is not claimed below this version) |
| `ai_assistant_134_prod_off_check.sql` | 134 | 134 applied (later-schema readiness is not claimed below this version) |
| `ai_cap_key_off_150.sql` | 150 | 150 applied (later-schema readiness is not claimed below this version) |
| `ai_finance_check_audit_events_095.sql` | 095 | 095 applied (later-schema readiness is not claimed below this version) |
| `ai_helper_101.sql` | 101 | 101 applied (later-schema readiness is not claimed below this version) |
| `ai_helper_cap_default_122.sql` | 122 | 122 applied (later-schema readiness is not claimed below this version) |
| `ai_helper_pre_enable_133.sql` | 133 | 133 applied (later-schema readiness is not claimed below this version) |
| `ai_helper_service_role_103.sql` | 103 | 103 applied (later-schema readiness is not claimed below this version) |
| `attendance_050.sql` | 050 | 050 applied (later-schema readiness is not claimed below this version) |
| `attendance_expected_company_090.sql` | 090 | 090 applied (later-schema readiness is not claimed below this version) |
| `audit_hash_077.sql` | 077 | 077 applied (later-schema readiness is not claimed below this version) |
| `authorised_inspectors_083.sql` | 083 | 083 applied (later-schema readiness is not claimed below this version) |
| `auto_book_next_free.sql` | 061 | 061 applied (later-schema readiness is not claimed below this version) |
| `ban_ends_session_119.sql` | 119 | 119 applied (later-schema readiness is not claimed below this version) |
| `bench_pause.sql` | 046 | 046 applied (later-schema readiness is not claimed below this version) |
| `booking_day_plan.sql` | 038 | 038 applied (later-schema readiness is not claimed below this version) |
| `booking_run_identity.sql` | 064 | 064 applied (later-schema readiness is not claimed below this version) |
| `booking_time_zero_quote_126.sql` | 126 | 126 applied (later-schema readiness is not claimed below this version) |
| `browser_error_alert_115.sql` | 115 | 115 applied (later-schema readiness is not claimed below this version) |
| `catalogue.sql` | 013 | 013 applied (later-schema readiness is not claimed below this version) |
| `chase_steps_138.sql` | 138 | 138 applied (later-schema readiness is not claimed below this version) |
| `clock_in_network_lock_114.sql` | 114 | 114 applied (later-schema readiness is not claimed below this version) |
| `company_access_066.sql` | 066 | 066 applied (later-schema readiness is not claimed below this version) |
| `company_setup_145.sql` | 145 | 145 applied (later-schema readiness is not claimed below this version) |
| `converted_sales_order_088.sql` | 088 | 088 applied (later-schema readiness is not claimed below this version) |
| `costing_rates_143.sql` | 143 | 143 applied (later-schema readiness is not claimed below this version) |
| `cross_org_links.sql` | 013 | 013 applied (later-schema readiness is not claimed below this version) |
| `customer_archive_100.sql` | 100 | 100 applied (later-schema readiness is not claimed below this version) |
| `dashboard_tiles_132.sql` | 132 | 132 applied (later-schema readiness is not claimed below this version) |
| `data_import_076.sql` | 076 | 076 applied (later-schema readiness is not claimed below this version) |
| `data_import_credit_delivery_085.sql` | 085 | 085 applied (later-schema readiness is not claimed below this version) |
| `delivery_note_auto_invoice.sql` | 059 | 059 applied (later-schema readiness is not claimed below this version) |
| `document_attachments_067.sql` | 067 | 067 applied (later-schema readiness is not claimed below this version) |
| `document_totals.sql` | 013 | 013 applied (later-schema readiness is not claimed below this version) |
| `duplicate_conversions.sql` | 018 | 018 applied (later-schema readiness is not claimed below this version) |
| `email_history_drafted_by_120.sql` | 120 | 120 applied (later-schema readiness is not claimed below this version) |
| `email_schedules_108.sql` | 108 | 108 applied (later-schema readiness is not claimed below this version) |
| `email_templates_106.sql` | 106 | 106 applied (later-schema readiness is not claimed below this version) |
| `import_safeupdate_079.sql` | 079 | 079 applied (later-schema readiness is not claimed below this version) |
| `import_source_ref_140.sql` | 140 | 140 applied (later-schema readiness is not claimed below this version) |
| `inbound_email_links_125.sql` | 125 | 125 applied (later-schema readiness is not claimed below this version) |
| `integrations_084.sql` | 084 | 084 applied (later-schema readiness is not claimed below this version) |
| `integrations_connect_107.sql` | 107 | 107 applied (later-schema readiness is not claimed below this version) |
| `internal_jobs_and_machines.sql` | 042 | 042 applied (later-schema readiness is not claimed below this version) |
| `invoice_issue_guard_091.sql` | 091 | 091 applied (later-schema readiness is not claimed below this version) |
| `invoice_payments_032.sql` | 032 | 032 applied (later-schema readiness is not claimed below this version) |
| `invoice_receipt_guard_089.sql` | 089 | 089 applied (later-schema readiness is not claimed below this version) |
| `invoice_screen_073.sql` | 073 | 073 applied (later-schema readiness is not claimed below this version) |
| `invoice_write_off_105.sql` | 105 | 105 applied (later-schema readiness is not claimed below this version) |
| `ip_retention_crd_078.sql` | 078 | 078 applied (later-schema readiness is not claimed below this version) |
| `job_delivery_note_147.sql` | 147 | 147 applied (later-schema readiness is not claimed below this version) |
| `job_flow_081.sql` | 081 | 081 applied (later-schema readiness is not claimed below this version) |
| `job_labour_051.sql` | 051 | 051 applied (later-schema readiness is not claimed below this version) |
| `job_part_logs_118.sql` | 118 | 118 applied (later-schema readiness is not claimed below this version) |
| `job_photos_040.sql` | 040 | 040 applied (later-schema readiness is not claimed below this version) |
| `job_problems_117.sql` | 117 | 117 applied (later-schema readiness is not claimed below this version) |
| `job_profitability_actuals_148.sql` | 148 | 148 applied (later-schema readiness is not claimed below this version) |
| `job_signoff.sql` | 045 | 045 applied (later-schema readiness is not claimed below this version) |
| `job_spec_customer_po_135.sql` | 135 | 135 applied (later-schema readiness is not claimed below this version) |
| `job_spec_customer_po_135_precheck.sql` | 080 | 080–134 expected conversion body;135 already applied must refuse |
| `machine_runs.sql` | 044 | 044 applied (later-schema readiness is not claimed below this version) |
| `mailbox_read_127.sql` | 127 | 127 applied (later-schema readiness is not claimed below this version) |
| `n2_tolra_provided_ai.sql` | 146 | 146 applied (later-schema readiness is not claimed below this version) |
| `n5_company_setup.sql` | 145 | 145 applied (later-schema readiness is not claimed below this version) |
| `opening_wip_141.sql` | 141 | 141 applied (later-schema readiness is not claimed below this version) |
| `overview_owed_snapshots_116.sql` | 116 | 116 applied (later-schema readiness is not claimed below this version) |
| `part_despatch_invoice_quantity_099.sql` | 099 | 099 applied (later-schema readiness is not claimed below this version) |
| `password_change_ticket_137.sql` | 137 | 137 applied (later-schema readiness is not claimed below this version) |
| `paused_machine_ack.sql` | 049 | 049 applied (later-schema readiness is not claimed below this version) |
| `platform_create_organization.sql` | 039 | 039 applied (later-schema readiness is not claimed below this version) |
| `prelaunch_033.sql` | 033 | 033 applied (later-schema readiness is not claimed below this version) |
| `protect_platform_owner_login_093.sql` | 093 | 093 applied (later-schema readiness is not claimed below this version) |
| `purchase_order_link_124.sql` | 124 | 124 applied (later-schema readiness is not claimed below this version) |
| `quote_customer_po_123.sql` | 123 | 123 applied (later-schema readiness is not claimed below this version) |
| `quote_to_job.sql` | 058 | 058 applied (later-schema readiness is not claimed below this version) |
| `quote_versions_068.sql` | 068 | 068 applied (later-schema readiness is not claimed below this version) |
| `recent_second_step_136.sql` | 136 | 136 applied (later-schema readiness is not claimed below this version) |
| `reconcile_legacy_source.sql` | legacy-source | Legacy JNREng quote quantity/unit_price columns |
| `reconcile_legacy_target.sql` | imported-target | Tolra target after supabase/import/import_legacy_tenant.sql creates legacy_audit_log |
| `release_ends_session_092.sql` | 092 | 092 applied (later-schema readiness is not claimed below this version) |
| `release_preflight.sql` | 013 | 013 applied (later-schema readiness is not claimed below this version) |
| `reopen_requests_113.sql` | 113 | 113 applied (later-schema readiness is not claimed below this version) |
| `rework_037.sql` | 037 | 037 applied (later-schema readiness is not claimed below this version) |
| `rfq_clarification_110.sql` | 110 | 110 applied (later-schema readiness is not claimed below this version) |
| `rls_helper_speed_121.sql` | 121 | 121 applied (later-schema readiness is not claimed below this version) |
| `rls_select_wrap_131.sql` | 131 | 131 applied (later-schema readiness is not claimed below this version) |
| `rls_select_wrap_131_precheck.sql` | 130 | 130 before131 or131 already-applied policy text |
| `sales_order_machines.sql` | 043 | 043 applied (later-schema readiness is not claimed below this version) |
| `security_guards_102.sql` | 102 | 102 applied (later-schema readiness is not claimed below this version) |
| `site_network_075.sql` | 075 | 075 applied (later-schema readiness is not claimed below this version) |
| `time_day_flags_074.sql` | 074 | 074 applied (later-schema readiness is not claimed below this version) |
| `time_week_review_052.sql` | 052 | 052 applied (later-schema readiness is not claimed below this version) |
| `tolra_provided_ai_146.sql` | 146 | 146 applied (later-schema readiness is not claimed below this version) |
| `traceability_082.sql` | 082 | 082 applied (later-schema readiness is not claimed below this version) |
| `two_level_access_036.sql` | 036 | 036 applied (later-schema readiness is not claimed below this version) |
| `unmarked_bans.sql` | 013 | 013 applied (later-schema readiness is not claimed below this version) |
| `user_date_format_109.sql` | 109 | 109 applied (later-schema readiness is not claimed below this version) |
| `vat_registration_030.sql` | 030 | 030 applied (later-schema readiness is not claimed below this version) |
| `who_did_what_035.sql` | 035 | 035 applied (later-schema readiness is not claimed below this version) |
| `workflow_034.sql` | 034 | 034 applied (later-schema readiness is not claimed below this version) |
| `workshop_network_128.sql` | 128 | 128 applied (later-schema readiness is not claimed below this version) |
| `xero_invite_hardening_151.sql` | 151 | 151 applied (later-schema readiness is not claimed below this version) |
| `xero_launch_hold_149.sql` | 149 | 149 applied (later-schema readiness is not claimed below this version) |

Detailed SQLSTATEs, messages, file hashes and per-stage classification: evidence/before.json, after.json and classification.json. No dedicated verifier was altered to make an unsupported old schema pass.
