# G16 — John checks the paid hours

John: __________ Date: __________. These are made-up attendance examples, not anybody's actual pay. Tolra totals hours; this sheet does not set wages or an overtime pay rate.

The rule being checked: on a day lasting **six hours or more**, unpaid breaks are the larger of **45 minutes** (30 lunch + 15 tea) and the breaks actually recorded. On a shorter day, subtract only the recorded breaks. No automatic extra overtime for a long day, Saturday, Sunday or a bank holiday. Someone must tick the day's Overtime box. There is no automatic weekly overtime threshold.

| Day | In → out | Time present | Unpaid break | Paid time | Expected explanation |
| --- | --- | --- | --- | --- | --- |
| Monday | 08:00 → 16:45 | 8h 45m | 45m | 8h | The standard 45 minutes is taken. |
| Tuesday | 07:00 → 17:30 | 10h 30m | 45m | 9h 45m | A longer day still uses the agreed break rule. |
| Wednesday | 08:00 → 13:00 | 5h | 10m recorded | 4h 50m | Under six hours: only the recorded break is taken. |
| Thursday | 07:30 → 17:00 | 9h 30m | 70m recorded | 8h 20m | Recorded breaks were 10 + 60 minutes, which is more than 45. |
| Friday | 08:00 → 16:30 | 8h 30m | 45m | 7h 45m | Only 15m was recorded, but the long-day minimum is 45m. |
| Saturday | 07:00 → 12:00 | 5h | None recorded | 5h | Under six hours with no break recorded; Saturday alone does not make it overtime. |
| **Total** | | **47h 15m** | **3h 35m** | **43h 40m** | Present time minus unpaid breaks. |

If Tuesday and Thursday alone are ticked Overtime, **18h 05m of the 43h 40m** is labelled overtime. Do not add it again to make a larger paid total. Saturday's 5 hours stays ordinary time unless its Overtime box is ticked. A bank holiday does not itself apply an extra-pay multiplier.

For comparison, the agreed JNR normal pattern in the reference is Monday–Thursday 08:00–16:00 and Friday 08:00–14:30. Taking 45 minutes each day gives **34h 45m**, not five identical eight-hour days. John must confirm this remains the actual pattern.

| Tick | John and Rhys do this | What they should see | Stop if… |
| --- | --- | --- | --- |
| [ ] | Read each row together and subtract its unpaid break. | The row and week totals above add up. | Any figure is disputed. Write the correction; do not use the example for pay. |
| [ ] | Check the six-hour boundary and the 45-minute minimum against the actual employment agreement. | John explicitly agrees or asks for a different rule below. | “That is probably right” is the only answer. |
| [ ] | Check the day Overtime box and the lack of a weekly trigger against the actual agreement. | John understands that the label does not add hours or choose a wage multiplier. | An automatic rate/threshold is expected but not present. |
| [ ] | Rhys shows the same approved example in a safe rehearsal and the payroll output; John compares it with this sheet and PAID-ROUND. | The agreed result appears in the screen/export, with rounding shown separately. | Runtime/export results differ, or the rounding choice is unsigned. Unit tests alone do not approve pay. |

**John chooses each answer:**

- Long-day minimum-break rule (rule 4): [ ] Agree [ ] Refuse; required rule: __________.
- No automatic weekly overtime threshold (rule 7): [ ] Agree [ ] Refuse; required rule: __________.
- JNR normal working pattern above: [ ] Correct [ ] Correct pattern: __________.
- Worked totals and overtime explanation: [ ] Agree [ ] Disputed: __________.

If any answer is refused, missing or disputed, hold use of these rules for payroll and send the question to John/Rhys and the payroll adviser. Signing a different rule does not change Tolra by itself; it needs the existing change/review route before use.

John signature: __________ Date: __________.
Rhys/rehearsal witness: __________ Evidence: __________.

## Handover

Documentation only. Existing `pay-worked-example` and `time-payroll-export` unit suites: **33 passed**, no skips, on main `68f89ca`, 4 November 2026. This checks arithmetic/code, not actual payroll, employment policy or John's acceptance. Rates and the separate PAID-ROUND choice remain outside this sheet.

Related sheets named here may still be separate draft PRs. Use their reviewed versions from the agreed cutover pack; a draft title is not approval.
