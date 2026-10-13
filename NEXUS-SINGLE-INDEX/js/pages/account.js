import { profileFor, accountForUser } from '../supabase.js';
import { requireUser, logout, nav } from './common.js';

const isAccountRoute = () => {
  const route = (location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
  return route === 'account';
};
const byId = (id) => document.getElementById(id);
const setText = (id, value) => {
  const el = byId(id);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
};

const logoutButton = byId('logoutBtn');
if (logoutButton) logoutButton.onclick = logout;
const navElement = byId('nav');
if (navElement) navElement.innerHTML = nav('home');

const runId = (window.__nexusAccountRunId = (window.__nexusAccountRunId || 0) + 1);
const isCurrentRun = () => window.__nexusAccountRunId === runId && isAccountRoute();

window.addEventListener('nexus-account-state', (event) => {
  if (!isCurrentRun()) return;
  const account = event.detail?.account;
  const profile = event.detail?.profile;
  if (account?.status || profile?.status) setText('status', account?.status || profile?.status);
});

requireUser(async (user) => {
  if (!isCurrentRun()) return;

  // Render information that is already known immediately. A failure in one
  // lookup should not blank every field on the page.
  setText('email', user?.email || '—');
  setText('name', 'Loading…');
  setText('account', 'Loading…');
  setText('currency', 'Loading…');
  setText('routing', 'Loading…');
  setText('status', 'Loading…');

  let profile = null;
  let account = null;
  let profileError = null;
  let accountError = null;

  // Use the same profile RPC and account helper as the rest of the app.
  // This avoids direct-table selects of optional columns that may not exist
  // in every deployed schema version.
  const results = await Promise.allSettled([
    profileFor(user.id),
    accountForUser(user.id)
  ]);
  if (!isCurrentRun()) return;

  if (results[0].status === 'fulfilled') profile = results[0].value;
  else profileError = results[0].reason;
  if (results[1].status === 'fulfilled') account = results[1].value;
  else accountError = results[1].reason;

  setText('name', profile?.full_name || profile?.name || '—');
  setText('account', account?.account_number || '—');
  setText('currency', account?.currency || '—');
  setText('routing', account?.routing_number || account?.routing_identifier || account?.routing_number || '—');
  setText('status', account?.status || profile?.status || '—');

  if (profileError) {
    console.error('[NEXUS account] Profile lookup failed:', profileError?.message || profileError);
  }
  if (accountError) {
    console.error('[NEXUS account] Account lookup failed:', accountError?.message || accountError);
  }
  if (profileError || accountError) {
    // Keep any fields that loaded successfully and provide a useful status
    // instead of leaving the entire page as placeholder dashes.
    if (!profile && !account) setText('status', 'Account details temporarily unavailable');
  }
});
