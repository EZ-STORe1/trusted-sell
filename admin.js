'use strict';
const $ = query => document.querySelector(query);
const dollars = cents => '$' + (cents / 100).toFixed(2);
const api = async (endpoint, options = {}) => {
  const result = await fetch(endpoint, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || 'Server error');
  return data;
};
let products = [];
let savedPage = 1;
let savedTotal = 0;
function visibleLogin() { $('#loginPanel').classList.remove('hidden'); $('#dashboard').classList.add('hidden'); }
function visibleDashboard() { $('#dashboard').classList.remove('hidden'); $('#loginPanel').classList.add('hidden'); }
function status(text) { $('#dashboardStatus').textContent = text; }
function node(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value != null) el.textContent = value;
  return el;
}
async function loadAdmin() {
  const summary = await api('/api/admin/summary');
  visibleDashboard();
  await loadSaved();
  const stock = Object.fromEntries(products.map(p => [p.id, { available: 0, reserved: 0, sold: 0 }]));
  for (const rec of summary.stock) if (stock[rec.product_id]) stock[rec.product_id][rec.status] = rec.n;
  $('#statTotal').textContent = summary.totalInventory.toLocaleString() + ' / 10,000';
  $('#statAvailable').textContent = Object.values(stock).reduce((acc, s) => acc + s.available, 0).toLocaleString();
  $('#statOrders').textContent = summary.sales.n.toLocaleString();
  $('#statRevenue').textContent = dollars(summary.sales.cents);
  const container = $('#stockTable'); container.replaceChildren();
  for (const p of products) {
    const row = node('div', 'stock-row');
    const symbol = node('span', `stock-symbol theme-${p.theme}`, p.symbol);
    const col = node('div', 'stock-product'); col.append(node('strong', '', p.name), node('small', '', `${dollars(p.priceCents)} / item`));
    const qty = node('span', stock[p.id].available ? 'stock-yes' : 'stock-no', stock[p.id].available ? `${stock[p.id].available} available` : 'Sold out');
    row.append(symbol, col, qty); container.append(row);
  }
  const tbody = $('#ordersTable'); tbody.replaceChildren();
  if (!summary.orders.length) {
    const tr = node('tr'); const td = node('td', '', 'No orders yet.'); td.colSpan = 8; tr.append(td); tbody.append(tr);
  }
  for (const order of summary.orders) {
    const tr = node('tr');
    const idTd = node('td'); idTd.append(node('strong', '', order.id.slice(0, 8)), node('small', '', new Date(order.created_at).toLocaleString()));
    tr.append(idTd);
    const pname = products.find(p => p.id === order.product_id)?.name || order.product_id;
    tr.append(node('td', '', pname), node('td', '', order.email), node('td', '', String(order.quantity)), node('td', '', dollars(order.total_cents)));
    tr.append(node('td', order.status === 'paid' ? 'stock-yes' : 'stock-no', order.status));
    tr.append(node('td', order.delivery_status === 'sent' ? 'stock-yes' : '', order.delivery_status));
    const actions = node('td');
    if (order.usdt_txid && order.status === 'pending') {
      const tx = node('div', '', 'TRC20 TXID: '+order.usdt_txid); tx.style.overflowWrap='anywhere'; actions.append(tx);
      const link = node('a', 'table-action', 'View on TronScan'); link.href='https://tronscan.org/#/transaction/'+order.usdt_txid; link.target='_blank'; link.rel='noopener noreferrer'; actions.append(link);
      const verify=node('button','table-action','Confirm verified USDT');
      verify.addEventListener('click',async()=>{if(!confirm('Have you independently verified the correct USDT TRC20 token, recipient address, exact amount, confirmations and that this TXID was not previously used? This will deliver the items.'))return;verify.disabled=true;try{await api('/api/admin/orders/'+order.id+'/confirm-usdt',{method:'POST'});await loadAdmin();}catch(e){status(e.message);verify.disabled=false;}});actions.append(verify);
      const reject=node('button','table-action','Reject claim');reject.addEventListener('click',async()=>{if(!confirm('Reject claim and release stock?'))return;try{await api('/api/admin/orders/'+order.id+'/reject-usdt',{method:'POST'});await loadAdmin();}catch(e){status(e.message);}});actions.append(reject);
    }
    if (order.status === 'paid' && ['failed', 'pending'].includes(order.delivery_status)) {
      const resend = node('button', 'table-action', 'Retry email');
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try { const result = await api(`/api/admin/orders/${order.id}/resend`, { method: 'POST' }); status('Email status: ' + result.deliveryStatus); await loadAdmin(); }
        catch (error) { status(error.message); resend.disabled = false; }
      }); actions.append(resend);
    }
    tr.append(actions); tbody.append(tr);
  }
}
async function initialize() {
  try {
    products = (await api('/api/products')).products;
    const select = $('#productSelect'); select.replaceChildren();
    for (const p of products) { const option = document.createElement('option'); option.value = p.id; option.textContent = `${p.name} — ${dollars(p.priceCents)}`; select.append(option); }
    const savedSelect = $('#savedProductSelect'); savedSelect.replaceChildren();
    for (const p of products) { const option = node('option', '', p.name); option.value = p.id; savedSelect.append(option); }
    await api('/api/admin/me'); await loadAdmin();
  } catch (_) { visibleLogin(); }
}
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  $('#loginError').classList.add('hidden');
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: $('#adminEmail').value, password: $('#adminPassword').value }) });
    $('#adminPassword').value = ''; await loadAdmin();
  } catch (error) {
    $('#loginError').textContent = error.message; $('#loginError').classList.remove('hidden');
  } finally { button.disabled = false; }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (_) { /* Expired sessions are logged out locally too */ }
  visibleLogin();
});
$('#accountLines').addEventListener('input', () => {
  $('#lineCount').textContent = $('#accountLines').value.split(/\r?\n/).filter(s => s.trim()).length.toLocaleString();
});
$('#inventoryForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#inventoryError').classList.add('hidden'); $('#inventorySuccess').classList.add('hidden');
  const button = $('#inventorySubmit'); button.disabled = true; button.textContent = 'Adding securely...';
  try {
    const result = await api('/api/admin/inventory', { method: 'POST', body: JSON.stringify({ productId: $('#productSelect').value, lines: $('#accountLines').value }) });
    $('#inventorySuccess').textContent = `✅ ${result.added} حساب تزاد بنجاح. ${result.duplicates} مكرر. المجموع: ${result.total} / 10000`;
    $('#inventorySuccess').classList.remove('hidden'); $('#accountLines').value = ''; $('#lineCount').textContent = '0'; await loadAdmin();
  } catch (error) { $('#inventoryError').textContent = error.message; $('#inventoryError').classList.remove('hidden'); }
  finally { button.disabled = false; button.textContent = '+ Add to inventory'; }
});
void initialize();
setInterval(() => { if (!$('#dashboard').classList.contains('hidden') && document.visibilityState === 'visible') loadAdmin().catch(() => {}); }, 60000);

