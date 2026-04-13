// ---- State ----
const state = {
  tickets: [],       // { key, summary, url, status, issueType, changelog, description, uiState, improved }
  total: 0,
  startAt: 0,
  maxResults: 50,
  activeFilter: 'all',
  improvingAll: false,
};
// uiState values: 'pending' | 'improving' | 'improved' | 'approving' | 'approved' | 'error'

// ---- DOM helpers ----
const $ = id => document.getElementById(id);

function toast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---- Filtering ----
function visibleTickets() {
  const f = state.activeFilter;
  return state.tickets.filter(t => {
    if (f === 'all')      return true;
    if (f === 'empty')    return !t.changelog.trim();
    if (f === 'improved') return t.uiState === 'improved';
    if (f === 'approved') return t.uiState === 'approved';
    return true;
  });
}

// ---- Stats bar ----
function renderStats() {
  const total    = state.tickets.length;
  const improved = state.tickets.filter(t => t.uiState === 'improved').length;
  const approved = state.tickets.filter(t => t.uiState === 'approved').length;
  const empty    = state.tickets.filter(t => !t.changelog.trim()).length;

  $('stats').innerHTML = `
    <span class="stat"><span class="stat-dot pending"></span>${total} ticket${total !== 1 ? 's' : ''}</span>
    ${empty    ? `<span class="stat"><span class="stat-dot pending"></span>${empty} no changelog</span>` : ''}
    ${improved ? `<span class="stat"><span class="stat-dot improved"></span>${improved} improved</span>` : ''}
    ${approved ? `<span class="stat"><span class="stat-dot approved"></span>${approved} approved</span>` : ''}
    ${state.total > state.tickets.length ? `<span class="stat">${state.total} total in Jira</span>` : ''}
  `;

  $('approveAllBtn').disabled = improved === 0;
}

// ---- Render a single card ----
function renderCard(ticket) {
  const card = document.createElement('div');
  card.className = `ticket-card state-${ticket.uiState}`;
  card.dataset.key = ticket.key;
  card.innerHTML = cardHTML(ticket);
  bindCardEvents(card, ticket);
  return card;
}

function cardHTML(t) {
  const originalText = t.changelog.trim()
    ? escHtml(t.changelog)
    : '<em>No changelog entry</em>';
  const originalClass = t.changelog.trim() ? '' : 'empty';

  const busy          = ['improving', 'approving', 'unlabelling'].includes(t.uiState);
  const done          = t.uiState === 'approved' || t.uiState === 'unlabelled';
  const improveLabel  = t.uiState === 'improving' ? 'Improving…' : (['improved', 'approved'].includes(t.uiState) ? 'Re-improve' : 'Improve');
  const improveDis    = busy || done;
  const approveDis    = t.uiState !== 'improved' || busy;
  const unlabelDis    = busy || done;

  let improvedSection = '';
  if (t.uiState === 'improving') {
    improvedSection = `
      <div class="changelog-block">
        <div class="block-label">Improved changelog</div>
        <div class="improving-indicator"><span class="spinner"></span>Claude is rewriting…</div>
      </div>`;
  } else if (t.uiState === 'improved') {
    improvedSection = `
      <div class="changelog-block">
        <div class="block-label">Improved changelog <span style="color:var(--text-muted);font-weight:400;text-transform:none;letter-spacing:0">(editable)</span></div>
        <textarea class="changelog-improved" rows="3">${escHtml(t.improved)}</textarea>
      </div>`;
  } else if (t.uiState === 'approved') {
    improvedSection = `
      <div class="changelog-block">
        <div class="block-label">Written to Jira</div>
        <div class="changelog-original">${escHtml(t.improved)}</div>
        <div class="approved-badge">&#10003; Changelog saved &amp; TW label removed</div>
      </div>`;
  } else if (t.uiState === 'unlabelled') {
    improvedSection = `<div class="approved-badge" style="margin-top:8px">&#10003; TW label removed</div>`;
  } else if (t.uiState === 'error') {
    improvedSection = `<div class="error-msg">&#9888; ${escHtml(t.error || 'Something went wrong. Try again.')}</div>`;
  }

  return `
    <div class="card-header">
      <div class="card-meta">
        <a href="${t.url}" target="_blank" rel="noopener" class="ticket-key">${t.key}</a>
        <span class="badge">${escHtml(t.status)}</span>
        <span class="badge badge-type">${escHtml(t.issueType)}</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm btn-improve" ${improveDis ? 'disabled' : ''}>${improveLabel}</button>
        <button class="btn btn-success btn-sm btn-approve" ${approveDis ? 'disabled' : ''}>Approve</button>
        <button class="btn btn-secondary btn-sm btn-unlabel" ${unlabelDis ? 'disabled' : ''}>Remove label</button>
      </div>
    </div>
    <div class="ticket-summary">${escHtml(t.summary)}</div>
    <div class="changelog-block">
      <div class="block-label">Original changelog</div>
      <div class="changelog-original ${originalClass}">${originalText}</div>
    </div>
    ${improvedSection}
  `;
}

