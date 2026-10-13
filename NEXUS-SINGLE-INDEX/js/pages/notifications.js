import {supabase,formatDate,escapeHtml} from '../supabase.js';
import {requireUser,logout,$,nav,wireHeaderBadge} from './common.js';

const logoutButton=$('logoutBtn');
if(logoutButton) logoutButton.onclick=logout;
const navElement=$('nav');
if(navElement) navElement.innerHTML=nav('home');

let uid;
let selected;

function render(data){
  const list=$('list');
  if(!list) return;

  list.innerHTML=data.length
    ? data.map(n=>`<button class="list-item notification-item ${n.is_read?'':'unread'}" style="text-align:left;cursor:pointer" data-id="${escapeHtml(n.id)}"><div><strong>${escapeHtml(n.title||n.type||'NEXUS notification')}</strong><div class="muted">${escapeHtml(n.message||'')}</div><div class="muted" style="margin-top:5px">${formatDate(n.created_at)}</div></div><span class="status-pill ${n.is_read?'':'pending'}">${n.is_read?'Read':'New'}</span></button>`).join('')
    : '<div class="hint">No notifications yet.</div>';

  list.querySelectorAll('[data-id]').forEach(button=>{
    button.onclick=()=>open(data.find(item=>String(item.id)===button.dataset.id));
  });
}

async function load(){
  if(!uid) return;
  const {data,error}=await supabase
    .from('notifications')
    .select('*')
    .eq('user_id',uid)
    .eq('is_deleted',false)
    .order('created_at',{ascending:false})
    .limit(150);
  if(error) throw error;
  render(data||[]);
}

async function open(notification){
  if(!notification) return;
  selected=notification;
  const detail=$('detail');
  const modal=$('detailModal');
  if(!detail||!modal) return;

  detail.innerHTML=`<div class="notification-detail"><span class="eyebrow">${escapeHtml(notification.type||'system')}</span><h2>${escapeHtml(notification.title||'NEXUS notification')}</h2><p class="muted">${formatDate(notification.created_at)}</p><div class="notice">${escapeHtml(notification.message||'')}</div>${notification.transaction_id?'<a class="btn btn-primary" style="display:inline-block;margin-top:12px;text-decoration:none" href="pages/transactions/#'+encodeURIComponent(notification.transaction_id)+'">Open Transaction History</a>':''}</div>`;
  modal.classList.add('show');

  const {error}=await supabase.from('notifications')
    .update({is_read:true})
    .eq('id',notification.id)
    .eq('user_id',uid);
  if(error) console.warn('[NEXUS notifications] Could not mark notification as read:',error);
  try{await load();}catch(error){console.warn('[NEXUS notifications] Refresh after opening failed:',error);}
}

const closeButton=$('closeBtn');
if(closeButton) closeButton.onclick=()=>{const modal=$('detailModal');if(modal)modal.classList.remove('show');};

const deleteButton=$('deleteBtn');
if(deleteButton) deleteButton.onclick=async()=>{
  if(!selected) return;
  const {error}=await supabase.from('notifications')
    .update({is_deleted:true,is_read:true})
    .eq('id',selected.id)
    .eq('user_id',uid);
  if(error){console.warn('[NEXUS notifications] Could not delete notification:',error);return;}
  selected=null;
  const modal=$('detailModal');
  if(modal) modal.classList.remove('show');
  try{await load();}catch(refreshError){console.warn('[NEXUS notifications] Refresh after delete failed:',refreshError);}
};

const readAllButton=$('readAll');
if(readAllButton) readAllButton.onclick=async()=>{
  const {error}=await supabase.from('notifications')
    .update({is_read:true})
    .eq('user_id',uid)
    .eq('is_deleted',false);
  if(error){console.warn('[NEXUS notifications] Could not mark all as read:',error);return;}
  try{await load();}catch(refreshError){console.warn('[NEXUS notifications] Refresh after marking all as read failed:',refreshError);}
};

// Supabase Realtime channels cannot accept new postgres_changes handlers after
// subscribe() has been called. Keep one channel per signed-in user across
// repeated page initialization, and register the handler before subscribing.
function ensureNotificationRealtime(userId){
  if(!userId) return;
  const registryKey='__nexusNotificationRealtimeChannels';
  if(!window[registryKey]) window[registryKey]=Object.create(null);
  if(window[registryKey][userId]) return window[registryKey][userId];

  const channel=supabase
    .channel(`nexus-notifications-${userId}`)
    .on('postgres_changes',{
      event:'*',
      schema:'public',
      table:'notifications',
      filter:`user_id=eq.${userId}`
    },()=>{
      // A realtime event should never interrupt the notifications screen.
      if(uid!==userId) return;
      load().catch(error=>console.warn('[NEXUS notifications] Realtime refresh failed:',error));
    });

  // Store before subscribing so a repeated initializer cannot attach a
  // second callback to a channel that is already subscribed.
  window[registryKey][userId]=channel;
  channel.subscribe(status=>{
    if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){
      console.warn('[NEXUS notifications] Realtime channel status:',status);
    }
  });
  return channel;
}

requireUser(async user=>{
  uid=user.id;
  try{await load();}catch(error){console.warn('[NEXUS notifications] Initial notification load failed:',error);}
  await wireHeaderBadge(uid);
  ensureNotificationRealtime(uid);
});
