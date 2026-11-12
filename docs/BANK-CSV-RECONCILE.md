# Bank CSV integration (job 28b)

One bank parser/matcher combines #131 quote rejection and #136 six-bank layouts with #146 safe pence and full-reference matching. All 18 quote/original, 26 bank-more, 16 format and 9 confirmation safeguard cases are kept unchanged. Four parse-to-match cases add coverage. The payment helper has no automatic page call or automatic posting.

Built off latest main. Keep this integration version after #109/#120/#131/#136 and the copied parsers in #116/#139; do not restore those older parser copies afterwards. #146 UI callbacks still need their own integration. Quoted structural errors reject the whole CSV. Row-level validation errors remain errors that the confirmation UI must block before posting.

73 focused cases reported passing, TypeScript and targeted lint passed. Local Vitest still needs timeout cleanup after results. No bank data, SQL or payment provider was contacted. Cross-export transaction identity and parent-page connection remain separate integration holds.

Source heads:
- chatgpt/bank-matcher: c547757a3cf3c4c7a4c729d4af6b4a44e12534e0
- chatgpt/bank-matcher-more-tests: aa520be8946d564f0841c55eb15ce9775335a767
- codex/bank-csv-quotes: 316a9bfa8f63116e26de55990a11c0a9e1c1b4bf
- chatgpt2/bank-csv-formats: 6c8c7c81b908dbbd8d387262567866c7ae4e2e92
- chatgpt2/bank-followup: 8142d8d0ba67e36363dd780b9ac225e191451ce5