function bindCardEvents(card, ticket) {
  card.querySelector('.btn-improve')?.addEventListener('click', () => improveTicket(ticket.key));
  card.querySelector('.btn-approve')?.addEventListener('click', () => approveTicket(ticket.key));
  card.querySelector('.btn-unlabel')?.addEventListener('click', () => unlabelTicket(ticket.key));

  // Keep improved text in sync as user edits
  const ta = card.querySelector('.changelog-improved');
  if (ta) {
    ta.addEventListener('input', () => {
      const t = state.tickets.find(x => x.key === ticket.key);
      if (t) t.improved = ta.value;
    });
  }
}

// ---- Re-render a single card in place ----
function refreshCard(key) {
  const ticket = state.tickets.find(t => t.key === key);
  if (!ticket) return;
  const existing = document.querySelector(`.ticket-card[data-key="${key}"]`);
  if (!existing) return;

  // Preserve textarea content if user is editing
  const ta = existing.querySelector('.changelog-improved');
  if (ta) ticket.improved = ta.value;

  const newCard = renderCard(ticket);
  existing.replaceWith(newCard);
}

// ---- Render full list ----
function renderList() {
  const main = $('main');
  main.innerHTML = '';

  const visible = visibleTickets();
  if (visible.length === 0) {
    main.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128269;</div><p>No tickets match this filter.</p></div>`;
    return;
  }

  visible.forEach(ticket => main.appendChild(renderCard(ticket)));
  renderStats();
}

// ---- Fetch tickets from backend ----
async function fetchTickets(loadMore = false) {
  const btn = $('fetchBtn');
  btn.disabled = true;
  btn.textContent = 'Fetching…';

  if (!loadMore) {
    state.tickets = [];
    state.startAt = 0;
    $('main').innerHTML = '<div class="loading-bar"><span class="spinner"></span>Loading tickets from Jira…</div>';
  }

  try {
    const res = await fetch(`/api/tickets?startAt=${state.startAt}&maxResults=${state.maxResults}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch tickets');

    const newTickets = data.tickets.map(t => ({
      ...t,
      uiState: 'pending',
      improved: '',
      error: '',
    }));

    state.tickets = loadMore ? [...state.tickets, ...newTickets] : newTickets;
    state.total   = data.total;
    state.startAt = data.startAt + newTickets.length;

    $('toolbar').style.display = '';
    renderList();
    renderPagination();
    renderStats();
    toast(`Loaded ${newTickets.length} ticket${newTickets.length !== 1 ? 's' : ''}`, 'success');
  } catch (err) {
    $('main').innerHTML = `<div class="empty-state"><p style="color:var(--danger)">&#9888; ${escHtml(err.message)}</p></div>`;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch tickets';
  }
}

