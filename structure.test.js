'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
test('all web pages and scripts have separate files', () => {
  const expected = [
    'public/index.html', 'public/style.css', 'public/script.js',
    'public/usdt.html', 'public/usdt.js', 'public/favicon.svg',
    'admin/admin.html', 'admin/admin.css', 'admin/admin.js',
    'server.js', 'config/products.js', 'scripts/setup.js',
    'START_EZSTORE.bat', '.env.example'
  ];
  for (const pathname of expected) assert.ok(fs.statSync(path.join(root, pathname)).size > 0, pathname);
});
test('HTML local assets match existing paths', () => {
  for (const page of ['public/index.html', 'public/usdt.html', 'admin/admin.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="(\/(?:admin\/)?[^"#?]+\.(?:css|js|svg))"/g)];
    assert.ok(assets.length > 0, page);
    for (const match of assets) {
      const disk = match[1].startsWith('/admin/')
        ? path.join(root, match[1].slice(1))
        : path.join(root, 'public', match[1].slice(1));
      assert.ok(fs.existsSync(disk), `${page} refers to missing ${match[1]}`);
    }
  }
});

test('public storefront never advertises the admin login', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /href=["']\/admin(?:["'\/?#])/i);
  assert.doesNotMatch(html, /Admin login/i);
});
