// "Check backend" step for CI: syntax-check every source file and make sure the app can be constructed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ci-check-secret';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
for (const f of walk(path.join(__dirname, '../src'))) execFileSync(process.execPath, ['--check', f]);
require('../src/app').createApp();
console.log('backend check OK');
