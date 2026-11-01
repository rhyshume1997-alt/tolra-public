-- Seed for migration 132's proof and parity fixture (tests/scripts/sql/132_dashboard_tile_figures.proof.sql and .fixture.sql). No
-- transaction of its own: the caller's BEGIN ... ROLLBACK keeps nothing. Two companies (Alpha, Beta) and four signed-in people:
-- Alpha admin, Alpha office with Quotes hidden, Alpha workshop, Beta admin. The rows are the awkward cases each rule has to get right:
-- statuses in any case, padded with spaces (and a no-break space), blank or unknown; quotes sent just before midnight UTC, accepted at
-- 23:30 UTC on the last day of September (1 October in London); versions "v2"; RFQs linked or marked quoted in another case; invoices
-- over-paid, credited, refunded, due today, with no due date, payment to confirm; and many pence amounts whose sum is not exact in
-- binary (so the money-owed total proves the same order of adding). The dates the figures are counted on are fixed:
-- today 2026-10-20, first of the month 2026-10-01, 90 days ago 2026-07-22.
-- Rows go in with the triggers off (session_replication_role = replica, as an import does), so statuses the app now refuses can be
-- seeded the way older or imported rows hold them.
SET LOCAL session_replication_role = replica;
INSERT INTO public.organizations(id, name, slug) VALUES
  ('a0000000-0000-0000-0000-000000000132', 'Alpha 132', 'alpha-132'), ('b0000000-0000-0000-0000-000000000132', 'Beta 132', 'beta-132');
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-0000000001a1', 'admin.a132@example.test'), ('a0000000-0000-0000-0000-0000000001a2', 'office.a132@example.test'),
  ('a0000000-0000-0000-0000-0000000001a3', 'workshop.a132@example.test'), ('b0000000-0000-0000-0000-0000000001b1', 'admin.b132@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id, active, must_change_password) VALUES
  ('a0000000-0000-0000-0000-0000000001a1', 'admin.a132@example.test', 'admin', 'a0000000-0000-0000-0000-000000000132', TRUE, FALSE),
  ('a0000000-0000-0000-0000-0000000001a2', 'office.a132@example.test', 'office', 'a0000000-0000-0000-0000-000000000132', TRUE, FALSE),
  ('a0000000-0000-0000-0000-0000000001a3', 'workshop.a132@example.test', 'workshop', 'a0000000-0000-0000-0000-000000000132', TRUE, FALSE),
  ('b0000000-0000-0000-0000-0000000001b1', 'admin.b132@example.test', 'admin', 'b0000000-0000-0000-0000-000000000132', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = TRUE, must_change_password = FALSE;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections, active) VALUES
  ('a0000000-0000-0000-0000-0000000001a1', 'a0000000-0000-0000-0000-000000000132', 'admin', '{}', TRUE),
  ('a0000000-0000-0000-0000-0000000001a2', 'a0000000-0000-0000-0000-000000000132', 'office', '{quotes}', TRUE),
  ('a0000000-0000-0000-0000-0000000001a3', 'a0000000-0000-0000-0000-000000000132', 'workshop', '{}', TRUE),
  ('b0000000-0000-0000-0000-0000000001b1', 'b0000000-0000-0000-0000-000000000132', 'admin', '{}', TRUE);

-- RFQs (Alpha 6, Beta 2). Outstanding for Alpha: r1 (blank), r2 (null), r3 'new', r5 'Quoted' (case matters: not 'quoted') = 4.
INSERT INTO public.rfqs(id, organization_id, customer, status) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000132', 'Acme', ''),
  ('a5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000132', 'Acme', NULL),
  ('a5000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000132', 'Acme', 'new'),
  ('a5000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000132', 'Acme', 'quoted'),
  ('a5000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000132', 'Acme', 'Quoted'),
  ('a5000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000132', 'Acme', 'clarification'),
  ('b5000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000132', 'Other', 'new'),
  ('b5000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000132', 'Other', 'new');

-- Quotes. Alpha: q01..q20; Beta: two sent quotes for 999.99 and one accepted this month.
INSERT INTO public.quotes(id, organization_id, quote_ref, version, customer, status, valid_until, total_value, vat_enabled, sent_at, accepted_at, rfq_id, created_at) VALUES
  -- open (sent, still valid): q01 350.00, q02 0.10, q03 0.20, q04 1234567.89, q16 "QUO-0100" v1, q17 "QUO-0100 v2" v2 -> 6 open
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000132', 'QUO-0001', 1, 'Acme', 'sent', '2026-11-30', 350.00, TRUE, '2026-10-05 10:00+00', NULL, NULL, '2026-10-05 09:00+00'),
  ('a1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000132', 'QUO-0002', 1, 'Acme', 'SENT', '2026-10-20', 0.10, TRUE, '2026-09-30 23:30+00', NULL, NULL, '2026-09-30 09:00+00'),
  ('a1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000132', 'QUO-0003', 1, 'Acme', 'sent', NULL, 0.20, TRUE, '2026-10-01 00:00+00', NULL, 'a5000000-0000-0000-0000-000000000006', '2026-10-01 00:00+00'),
  ('a1000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000132', 'QUO-0004', 1, 'Acme', 'sent', '2027-01-01', 1234567.89, TRUE, '2026-07-22 00:00+00', NULL, NULL, '2026-07-21 00:00+00'),
  -- expired after being sent (sent, past valid_until): q05, sent 2026-08-10, so it is in the 90 days
  ('a1000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000132', 'QUO-0005', 1, 'Acme', 'sent', '2026-10-19', 500.00, TRUE, '2026-08-10 12:00+00', NULL, NULL, '2026-08-10 12:00+00'),
  -- expired draft (never sent): q06
  ('a1000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000132', 'QUO-0006', 1, 'Acme', 'draft', '2026-10-01', 75.00, TRUE, NULL, NULL, NULL, '2026-09-01 12:00+00'),
  -- 'Accepted ' (trailing space): a draft to quoteFigures (no trim), but won to quotesWon (trimmed); accepted 2026-10-02
  ('a1000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000132', 'QUO-0007', 1, 'Acme', 'Accepted ', '2026-12-01', 10.00, TRUE, '2026-09-20 12:00+00', '2026-10-02 12:00+00', NULL, '2026-09-20 12:00+00'),
  -- 'ACCEPTED' at 23:30 UTC on 30 September = 1 October in London: won this month; linked to r4 (marked quoted anyway)
  ('a1000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000132', 'QUO-0008', 1, 'Acme', 'ACCEPTED', '2026-09-01', 120.00, TRUE, '2026-08-01 12:00+00', '2026-09-30 23:30+00', 'a5000000-0000-0000-0000-000000000004', '2026-08-01 12:00+00'),
  -- accepted with no date: undated
  ('a1000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000132', 'QUO-0009', 1, 'Acme', 'accepted', NULL, 40.00, TRUE, '2026-07-01 12:00+00', NULL, NULL, '2026-07-01 12:00+00'),
  -- accepted in September (London 30 Sep 22:30 UTC = 23:30 BST): not this month
  ('a1000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000132', 'QUO-0010', 1, 'Acme', 'accepted', NULL, 60.00, TRUE, '2026-09-01 12:00+00', '2026-09-30 22:30+00', NULL, '2026-09-01 12:00+00'),
  ('a1000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000132', 'QUO-0011', 1, 'Acme', 'rejected', '2026-12-01', 80.00, TRUE, '2026-09-01 12:00+00', NULL, NULL, '2026-09-01 12:00+00'),
  ('a1000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000132', 'QUO-0012', 1, 'Acme', 'superseded', '2026-12-01', 90.00, TRUE, '2026-10-03 12:00+00', NULL, NULL, '2026-10-03 12:00+00'),
  -- blank and unknown statuses: drafts
  ('a1000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000132', 'QUO-0013', 1, 'Acme', '', '2026-12-01', 15.00, TRUE, NULL, NULL, NULL, '2026-10-01 12:00+00'),
  ('a1000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000132', 'QUO-0014', 1, 'Acme', NULL, '2026-12-01', 16.00, TRUE, NULL, NULL, NULL, '2026-10-01 12:00+00'),
  ('a1000000-0000-0000-0000-000000000015', 'a0000000-0000-0000-0000-000000000132', 'QUO-0015', 1, 'Acme', 'weird', '2026-12-01', 17.00, TRUE, '2026-10-04 12:00+00', NULL, NULL, '2026-10-04 12:00+00'),
  -- versions: QUO-0100 and "QUO-0100 v2" (below; one quote this month); "QUO-0101 v3" at version 1 keeps its name; '' counts on its own
  ('a1000000-0000-0000-0000-000000000016', 'a0000000-0000-0000-0000-000000000132', 'QUO-0100', 1, 'Acme', 'sent', '2026-12-01', 100.00, TRUE, '2026-10-02 12:00+00', NULL, NULL, '2026-10-02 12:00+00'),
  ('a1000000-0000-0000-0000-000000000018', 'a0000000-0000-0000-0000-000000000132', 'QUO-0101 v3', 1, 'Acme', 'draft', '2026-12-01', 5.00, TRUE, '2026-10-06 12:00+00', NULL, NULL, '2026-10-06 12:00+00'),
  ('a1000000-0000-0000-0000-000000000019', 'a0000000-0000-0000-0000-000000000132', '', 1, 'Acme', 'draft', '2026-12-01', 5.00, TRUE, '2026-10-07 12:00+00', NULL, NULL, '2026-10-07 12:00+00'),
  ('a1000000-0000-0000-0000-000000000020', 'a0000000-0000-0000-0000-000000000132', 'QUO-0102', 1, 'Acme', 'draft', '2026-12-01', 5.00, TRUE, '2026-10-08 12:00+00', NULL, NULL, '2026-10-08 12:00+00'),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000132', 'QUO-B1', 1, 'Other', 'sent', '2026-12-01', 999.99, TRUE, '2026-10-05 12:00+00', NULL, 'b5000000-0000-0000-0000-000000000001', '2026-10-05 12:00+00'),
  ('b1000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000132', 'QUO-B2', 1, 'Other', 'sent', '2026-12-01', 999.99, TRUE, '2026-10-05 12:00+00', NULL, NULL, '2026-10-05 12:00+00'),
  ('b1000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000132', 'QUO-B3', 1, 'Other', 'accepted', NULL, 999.99, TRUE, '2026-10-05 12:00+00', '2026-10-06 12:00+00', NULL, '2026-10-05 12:00+00');
-- "QUO-0100 v2": version 2 of q16 (068's chain: a later version names the one before it).
INSERT INTO public.quotes(id, organization_id, quote_ref, version, previous_version_id, customer, status, valid_until, total_value, vat_enabled, sent_at, accepted_at, rfq_id, created_at) VALUES
  ('a1000000-0000-0000-0000-000000000017', 'a0000000-0000-0000-0000-000000000132', 'QUO-0100 v2', 2, 'a1000000-0000-0000-0000-000000000016', 'Acme', 'sent', '2026-12-01', 110.00, TRUE, '2026-10-03 12:00+00', NULL, NULL, '2026-10-03 12:00+00');
-- A declined line on an accepted quote (068): the page reads these; no tile shows the accepted value, so no figure moves.
INSERT INTO public.quote_line_items(id, organization_id, quote_id, description, quantity, unit_price, vat_pct, vat_exempt, declined) VALUES
  ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000132', 'a1000000-0000-0000-0000-000000000009', 'Declined part', 1, 10.00, 20, FALSE, TRUE);

-- Invoices. Alpha i01..i20 + 40 small ones; Beta one big one.
INSERT INTO public.invoices(id, organization_id, invoice_ref, customer, status, total, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000132', 'INV-01', 'Acme', 'issued', 120.10, 0, 0, 0, '2026-10-25', FALSE),          -- not due
  ('a2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000132', 'INV-02', 'Acme', 'Partial', 200.00, 50.05, 0, 0, '2026-10-10', FALSE),     -- 10 late: 149.95
  ('a2000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000132', 'INV-03', 'Acme', ' sent ', 80.00, 0, 0, 0, '2026-09-10', FALSE),           -- 40 late
  ('a2000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000132', 'INV-04', 'Acme', 'overdue', 100.00, 20.00, 10.00, 2.50, '2026-07-01', FALSE), -- 111 late: 72.50
  ('a2000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000132', 'INV-05', 'Acme', 'draft', 999.00, 0, 0, 0, '2026-01-01', FALSE),           -- closed
  ('a2000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000132', 'INV-06', 'Acme', '  ', 999.00, 0, 0, 0, '2026-01-01', FALSE),              -- blank = draft
  ('a2000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000132', 'INV-07', 'Acme', NULL, 999.00, 0, 0, 0, '2026-01-01', FALSE),              -- null: not read
  ('a2000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000132', 'INV-08', 'Acme', 'issued', 300.00, 0, 0, 0, '2026-01-01', TRUE),           -- to confirm
  ('a2000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000132', 'INV-09', 'Acme', 'draft', 300.00, 0, 0, 0, NULL, TRUE),                    -- to confirm
  ('a2000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000132', 'INV-10', 'Acme', 'Paid', 400.00, 0, 0, 0, '2026-01-01', FALSE),            -- paid (any case)
  ('a2000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000132', 'INV-11', 'Acme', 'paid', 400.00, 400.00, 0, 0, '2026-01-01', FALSE),       -- not read
  ('a2000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000132', 'INV-12', 'Acme', 'issued', 50.00, 75.00, 0, 0, '2026-10-01', FALSE),       -- over-paid: 0
  ('a2000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000132', 'INV-13', 'Acme', 'void', 999.00, 0, 0, 0, '2026-01-01', FALSE),
  ('a2000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000132', 'INV-14', 'Acme', 'written_off', 999.00, 0, 0, 0, '2026-01-01', FALSE),
  ('a2000000-0000-0000-0000-000000000015', 'a0000000-0000-0000-0000-000000000132', 'INV-15', 'Acme', 'Credited', 999.00, 0, 0, 0, '2026-01-01', FALSE),
  ('a2000000-0000-0000-0000-000000000016', 'a0000000-0000-0000-0000-000000000132', 'INV-16', 'Acme', 'issued', 33.33, 0, 0, 0, NULL, FALSE),                   -- no due date
  ('a2000000-0000-0000-0000-000000000017', 'a0000000-0000-0000-0000-000000000132', 'INV-17', 'Acme', 'issued', 44.44, 0, 0, 0, '2026-10-20', FALSE),           -- due today
  ('a2000000-0000-0000-0000-000000000018', 'a0000000-0000-0000-0000-000000000132', 'INV-18', 'Acme', E'\u00a0draft\u00a0', 999.00, 0, 0, 0, '2026-01-01', FALSE), -- no-break spaces: draft
  ('a2000000-0000-0000-0000-000000000019', 'a0000000-0000-0000-0000-000000000132', 'INV-19', 'Acme', 'issued', 61.00, 0, 0, 0, '2026-08-20', FALSE),           -- 61 late
  ('a2000000-0000-0000-0000-000000000020', 'a0000000-0000-0000-0000-000000000132', 'INV-20', 'Acme', 'issued', 60.00, 0, 0, 0, '2026-08-21', FALSE),           -- 60 late
  ('b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000132', 'INV-B1', 'Other', 'issued', 5000.00, 0, 0, 0, '2026-01-01', FALSE);
-- 40 small invoices of 0.10, 0.20, 0.30 or 0.70 (their sum in binary is not exact), ids in a scrambled order so "id order" matters.
INSERT INTO public.invoices(id, organization_id, invoice_ref, customer, status, total, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified)
SELECT md5('132-small-' || g)::uuid, 'a0000000-0000-0000-0000-000000000132', 'INV-S' || g, 'Small', 'issued', (ARRAY[0.10, 0.20, 0.30, 0.70])[1 + g % 4], 0, 0, 0,
       DATE '2026-10-20' - (g * 3), FALSE
FROM generate_series(1, 40) g;
SET LOCAL session_replication_role = origin;
