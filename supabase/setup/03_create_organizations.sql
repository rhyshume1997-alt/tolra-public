-- Step 03 (run on quoteflow-prod): create the first two tenants. Safe to re-run (existing slugs are skipped).
-- an organisation whose slug already exists is skipped).
-- Both admins get an invite per company; when they first sign in to the new project they get a
-- membership in BOTH companies (admin) and can switch between them in the sidebar.
-- Company details are what prints on documents; edit them any time in the app: Settings > Company details.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'jnr-engineering') THEN
    PERFORM public.create_organization(
      'JNR Engineering', 'jnr-engineering', 'owner@tolra.example',
      '{
        "name": "JNR Engineering Ltd",
        "documentName": "J N R Engineering Ltd",
        "addressLines": ["Unit 1", "Example Industrial Estate", "Northfield", "ML3 1AA"],
        "phone": "01698 000 0000",
        "fax": "01698 000 0001",
        "email": "info@jnr.example",
        "website": "www.jnrengineering.co.uk",
        "vatNumber": "GB000000000",
        "defaultQuoteTerms": "Valid for 7 days",
        "defaultInvoiceTerms": "30 days",
        "defaultCustomerMessage": ["Quotations are valid for 7 days.", "Quotation is based on all parts being ordered.", "Please use Quote # as Ref"]
      }'::jsonb);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'marpet') THEN
    PERFORM public.create_organization(
      'Marpet', 'marpet', 'owner@tolra.example',
      '{
        "name": "Marpet",
        "documentName": "Marpet",
        "addressLines": ["ADDRESS - set in Settings > Company details"],
        "vatNumber": "VAT NUMBER - set in Settings > Company details",
        "defaultQuoteTerms": "Valid for 30 days",
        "defaultInvoiceTerms": "30 days"
      }'::jsonb);
  END IF;
END $$;

-- Second admin for both companies (no-op if already a member).
SELECT public.add_member((SELECT id FROM public.organizations WHERE slug = 'jnr-engineering'), 'admin2@tolra.example', 'admin');
SELECT public.add_member((SELECT id FROM public.organizations WHERE slug = 'marpet'), 'admin2@tolra.example', 'admin');

-- Check: expect 2 organisations, each with 2 pending admin invites (or memberships once they have signed in).
SELECT * FROM public.platform_org_summary();