async function loadSaved() {
  const select = $('#savedProductSelect');
  if (!select.value) return;
  const box = $('#savedAccounts'); box.replaceChildren();
  $('#savedError').textContent = '';
  try {
    const result = await api(`/api/admin/inventory/items?productId=${encodeURIComponent(select.value)}&page=${savedPage}`);
    savedTotal = result.total;
    $('#savedCount').textContent = `${savedTotal} saved account(s) • 50 per page`;
    $('#savedPage').textContent = `Page ${savedPage} / ${Math.max(1,Math.ceil(savedTotal/50))}`;
    $('#savedPrev').disabled = savedPage <= 1;
    $('#savedNext').disabled = savedPage * 50 >= savedTotal;
    if (!result.items.length) box.append(node('p', 'form-hint', 'No saved accounts on this page.'));
    for (const item of result.items) {
      const row = node('div', 'saved-row');
      const details = node('div', 'saved-detail');
      details.append(node('small', '', `#${item.id} • ${item.status} • ${new Date(item.createdAt).toLocaleString()}`));
      const value = node('code', 'saved-secret', item.value); details.append(value);
      const actions = node('div', 'saved-actions');
      const copy = node('button', 'table-action', 'Copy'); copy.type='button';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(item.value); copy.textContent='Copied'; } catch { $('#savedError').textContent='Copy failed'; } });
      actions.append(copy);
      if (item.status === 'available') {
        const del = node('button', 'table-action', 'Delete'); del.type='button';
        del.addEventListener('click', async () => {
          if (!confirm(`Delete saved account #${item.id}? This cannot be undone.`)) return;
          del.disabled=true;
          try { await api(`/api/admin/inventory/items/${item.id}`, {method:'DELETE'}); await loadAdmin(); }
          catch(e) { $('#savedError').textContent=e.message; del.disabled=false; }
        }); actions.append(del);
      }
      row.append(details, actions); box.append(row);
    }
  } catch(e) { $('#savedError').textContent=e.message; }
}
$('#savedProductSelect').addEventListener('change', () => { savedPage=1; loadSaved(); });
$('#refreshSaved').addEventListener('click', loadSaved);
$('#savedPrev').addEventListener('click', () => { if(savedPage>1) { savedPage--; loadSaved(); } });
$('#savedNext').addEventListener('click', () => { if(savedPage*50<savedTotal) { savedPage++; loadSaved(); } });

// Bulk delete available accounts only, protected by the existing admin session.
$('#bulkDeleteForm').addEventListener('submit', async event => {
  event.preventDefault();
  const quantity = Number($('#bulkDeleteQuantity').value);
  const productId = $('#savedProductSelect').value;
  const productName = products.find(p => p.id === productId)?.name || productId;
  const message = $('#bulkDeleteStatus');
  message.textContent = '';
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
    message.textContent = 'Enter a valid number from 1 to 10000.'; return;
  }
  if (!confirm(`Permanently delete ${quantity} AVAILABLE account(s) from ${productName}? Sold and reserved accounts will NOT be touched.`)) return;
  const button = $('#bulkDeleteButton'); button.disabled = true;
  try {
    const result = await api('/api/admin/inventory/bulk-delete', {
      method: 'POST', body: JSON.stringify({ productId, quantity })
    });
    message.textContent = `${result.deleted} account(s) deleted successfully.`;
    savedPage = 1;
    await loadAdmin();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
