'use strict';
// PRICES ARE ONLY EDITABLE HERE, NEVER IN ADMIN. All amounts are US cents.
// Set your own selling prices below before going live.
const PRODUCTS = Object.freeze([
  { id: 'gta-v', name: 'GTA V', category: 'games', symbol: 'V', theme: 'amber', priceCents: 1299, unit: 'code', subtitle: 'Digital account / activation code' },
  { id: 'free-fire', name: 'Free Fire', category: 'games', symbol: 'F', theme: 'ice', priceCents: 399, unit: 'account', subtitle: 'Digital game account' },
  { id: 'fortnite', name: 'Fortnite', category: 'games', symbol: 'FN', theme: 'purple', priceCents: 999, unit: 'account', subtitle: 'Digital game account' },
  { id: 'pubg-mobile', name: 'PUBG Mobile', category: 'games', symbol: 'P', theme: 'sand', priceCents: 599, unit: 'account', subtitle: 'Digital game account' },
  { id: 'call-of-duty', name: 'Call of Duty', category: 'games', symbol: 'COD', theme: 'steel', priceCents: 1099, unit: 'account', subtitle: 'Digital game account' },
  { id: 'fc-24', name: 'FC 24', category: 'games', symbol: 'FC', theme: 'night', priceCents: 799, unit: 'account', subtitle: 'Digital game account' },
  { id: 'instagram', name: 'Instagram', category: 'social', symbol: '◎', theme: 'instagram', priceCents: 100, unit: 'account', subtitle: 'Digital account' },
  { id: 'tiktok', name: 'TikTok', category: 'social', symbol: '♪', theme: 'tiktok', priceCents: 150, unit: 'account', subtitle: 'Digital account' },
  { id: 'twitter-x', name: 'Twitter (X)', category: 'social', symbol: '𝕏', theme: 'twitter', priceCents: 200, unit: 'account', subtitle: 'Digital account' },
  { id: 'facebook', name: 'Facebook', category: 'social', symbol: 'f', theme: 'facebook', priceCents: 150, unit: 'account', subtitle: 'Digital account' },
  { id: 'youtube', name: 'YouTube', category: 'social', symbol: '▶', theme: 'youtube', priceCents: 250, unit: 'account', subtitle: 'Digital account' },
  { id: 'telegram', name: 'Telegram', category: 'social', symbol: '➤', theme: 'telegram', priceCents: 100, unit: 'account', subtitle: 'Digital account' }
]);
const byId = Object.freeze(Object.fromEntries(PRODUCTS.map(p => [p.id, p])));
const money = cents => (cents / 100).toFixed(2);
module.exports = { PRODUCTS, byId, money };
