-- =====================================================================================
-- DEMO / STAGING ONLY. NEVER load this into a production tenant.
--
-- Defines public.load_demo_documents(p_org uuid): loads two invented sample customers and their paperwork
-- (quotes QUO-0101 and QUO-0102, customer orders PO-TEST-1 and PO-TEST-2, invoices INV-0101 and INV-0102, delivery
-- notes DLN-0101 and DLN-0102, jobs J-0101 and J-0102) into ONE organisation. Every name, part number, price and
-- date is synthetic (example.* addresses). Totals (20% VAT, rounded per line):
--   QUO-0101 / INV-0101   subtotal 3,617.71  VAT   723.55  total  4,341.26
--   QUO-0102 / INV-0102   subtotal 1,989.82  VAT   397.96  total  2,387.78
--
-- Usage (SQL editor as the project owner, after migrations 000 - 007 and after the organisation exists):
--   1. Run this file once (it only defines the function).
--   2. select public.load_demo_documents((select id from public.organizations where slug = 'my-demo-tenant'));
--   3. Safe to run again: every insert is guarded by the document's reference number (customer name,
--      quote_ref, so_number, invoice_ref, dn_number, job_no) and line items are only added to a document
--      that has none. Nothing is updated or deleted.
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.load_demo_documents(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $demo$
DECLARE
  org uuid := p_org;
BEGIN
  IF org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = org) THEN
    RAISE EXCEPTION 'load_demo_documents: organisation % does not exist (create it with public.create_organization first)', org;
  END IF;

  -- Customers ---------------------------------------------------------------------------
  INSERT INTO customers (organization_id, name, contact_name, email, phone, address, notes)
  SELECT org, 'Clydeside Pump Services Ltd', 'Accounts Payable', 'accounts@clydesidepumps.example', '0141 000 0001', E'1 Example Road\nExample Business Park\nGlasgow\nG1 1AA', 'Invoices to be emailed to accounts@clydesidepumps.example. Quote the PO number on all paperwork. '
  WHERE NOT EXISTS (SELECT 1 FROM customers WHERE organization_id = org AND name = 'Clydeside Pump Services Ltd');

  INSERT INTO customers (organization_id, name, contact_name, email, phone, address, notes)
  SELECT org, 'Northfield Industrial Supplies Ltd', NULL, 'orders@northfieldsupplies.example', '01698 000 0002', E'Unit 2, Example Trading Estate\nHamilton\nML3 1AA', 'Customer collects (uplift).'
  WHERE NOT EXISTS (SELECT 1 FROM customers WHERE organization_id = org AND name = 'Northfield Industrial Supplies Ltd');

  -- Quotes and their line items --------------------------------------------------------
  INSERT INTO quotes (organization_id, quote_ref, customer, description, total_value, status, valid_until, customer_notes, created_at)
  SELECT org, 'QUO-0102', 'Northfield Industrial Supplies Ltd', '8 line quote for Northfield Industrial Supplies Ltd', 2387.78, 'accepted', '2026-08-04', 'Quotation valid for 7 days. Prices are based on all parts being ordered. Please quote our reference.', '2026-07-21'::date
  WHERE NOT EXISTS (SELECT 1 FROM quotes WHERE organization_id = org AND quote_ref = 'QUO-0102');

  INSERT INTO quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, source)
  SELECT org, qt.id, l.position, l.description, l.quantity, l.unit_price, 'manual'
  FROM quotes qt
  CROSS JOIN (VALUES
      (0, 'Turned spacer, 303 stainless, PN-103', 40, 2.85),
      (1, 'Milled housing, 6082-T6, PN-104', 3, 186.00),
      (2, 'Threaded stud, A4-80, PN-105', 16, 3.35),
      (3, 'Drilled base plate, S275, PN-106', 9, 27.50),
      (4, 'Weld fabrication, mild steel bracket', 2, 412.00),
      (5, 'Bead blast and anodise', 5, 14.75),
      (6, 'Packing and crating', 3, 7.99),
      (7, 'Inspection and CMM report', 1, 95.00)
  ) AS l(position, description, quantity, unit_price)
  WHERE qt.organization_id = org AND qt.quote_ref = 'QUO-0102'
    AND NOT EXISTS (SELECT 1 FROM quote_line_items WHERE quote_id = qt.id);

  INSERT INTO quotes (organization_id, quote_ref, customer, description, total_value, status, valid_until, customer_notes, created_at)
  SELECT org, 'QUO-0101', 'Clydeside Pump Services Ltd', '6 line quote for Clydeside Pump Services Ltd', 4341.26, 'accepted', '2026-02-23', 'Quotation valid for 7 days. Prices are based on all parts being ordered. Please quote our reference.', '2026-02-09'::date
  WHERE NOT EXISTS (SELECT 1 FROM quotes WHERE organization_id = org AND quote_ref = 'QUO-0101');

  INSERT INTO quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, source)
  SELECT org, qt.id, l.position, l.description, l.quantity, l.unit_price, 'manual'
  FROM quotes qt
  CROSS JOIN (VALUES
      (0, 'Turned bush, EN8, PN-100', 25, 6.50),
      (1, 'Milled bracket, 6082-T6, PN-101', 12, 42.49),
      (2, 'Weld fabrication, mild steel frame, PN-102', 2, 1250.00),
      (3, 'Laser-cut plate set', 7, 9.99),
      (4, 'Inspection and CMM report', 1, 310.40),
      (5, 'Delivery', 1, 65.00)
  ) AS l(position, description, quantity, unit_price)
  WHERE qt.organization_id = org AND qt.quote_ref = 'QUO-0101'
    AND NOT EXISTS (SELECT 1 FROM quote_line_items WHERE quote_id = qt.id);

  -- Sales orders: the customers' purchase orders (so_number is the customer's own PO number) ----
  INSERT INTO sales_orders (organization_id, so_number, customer, customer_id, quote_id, status, order_date, delivery_date, total_value, notes)
  SELECT org, 'PO-TEST-2', 'Northfield Industrial Supplies Ltd', (SELECT id FROM customers WHERE organization_id = org AND name = 'Northfield Industrial Supplies Ltd' LIMIT 1),
         (SELECT id FROM quotes WHERE organization_id = org AND quote_ref = 'QUO-0102' LIMIT 1),
         'despatched', '2026-07-28'::date, '2026-08-19'::date, 1989.82, 'Customer PO PO-TEST-2 against QUO-0102. Value ex VAT.'
  WHERE NOT EXISTS (SELECT 1 FROM sales_orders WHERE organization_id = org AND so_number = 'PO-TEST-2');

  INSERT INTO sales_orders (organization_id, so_number, customer, customer_id, quote_id, status, order_date, delivery_date, total_value, notes)
  SELECT org, 'PO-TEST-1', 'Clydeside Pump Services Ltd', (SELECT id FROM customers WHERE organization_id = org AND name = 'Clydeside Pump Services Ltd' LIMIT 1),
         (SELECT id FROM quotes WHERE organization_id = org AND quote_ref = 'QUO-0101' LIMIT 1),
         'closed', '2026-02-16'::date, '2026-03-13'::date, 3617.71, 'Customer PO PO-TEST-1 against QUO-0101. Value ex VAT.'
  WHERE NOT EXISTS (SELECT 1 FROM sales_orders WHERE organization_id = org AND so_number = 'PO-TEST-1');

  -- Jobs ------------------------------------------------------------------------------------
  INSERT INTO jobs (organization_id, job_no, customer, description, stage, due_date, value, status, specification, drawings,
                    customer_po, date_received, date_required, quote_ref, quantity_required, drawing_no, converted_from_sales_order_id, converted_at, created_at)
  SELECT org, 'J-0102', 'Northfield Industrial Supplies Ltd', 'Spacers, housings, studs, base plates and brackets', 'inspection', '2026-08-19', 1989.82, 'on_track', 'Customer PO PO-TEST-2. Housings anodised after bead blast. Packed and crated; customer collects.', '[]'::jsonb,
         'PO-TEST-2', '2026-07-28'::date, '2026-08-19'::date, 'QUO-0102', 79, 'PN-103 / PN-104 / PN-105 / PN-106',
         (SELECT id FROM sales_orders WHERE organization_id = org AND so_number = 'PO-TEST-2' LIMIT 1), '2026-07-28'::timestamptz, '2026-07-28'::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE organization_id = org AND job_no = 'J-0102');

  UPDATE sales_orders SET converted_to_job_id = (SELECT id FROM jobs WHERE organization_id = org AND job_no = 'J-0102' LIMIT 1), converted_at = '2026-07-28'::timestamptz
  WHERE organization_id = org AND so_number = 'PO-TEST-2' AND converted_to_job_id IS NULL;

  INSERT INTO jobs (organization_id, job_no, customer, description, stage, due_date, value, status, specification, drawings,
                    customer_po, date_received, date_required, quote_ref, quantity_required, drawing_no, converted_from_sales_order_id, converted_at, created_at)
  SELECT org, 'J-0101', 'Clydeside Pump Services Ltd', 'Bushes, brackets, frame fabrication and plate set', 'inspection', '2026-03-13', 3617.71, 'on_track', 'Customer PO PO-TEST-1. CMM report and certificate of conformity with the parts.', '[]'::jsonb,
         'PO-TEST-1', '2026-02-16'::date, '2026-03-13'::date, 'QUO-0101', 48, 'PN-100 / PN-101 / PN-102',
         (SELECT id FROM sales_orders WHERE organization_id = org AND so_number = 'PO-TEST-1' LIMIT 1), '2026-02-16'::timestamptz, '2026-02-16'::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE organization_id = org AND job_no = 'J-0101');

  UPDATE sales_orders SET converted_to_job_id = (SELECT id FROM jobs WHERE organization_id = org AND job_no = 'J-0101' LIMIT 1), converted_at = '2026-02-16'::timestamptz
  WHERE organization_id = org AND so_number = 'PO-TEST-1' AND converted_to_job_id IS NULL;

  -- Invoices and their line items (both paid in full) ----------------------------------------
  INSERT INTO invoices (organization_id, invoice_ref, customer, description, quantity, unit_price, subtotal, vat, total, due_date, status,
                        invoice_date, terms, quote_ref, customer_po, carriage, amount_paid, created_at)
  SELECT org, 'INV-0102', 'Northfield Industrial Supplies Ltd', 'Per quote QUO-0102 (see line items)', 1, 1989.82, 1989.82, 397.96, 2387.78, '2026-09-18'::date, 'paid',
         '2026-08-19'::date, '30 days', 'QUO-0102', 'PO-TEST-2', 0, 2387.78, '2026-08-19'::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = org AND invoice_ref = 'INV-0102');

  INSERT INTO invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct)
  SELECT org, inv.id, l.position, l.description, l.quantity, l.unit_price, l.vat_pct
  FROM invoices inv
  CROSS JOIN (VALUES
      (0, 'Turned spacer, 303 stainless, PN-103', 40, 2.85, 20),
      (1, 'Milled housing, 6082-T6, PN-104', 3, 186.00, 20),
      (2, 'Threaded stud, A4-80, PN-105', 16, 3.35, 20),
      (3, 'Drilled base plate, S275, PN-106', 9, 27.50, 20),
      (4, 'Weld fabrication, mild steel bracket', 2, 412.00, 20),
      (5, 'Bead blast and anodise', 5, 14.75, 20),
      (6, 'Packing and crating', 3, 7.99, 20),
      (7, 'Inspection and CMM report', 1, 95.00, 20)
  ) AS l(position, description, quantity, unit_price, vat_pct)
  WHERE inv.organization_id = org AND inv.invoice_ref = 'INV-0102'
    AND NOT EXISTS (SELECT 1 FROM invoice_line_items WHERE invoice_id = inv.id);

  INSERT INTO invoices (organization_id, invoice_ref, customer, description, quantity, unit_price, subtotal, vat, total, due_date, status,
                        invoice_date, terms, quote_ref, customer_po, carriage, amount_paid, created_at)
  SELECT org, 'INV-0101', 'Clydeside Pump Services Ltd', 'Per quote QUO-0101 (see line items)', 1, 3617.71, 3617.71, 723.55, 4341.26, '2026-04-11'::date, 'paid',
         '2026-03-12'::date, '30 days', 'QUO-0101', 'PO-TEST-1', 0, 4341.26, '2026-03-12'::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = org AND invoice_ref = 'INV-0101');

  INSERT INTO invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct)
  SELECT org, inv.id, l.position, l.description, l.quantity, l.unit_price, l.vat_pct
  FROM invoices inv
  CROSS JOIN (VALUES
      (0, 'Turned bush, EN8, PN-100', 25, 6.50, 20),
      (1, 'Milled bracket, 6082-T6, PN-101', 12, 42.49, 20),
      (2, 'Weld fabrication, mild steel frame, PN-102', 2, 1250.00, 20),
      (3, 'Laser-cut plate set', 7, 9.99, 20),
      (4, 'Inspection and CMM report', 1, 310.40, 20),
      (5, 'Delivery', 1, 65.00, 20)
  ) AS l(position, description, quantity, unit_price, vat_pct)
  WHERE inv.organization_id = org AND inv.invoice_ref = 'INV-0101'
    AND NOT EXISTS (SELECT 1 FROM invoice_line_items WHERE invoice_id = inv.id);

  -- Delivery notes (same number as their invoice) and their items ------------------------------
  INSERT INTO delivery_notes (organization_id, dn_number, customer, customer_email, customer_id, sales_order_id, job_ref, invoice_ref,
                              delivery_date, ship_date, tax_date, ship_via, status, notes, created_at)
  SELECT org, 'DLN-0102', 'Northfield Industrial Supplies Ltd', 'orders@northfieldsupplies.example', (SELECT id FROM customers WHERE organization_id = org AND name = 'Northfield Industrial Supplies Ltd' LIMIT 1),
         (SELECT id FROM sales_orders WHERE organization_id = org AND so_number = 'PO-TEST-2' LIMIT 1), 'J-0102', 'INV-0102',
         '2026-08-18'::date, '2026-08-18'::date, '2026-08-19'::date, NULL, 'delivered', 'Delivery note for INV-0102', '2026-08-19'::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM delivery_notes WHERE organization_id = org AND dn_number = 'DLN-0102');

  INSERT INTO delivery_note_items (organization_id, delivery_note_id, position, description, quantity)
  SELECT org, dn.id, l.position, l.description, l.quantity
  FROM delivery_notes dn
  CROSS JOIN (VALUES
      (0, 'Turned spacer, 303 stainless, PN-103', 40),
      (1, 'Milled housing, 6082-T6, PN-104', 3),
      (2, 'Threaded stud, A4-80, PN-105', 16),
      (3, 'Drilled base plate, S275, PN-106', 9),
      (4, 'Weld fabrication, mild steel bracket', 2),
      (5, 'Bead blast and anodise', 5),
      (6, 'Packing and crating', 3),
      (7, 'Inspection and CMM report', 1)
  ) AS l(position, description, quantity)
  WHERE dn.organization_id = org AND dn.dn_number = 'DLN-0102'
    AND NOT EXISTS (SELECT 1 FROM delivery_note_items WHERE delivery_note_id = dn.id);

  INSERT INTO delivery_notes (organization_id, dn_number, customer, customer_email, customer_id, sales_order_id, job_ref, invoice_ref,
                              delivery_date, ship_date, tax_date, ship_via, status, notes, created_at)
  SELECT org, 'DLN-0101', 'Clydeside Pump Services Ltd', 'accounts@clydesidepumps.example', (SELECT id FROM customers WHERE organization_id = org AND name = 'Clydeside Pump Services Ltd' LIMIT 1),
         (SELECT id FROM sales_orders WHERE organization_id = org AND so_number = 'PO-TEST-1' LIMIT 1), 'J-0101', 'INV-0101',
         '2026-03-11'::date, '2026-03-11'::date, '2026-03-12'::date, NULL, 'delivered', 'Delivery note for INV-0101', '2026-03-12'::timestamptz
  WHERE NOT EXISTS (SELECT 1 FROM delivery_notes WHERE organization_id = org AND dn_number = 'DLN-0101');

  INSERT INTO delivery_note_items (organization_id, delivery_note_id, position, description, quantity)
  SELECT org, dn.id, l.position, l.description, l.quantity
  FROM delivery_notes dn
  CROSS JOIN (VALUES
      (0, 'Turned bush, EN8, PN-100', 25),
      (1, 'Milled bracket, 6082-T6, PN-101', 12),
      (2, 'Weld fabrication, mild steel frame, PN-102', 2),
      (3, 'Laser-cut plate set', 7),
      (4, 'Inspection and CMM report', 1),
      (5, 'Delivery', 1)
  ) AS l(position, description, quantity)
  WHERE dn.organization_id = org AND dn.dn_number = 'DLN-0101'
    AND NOT EXISTS (SELECT 1 FROM delivery_note_items WHERE delivery_note_id = dn.id);
END
$demo$;

REVOKE ALL ON FUNCTION public.load_demo_documents(uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.load_demo_documents(uuid) IS 'DEMO/STAGING ONLY. Owner-only (SQL editor). Loads anonymised sample paperwork into one organisation.';
