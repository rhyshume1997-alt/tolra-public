# Paid-claim integration (job 28a)

One detector module and one adapter. Reconciles #107/#117/#137 plus strict sender fix #156 and earlier #147 safety cases. Built off latest main. All existing assertion files are retained unchanged, plus five adapter-to-detector cases. No automatic invoice/payment write is added.

Keep this integration version after the older PRs land. Do not later overwrite it with the detector/adapter copies in #117 or #147. #147 staff-guide corrections remain useful separately. This PR includes #156 code/tests; do not treat it as an unrelated alternative detector.

139 focused cases reported passing, TypeScript and targeted lint passed. Local Vitest still requires timeout cleanup after results. Email authenticity still needs provider authentication evidence and human review; sender text alone is not authentication.

Source heads checked:
- chatgpt/paid-claim: 0944385a1e90a31cf5b35331c03acb44be766495
- chatgpt/paid-claim-adapter: 79563720f49a0fe3e733c02ad9734dd38f124a3c
- chatgpt2/paid-claim-more-tests: 3b9713c3bb52423770bc138a156906ddf994f66c
- chatgpt2/paid-claim-adapter-sender: a13ff77ee1d85840f9bb37c87f5aae676a26a84a
- chatgpt2/claim-adapter-followup: 190b440a330d79ce28702b89d0659d63ed8424e1
