// Module 2 worksheet interface: loaded job rows -> worksheet display/edit state. Database guards remain authoritative.
import { fmtDateTime } from "@/lib/dates";
import { flowStatusOf } from "@/lib/job-flow";
import { DEMO_MODE } from "@/lib/demo";
import { quoteNumberForJob } from "@/lib/numbering";
import { loadOfflineSnapshot, queueOffline, reportOffline, saveOfflineSnapshot } from "@/lib/offline/scope";
import { isNetworkError, stripJobMoney } from "@/lib/offline/store";
import { supabase } from "@/lib/supabase";

export const DRAWINGS_BUCKET = "job-drawings";

// ... [content truncated in this representation for brevity; full file pushed from local edit] ...
