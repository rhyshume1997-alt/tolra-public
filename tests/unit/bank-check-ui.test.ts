import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BankCheck } from '../../components/bank/bank-check';
describe('Bank check', () => {
 it('shows the three matching groups', () => {
  const html = renderToStaticMarkup(React.createElement(BankCheck, { invoices: [], onMarkPaid: vi.fn(), onSkip: vi.fn() }));
  expect(html).toContain('To confirm'); expect(html).toContain('Unsure'); expect(html).toContain('No match');
 });
 it('has a CSV input and accessible section', () => {
  const html = renderToStaticMarkup(React.createElement(BankCheck, { invoices: [], onMarkPaid: vi.fn(), onSkip: vi.fn() }));
  expect(html).toContain('type="file"'); expect(html).toContain('aria-label="Bank check"');
 });
});