-- Test-only exact pre-fix148 function from e70f6633b0f02f0e1dd38391ade87330d38a6a1c; never a release input.
CREATE FUNCTION public.job_cost_round(p_num numeric, p_den numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE q numeric; r numeric;
BEGIN
  IF p_num < 0 OR p_den <= 0 OR p_num <> trunc(p_num) OR p_den <> trunc(p_den) THEN RAISE EXCEPTION 'Invalid cost ratio' USING ERRCODE = '22023'; END IF;
  q := div(p_num, p_den); r := p_num - q * p_den;
  IF 2 * r > p_den OR (2 * r = p_den AND mod(q, 2) = 1) THEN q := q + 1; END IF;
  RETURN q::bigint;
END $$;
