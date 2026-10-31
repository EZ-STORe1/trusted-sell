'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCTS, byId, money } = require('../config/products');
test('products have unique valid identifiers', () => {
  assert.equal(new Set(PRODUCTS.map(p => p.id)).size, PRODUCTS.length);
  for (const product of PRODUCTS) {
    assert.ok(Number.isSafeInteger(product.priceCents) && product.priceCents > 0);
    assert.equal(byId[product.id], product);
  }
});
test('Instagram is exactly one US dollar each; ten cost ten', () => {
  assert.equal(byId.instagram.priceCents, 100);
  assert.equal(money(byId.instagram.priceCents * 10), '10.00');
});
test('catalog contains six gaming and six social products', () => {
  assert.equal(PRODUCTS.filter(p => p.category === 'games').length, 6);
  assert.equal(PRODUCTS.filter(p => p.category === 'social').length, 6);
});
