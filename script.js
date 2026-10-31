'use strict';
const $ = selector => document.querySelector(selector);
const cash = cents => '$' + (cents / 100).toFixed(2);
const state = { products: [], checkoutReady: false, usdtReady: false, selected: null, query: '' };
const overlay = $('#checkoutOverlay');
const moneyQty = () => Math.max(1, Math.min(Number(state.selected?.stock) || 1, Number($('#quantity').value) || 1));
let toastTimer;
function toast(message) {
  const t = $('#toast'); t.textContent = message; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}
function makeCard(p) {
  const card = document.createElement('article');
  card.className = `product-card theme-${p.theme} ${p.category === 'social' ? 'is-social' : ''}`;
  card.dataset.id = p.id;
  const art = document.createElement('div'); art.className = 'product-art';
  const aurora = document.createElement('div'); aurora.className = 'card-aurora';
  const symbol = document.createElement('img'); symbol.className = 'product-image'; symbol.src = '/assets/' + encodeURIComponent(p.id) + '.webp'; symbol.alt = p.name; symbol.loading = 'lazy';
  const watermark = document.createElement('span'); watermark.className = 'product-watermark'; watermark.textContent = p.symbol;
  art.append(symbol);
  const info = document.createElement('div'); info.className = 'product-info';
  const title = document.createElement('h3'); title.textContent = p.name;
  const detail = document.createElement('div'); detail.className = 'product-detail';
  const label = document.createElement('span'); label.textContent = p.category === 'games' ? '🎮 Digital Items' : '♧ Digital Accounts';
  const price = document.createElement('strong'); price.className = 'price'; price.textContent = cash(p.priceCents);
  detail.append(label, price);
  const bottom = document.createElement('div'); bottom.className = 'product-bottom';
  const stock = document.createElement('span'); stock.className = p.stock ? 'in-stock' : 'sold-out';
  stock.textContent = p.stock ? `● ${p.stock.toLocaleString()} available` : 'Out of Stock';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'buy-small';
  button.textContent = p.stock ? 'Buy Now ↗' : 'Out of Stock'; button.disabled = !p.stock;
  button.addEventListener('click', () => showModal(p.id));
  bottom.append(stock, button); info.append(title, detail, bottom); card.append(art, info);
  return card;
}
function render() {
  const q = state.query.toLowerCase().trim();
  for (const category of ['games', 'social']) {
    const container = $('#' + (category === 'games' ? 'gamesGrid' : 'socialGrid'));
    container.replaceChildren();
    const matches = state.products.filter(p => p.category === category && (`${p.name} ${p.subtitle}`.toLowerCase().includes(q)));
    if (matches.length) for (const p of matches) container.append(makeCard(p));
    else { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No products match your search.'; container.append(empty); }
  }
  $('#storeNotice').textContent = state.checkoutReady ? 'USDT TRC20 checkout • Payments require manual verification before delivery.' : 'Preview mode: configure USDT TRC20 wallet and SMTP in .env before purchases.';
}
async function loadProducts() {
  try {
    const response = await fetch('/api/products', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load products');
    const data = await response.json();
    state.products = data.products; state.checkoutReady = data.checkoutReady; state.usdtReady = data.usdtReady;
    render();
  } catch (error) {
    $('#storeNotice').textContent = 'Catalog connection failed. Refresh the page or check the server.';
    toast(error.message);
  }
}
function showModal(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) return;
  if (!product.stock) return toast('Out of Stock');
  state.selected = product;
  $('#chosenSymbol').textContent = product.symbol;
  $('#chosenName').textContent = product.name;
  $('#chosenUnitPrice').textContent = `${cash(product.priceCents)} / ${product.unit}`;
  $('#chosenStock').textContent = `${product.stock} in stock`;
  $('#quantity').max = product.stock;
  $('#quantity').value = '1';
  $('#checkoutError').classList.add('hidden');
  $('#payButton').disabled = !state.checkoutReady;
  $('#paymentMethod').value = 'usdt'; $('#payButton').textContent = state.checkoutReady ? 'Continue to payment →' : 'Checkout setup required';
  updateTotal();
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('#buyerEmail').focus();
}
function hideModal() {
  overlay.classList.add('hidden'); document.body.classList.remove('modal-open');
  state.selected = null;
}
function updateTotal() {
  if (!state.selected) return;
  let quantity = Number($('#quantity').value) || 1;
  quantity = Math.max(1, Math.min(state.selected.stock, Math.floor(quantity)));
  $('#quantity').value = quantity;
  $('#summaryUnit').textContent = cash(state.selected.priceCents);
  $('#summaryQty').textContent = quantity;
  $('#summaryTotal').textContent = cash(state.selected.priceCents * quantity);
  $('#cartCount').textContent = quantity;
}
$('#quantity').addEventListener('change', updateTotal);
$('#quantity').addEventListener('input', () => { if ($('#quantity').value !== '') updateTotal(); });
$('#minusQty').addEventListener('click', () => { $('#quantity').value = Math.max(1, moneyQty() - 1); updateTotal(); });
$('#plusQty').addEventListener('click', () => { $('#quantity').value = Math.min(state.selected?.stock || 1, moneyQty() + 1); updateTotal(); });
$('#closeCheckout').addEventListener('click', hideModal);
overlay.addEventListener('click', event => { if (event.target === overlay) hideModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.classList.contains('hidden')) hideModal(); });
$('#search').addEventListener('input', event => { state.query = event.target.value; render(); });
$('#cartInfo').addEventListener('click', () => {
  if (state.selected) showModal(state.selected.id);
  else toast('Choose a product and click Buy Now to start your order.');
});
$('#menuToggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('mobile-nav-open');
  $('#menuToggle').setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('.primary-nav a').forEach(a => a.addEventListener('click', () => document.body.classList.remove('mobile-nav-open')));
$('#checkoutForm').addEventListener('submit', async event => {
  event.preventDefault(); if (!state.selected) return;
  const error = $('#checkoutError'); error.classList.add('hidden');
  const quantity = Number($('#quantity').value);
  const email = $('#buyerEmail').value.trim();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > state.selected.stock) {
    error.textContent = 'دخل كمية صحيحة وما تفوتش المخزون المتوفر'; error.classList.remove('hidden'); return;
  }
  if (!state.checkoutReady) { error.textContent = 'الشراء لم يتم تفعيله بعد'; error.classList.remove('hidden'); return; }
  const button = $('#payButton'); button.disabled = true; button.textContent = 'Creating secure order...';
  try {
    const result = await fetch('/api/checkout/usdt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: state.selected.id, quantity, email }) });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error || 'Checkout unavailable');
    sessionStorage.setItem('ez_usdt_' + data.orderId, JSON.stringify(data));
    window.location.assign('/usdt.html?order=' + encodeURIComponent(data.orderId));
  } catch (e) {
    error.textContent = e.message; error.classList.remove('hidden');
    button.disabled = false; button.textContent = 'Continue to payment →';
    await loadProducts();
  }
});
loadProducts();
setInterval(() => { if (document.visibilityState === 'visible' && overlay.classList.contains('hidden')) loadProducts(); }, 45000);
