-- PREVIEW TEST PROJECT ONLY (see the release checklist in the private repository's docs). Creates one synthetic company. Every detail is
-- made up. Replace ADMIN_EMAIL_HERE with the test admin login you created in the TEST project's Authentication page.
-- Refuses to run on a database that holds the real companies.
DO $$
BEGIN
  -- Test project only: refuse to run where the real companies exist.
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug IN ('jnr-engineering', 'marpet')) THEN
    RAISE EXCEPTION 'This database holds real companies. Preview test data goes only into the separate test project.';
  END IF;
END
$$;

SELECT public.create_organization(
  'Preview Test Engineering', 'preview-test', 'ADMIN_EMAIL_HERE',
  '{
    "name": "Preview Test Engineering Ltd",
    "documentName": "Preview Test Engineering Ltd",
    "addressLines": ["1 Example Road", "Exampletown", "EX1 1AA"],
    "phone": "0100 000 0000",
    "email": "office@example.test",
    "website": "example.test",
    "vatNumber": "GB000000000",
    "defaultQuoteTerms": "Valid for 30 days",
    "defaultInvoiceTerms": "30 days",
    "defaultCustomerMessage": ["Synthetic test company."]
  }'::jsonb)
WHERE NOT EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'preview-test');
