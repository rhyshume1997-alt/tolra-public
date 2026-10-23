-- Machine schedule: machine capacity columns + machine_bookings (job booked onto a machine).
-- Prerequisites: 000_base_schema.sql (public.machines core table, public.user_organization_id(),
-- public.has_org_role()). Idempotent.

CREATE TABLE IF NOT EXISTS public.machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id),
  name TEXT NOT NULL,
  type TEXT
);

ALTER TABLE public.machines
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id),
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS hours_per_day NUMERIC NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS working_days INT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- working_days uses ISO weekday numbers: 1 = Monday ... 7 = Sunday.

CREATE TABLE IF NOT EXISTS public.machine_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  machine_id UUID NOT NULL REFERENCES public.machines(id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  job_no TEXT,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  estimated_hours NUMERIC NOT NULL CHECK (estimated_hours >= 0),
  hours_done NUMERIC NOT NULL DEFAULT 0 CHECK (hours_done >= 0),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'running', 'complete')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS machine_bookings_org_machine_start_idx
  ON public.machine_bookings (organization_id, machine_id, start_at);

ALTER TABLE public.machine_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "machine_bookings tenant select" ON public.machine_bookings;
CREATE POLICY "machine_bookings tenant select" ON public.machine_bookings FOR SELECT
USING (organization_id = public.user_organization_id());

DROP POLICY IF EXISTS "machine_bookings tenant insert" ON public.machine_bookings;
CREATE POLICY "machine_bookings tenant insert" ON public.machine_bookings FOR INSERT
WITH CHECK (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

DROP POLICY IF EXISTS "machine_bookings tenant update" ON public.machine_bookings;
CREATE POLICY "machine_bookings tenant update" ON public.machine_bookings FOR UPDATE
USING (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
WITH CHECK (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

DROP POLICY IF EXISTS "machine_bookings tenant delete" ON public.machine_bookings;
CREATE POLICY "machine_bookings tenant delete" ON public.machine_bookings FOR DELETE
USING (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

-- The schedule page is also viewable by the viewer role, so let viewers read machines
-- (the iso patch limits machines to admin/office/workshop). Read-only.
ALTER TABLE public.machines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "machines viewer select" ON public.machines;
CREATE POLICY "machines viewer select" ON public.machines FOR SELECT
USING (organization_id = public.user_organization_id() AND public.has_org_role(ARRAY['viewer']));
