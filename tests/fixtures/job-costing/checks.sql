SET ROLE authenticated;
SET test.uid='00000000-0000-0000-0000-000000000010';
SET test.org='00000000-0000-0000-0000-000000000001';
SET test.role='admin'; SET test.mfa='ok';
DO $$ DECLARE d jsonb; BEGIN
 d:=job_profitability_actual_inputs('00000000-0000-0000-0000-000000000011');
 IF d->'config'->>'enabled' <> 'false' OR d ? 'labour' THEN RAISE EXCEPTION 'Default must be off, without actual reads'; END IF;
END $$;
SELECT save_job_costing_rates('00000000-0000-0000-0000-000000000001',0,true,2000,'labour',500,'[{"machine_id":"00000000-0000-0000-0000-000000000021","rate_pence":3000,"includes_labour":false,"includes_overhead":false}]');
SELECT save_job_cost_estimate('00000000-0000-0000-0000-000000000011',1000,1,1,false,false);
DO $$ DECLARE d jsonb; BEGIN
 d:=job_profitability_actual_inputs('00000000-0000-0000-0000-000000000011');
 IF jsonb_array_length(d->'invoices')<>1 OR d->'invoices'->0->>'subtotal'<>'200'
   OR d->'credits'->0->>'subtotal'<>'10' OR d->'pos'->0->>'linked_net'<>'10'
   OR jsonb_array_length(d->'labour')<>1 OR jsonb_array_length(d->'machines')<>1
   OR d->'plans'->0->>'estimated_hours'<>'1' OR d->'quoteLines'->0->>'unit_price'<>'200' THEN
   RAISE EXCEPTION 'Inputs must be complete and isolated'; END IF;
 IF (SELECT count(*) FROM job_costing_rate_history)<>1 THEN RAISE EXCEPTION 'Approval history missing'; END IF;
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000002',1,true,2000,'none',null,'[]'); RAISE EXCEPTION 'Stale company form accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',0,true,2000,'none',null,'[]'); RAISE EXCEPTION 'Stale revision accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',1,true,2000,'none',null,'[{"machine_id":"00000000-0000-0000-0000-000000000022","rate_pence":1,"includes_labour":false,"includes_overhead":false}]'); RAISE EXCEPTION 'Foreign rate accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',1,true,2000,'none',null,'[{"machine_id":"00000000-0000-0000-0000-000000000021","rate_pence":1.5,"includes_labour":false,"includes_overhead":false}]'); RAISE EXCEPTION 'Fractional pence accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',1,true,2000,'labour',null,'[]'); RAISE EXCEPTION 'Missing overhead accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM save_job_cost_estimate('00000000-0000-0000-0000-000000000012',1,1,1,false,false); RAISE EXCEPTION 'Foreign estimate accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM job_profitability_actual_inputs('00000000-0000-0000-0000-000000000012'); RAISE EXCEPTION 'Foreign job readable'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE job_costing_settings SET enabled=false; RAISE EXCEPTION 'Direct write allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.role='office';
DO $$ BEGIN
 PERFORM job_profitability_actual_inputs('00000000-0000-0000-0000-000000000011');
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',1,true,1,'none',null,'[]'); RAISE EXCEPTION 'Office changed rates'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.role='workshop';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM job_costing_settings) THEN RAISE EXCEPTION 'Workshop read financial rates'; END IF;
 BEGIN PERFORM job_profitability_actual_inputs('00000000-0000-0000-0000-000000000011'); RAISE EXCEPTION 'Workshop read costs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.role='admin'; SET test.denied='invoices';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM job_costing_settings) THEN RAISE EXCEPTION 'Financial restriction bypassed'; END IF;
 BEGIN PERFORM job_profitability_actual_inputs('00000000-0000-0000-0000-000000000011'); RAISE EXCEPTION 'Restricted admin read costs'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.denied=''; SET test.mfa='missing';
DO $$ BEGIN
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',1,true,1,'none',null,'[]'); RAISE EXCEPTION 'MFA bypassed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.mfa='ok'; SET test.readonly='true';
DO $$ BEGIN
 BEGIN PERFORM save_job_costing_rates('00000000-0000-0000-0000-000000000001',1,true,1,'none',null,'[]'); RAISE EXCEPTION 'Read-only changed rates'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM save_job_cost_estimate('00000000-0000-0000-0000-000000000011',1,1,1,false,false); RAISE EXCEPTION 'Read-only changed estimates'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET test.readonly='false'; SET test.org='00000000-0000-0000-0000-000000000002';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM job_costing_settings) OR EXISTS (SELECT 1 FROM job_machine_cost_rates) OR EXISTS (SELECT 1 FROM job_cost_estimates) OR EXISTS (SELECT 1 FROM job_costing_rate_history) THEN RAISE EXCEPTION 'Cross-company RLS leak'; END IF;
END $$;
RESET ROLE;