// ---- Improve a single ticket ----
async function improveTicket(key) {
  const ticket = state.tickets.find(t => t.key === key);
  if (!ticket) return;

  ticket.uiState = 'improving';
  ticket.error = '';
  refreshCard(key);

  try {
    const res = await fetch('/api/improve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: ticket.key,
        summary: ticket.summary,
        changelog: ticket.changelog,
        description: ticket.description,
        issueType: ticket.issueType,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Improvement failed');

    ticket.uiState = 'improved';
    ticket.improved = data.improved;
  } catch (err) {
    ticket.uiState = 'error';
    ticket.error = err.message;
    toast(`${key}: ${err.message}`, 'error');
  }

  refreshCard(key);
  renderStats();
}

// ---- Approve (write to Jira) ----
async function approveTicket(key) {
  const ticket = state.tickets.find(t => t.key === key);
  if (!ticket || ticket.uiState !== 'improved') return;

  // Capture latest textarea value before state change
  const ta = document.querySelector(`.ticket-card[data-key="${key}"] .changelog-improved`);
  if (ta) ticket.improved = ta.value;

  ticket.uiState = 'approving';
  refreshCard(key);

  try {
    const res = await fetch(`/api/tickets/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changelog: ticket.improved }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to write to Jira');

    ticket.uiState = 'approved';
    toast(`${key} saved to Jira`, 'success');
  } catch (err) {
    ticket.uiState = 'improved'; // allow retry
    ticket.error = err.message;
    toast(`${key}: ${err.message}`, 'error');
  }

  refreshCard(key);
  renderStats();
}

// ---- Remove TW label only ----
async function unlabelTicket(key) {
  const ticket = state.tickets.find(t => t.key === key);
  if (!ticket) return;

  ticket.uiState = 'unlabelling';
  ticket.error = '';
  refreshCard(key);

  try {
    const res = await fetch(`/api/tickets/${key}/unlabel`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove label');

    ticket.uiState = 'unlabelled';
    toast(`${key} TW label removed`, 'success');
  } catch (err) {
    ticket.uiState = 'pending'; // allow retry
    ticket.error = err.message;
    toast(`${key}: ${err.message}`, 'error');
  }

  refreshCard(key);
  renderStats();
}

// ---- Improve all pending tickets (up to 5 concurrent) ----
async function improveAll() {
  if (state.improvingAll) return;
  state.improvingAll = true;
  $('improveAllBtn').disabled = true;
  $('improveAllBtn').textContent = 'Improving…';

  const pending = state.tickets.filter(t => t.uiState === 'pending' || t.uiState === 'error');
  const CONCURRENCY = 5;

  async function processQueue(queue) {
    while (queue.length > 0) {
      const batch = queue.splice(0, CONCURRENCY);
      await Promise.allSettled(batch.map(t => improveTicket(t.key)));
    }
  }

  await processQueue([...pending]);

  state.improvingAll = false;
  $('improveAllBtn').disabled = false;
  $('improveAllBtn').textContent = 'Improve all';
  toast('All tickets improved', 'success');
}

// ---- Approve all improved tickets ----
async function approveAll() {
  const improved = state.tickets.filter(t => t.uiState === 'improved');
  $('approveAllBtn').disabled = true;

  for (const t of improved) {
    await approveTicket(t.key);
  }

  toast(`${improved.length} ticket${improved.length !== 1 ? 's' : ''} written to Jira`, 'success');
  renderStats();
}

// ---- Pagination ----
function renderPagination() {
  const pag = $('pagination');
  const info = $('paginationInfo');

  if (state.startAt >= state.total) {
    pag.style.display = 'none';
  } else {
    pag.style.display = '';
    info.textContent = `Showing ${state.tickets.length} of ${state.total}`;
  }
}

// ---- Utility ----
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Event listeners ----
$('fetchBtn').addEventListener('click', () => fetchTickets(false));
$('loadMoreBtn')?.addEventListener('click', () => fetchTickets(true));
$('improveAllBtn').addEventListener('click', improveAll);
$('approveAllBtn').addEventListener('click', approveAll);

$('filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.activeFilter = btn.dataset.filter;
  renderList();
});
