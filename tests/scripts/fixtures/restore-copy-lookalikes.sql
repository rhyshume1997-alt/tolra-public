SET statement_timeout = 0;

COPY public.empty_one (id) FROM stdin;
\.

COPY public.notes (body) FROM stdin;
COPY public.example FROM stdin;
plain
\\.
COPY public.example FROM stdin;
\.

COPY public.after (id) FROM stdin;
9
\.

COPY public.empty_two (id) FROM stdin;
\.
