#!/usr/bin/env node
// Usage: node bin/research.js <company-url> [--json] [--no-search]

import { researchCompany } from '../src/research.js';
import { renderText } from '../src/report.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
if (!url) {
  console.error('Usage: node bin/research.js <company-url> [--json] [--no-search]');
  process.exit(2);
}

const report = await researchCompany(url, { useSearch: !args.includes('--no-search') });
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderText(report));
