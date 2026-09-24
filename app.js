const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBuCWVloW2QxsX40IfUIReBg7HWZCzty_I",
  authDomain: "rod-of-discord.firebaseapp.com",
  projectId: "rod-of-discord",
  storageBucket: "rod-of-discord.firebasestorage.app",
  messagingSenderId: "881588222910",
  appId: "1:881588222910:web:96d0bf399f2ef8133817ef"
};

let db = null, auth = null, storage = null;
let nickname = '';
let pendingAvatarBlob = null;
let pendingAvatarRemoved = false;
let clientId = localStorage.getItem('hangout_client_id');

if (!clientId) {
  clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('hangout_client_id', clientId);
}

let currentChannel = 'general';
let unsubMessages = null, unsubPresence = null;
let latestPeers = [];
let presenceId = clientId;
let authMode = 'login';

const COLORS = ['#d95763', '#d99a3d', '#2f9e8f', '#c66b9b', '#6f8fc7', '#8b7bb8'];
const STATUS_META = {
  online: { label: 'Online', color: '#23a559' },
  idle: { label: 'Idle', color: '#f0b132' },
  dnd: { label: 'Do Not Disturb', color: '#f23f42' },
  invisible: { label: 'Invisible', color: '#80848e' }
};

// ---------- Profile (status / custom message / color) ----------
let myProfile = { status: 'online', statusText: '', color: null };

(function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('hangout_profile_' + clientId) || 'null');
    if (saved) myProfile = Object.assign(myProfile, saved);
  } catch (e) {}
})();

function saveProfileLocal() {
  try {
    localStorage.setItem('hangout_profile_' + clientId, JSON.stringify(myProfile));
  } catch (e) {}
}

function statusColor(status) {
  return (STATUS_META[status] || STATUS_META.online).color;
}

function peerColor(p) {
  return (p && p.color) || colorFor(p ? p.name : '?');
}

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

function handleFor(name) {
  return (name || 'someone').trim().toLowerCase().replace(/\s+/g, '_');
}

function uniquePeers(peers) {
  const byName = new Map();
  peers.forEach(peer => {
    if (!peer.name) return;
    const key = peer.name.trim().toLowerCase();
    const current = byName.get(key);
    if (!current || (peer.ts || 0) > (current.ts || 0)) byName.set(key, peer);
  });
  return [...byName.values()];
}

function fmtTime(ts) {
  if (!ts) return 'sending…';
  const millis = typeof ts.toMillis === 'function' ? ts.toMillis() : ts;
  return new Date(millis).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function normalizeUsername(value) {
  return value.trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9._-]{3,24}$/.test(value);
}

function usernameToEmail(u) {
  return normalizeUsername(u) + '@hangout.local';
}

function formatMessage(text) {
  let html = escapeHtml(text);
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (match, prefix, value) => {
    const trailing = value.match(/[.,!?;:)]+$/)?.[0] || '';
    const url = value.slice(0, value.length - trailing.length);
    const href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    return prefix + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + trailing;
  });
  latestPeers.forEach(peer => {
    if (!peer.name) return;
    const mention = '@' + escapeHtml(peer.name);
    html = html.replace(new RegExp('(^|\\s)(' + mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=\\s|$)', 'gi'), '$1<span class="mention">$2</span>');
  });
  return html;
}

// ---------- Auth UI ----------
function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  document.getElementById('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  document.getElementById('auth-password-confirm').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('auth-password-confirm').value = '';
  document.getElementById('auth-error').style.display = 'none';
}

document.getElementById('tab-login').onclick = () => setAuthMode('login');
document.getElementById('tab-register').onclick = () => setAuthMode('register');

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function friendlyAuthError(code) {
  const map = {
    'auth/email-already-in-use': 'That username is already taken.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/user-not-found': 'No account with that username.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Wrong username or password.',
    'auth/invalid-email': 'Username has unsupported characters — use letters, numbers, dots, underscores, or hyphens.',
    'auth/network-request-failed': 'Could not reach Firebase. Check your internet connection.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/operation-not-allowed': 'Email/password sign-in is disabled in Firebase Authentication.'
  };
  return map[code] || 'Something went wrong. Try again.';
}

async function submitAuth() {
  const username = document.getElementById('auth-username').value.trim();
  const normalizedUsername = normalizeUsername(username);
  const password = document.getElementById('auth-password').value;

  if (!username || !password) {
    showAuthError('Enter a username and password.');
    return;
  }
  if (!validUsername(normalizedUsername)) {
    showAuthError('Username must be 3–24 characters: letters, numbers, dots, underscores, or hyphens.');
    return;
  }
  if (authMode === 'register') {
    const confirm = document.getElementById('auth-password-confirm').value;
    if (password !== confirm) {
      showAuthError('Passwords do not match.');
      return;
    }
  }
  if (!auth) {
    showAuthError('Not connected to Firebase yet.');
    return;
  }

  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  const email = usernameToEmail(normalizedUsername);

  try {
    if (authMode === 'register') {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: normalizedUsername });
      nickname = normalizedUsername;
      document.getElementById('nick-display').textContent = nickname;
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (e) {
    showAuthError(friendlyAuthError(e.code));
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('auth-submit').onclick = submitAuth;
document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
document.getElementById('auth-password-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
document.getElementById('logout-btn').onclick = () => { if (auth) auth.signOut(); };

// ---------- Profile modal ----------
const profileModal = document.getElementById('profile-modal');

function updateMyBadge() {
  const meta = STATUS_META[myProfile.status] || STATUS_META.online;
  const el = document.getElementById('my-avatar');
  if (myProfile.avatarUrl) {
    el.style.background = 'transparent';
    el.innerHTML = `<img src="${escapeHtml(myProfile.avatarUrl)}" alt="">`;
  } else {
    el.style.background = myProfile.color || colorFor(nickname || '?');
    el.textContent = initials(nickname);
  }
  document.getElementById('my-status-dot').style.background = meta.color;
  document.getElementById('my-status-text').textContent = myProfile.statusText || meta.label;
}

function showProfileError(msg) {
  const el = document.getElementById('profile-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function friendlyStorageError(code) {
  const map = {
    'storage/unauthorized': 'Not allowed to upload — check Firebase Storage rules.',
    'storage/canceled': 'Upload canceled.',
    'storage/quota-exceeded': 'Storage quota exceeded.',
    'storage/unknown': 'Upload failed. Try a different image.'
  };
  return map[code] || 'Could not upload photo. Try again.';
}

function resizeImageToBlob(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process image')), 'image/jpeg', 0.85);
      };
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function uploadAvatar(blob) {
  if (!storage) throw { code: 'storage/unknown', message: 'Storage is not available' };
  const uid = (auth.currentUser && auth.currentUser.uid) || clientId;
  const ref = storage.ref().child('avatars/' + uid + '.jpg');
  await ref.put(blob, { contentType: 'image/jpeg' });
  return await ref.getDownloadURL();
}

function resetAvatarPreview() {
  pendingAvatarBlob = null;
  pendingAvatarRemoved = false;
  document.getElementById('avatar-file-input').value = '';
  const el = document.getElementById('avatar-preview');
  if (myProfile.avatarUrl) {
    el.style.background = 'transparent';
    el.innerHTML = `<img src="${escapeHtml(myProfile.avatarUrl)}" alt="">`;
  } else {
    el.style.background = myProfile.color || colorFor(nickname || '?');
    el.textContent = initials(nickname);
  }
}

document.getElementById('avatar-file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showProfileError('Please choose an image file.');
    return;
  }
  document.getElementById('profile-error').style.display = 'none';
  try {
    const blob = await resizeImageToBlob(file, 128);
    pendingAvatarBlob = blob;
    pendingAvatarRemoved = false;
    const previewUrl = URL.createObjectURL(blob);
    const el = document.getElementById('avatar-preview');
    el.style.background = 'transparent';
    el.innerHTML = `<img src="${previewUrl}" alt="">`;
  } catch (err) {
    showProfileError(err.message || 'Could not process that image.');
  }
});

document.getElementById('avatar-remove-btn').onclick = () => {
  pendingAvatarBlob = null;
  pendingAvatarRemoved = true;
  document.getElementById('avatar-file-input').value = '';
  const el = document.getElementById('avatar-preview');
  el.style.background = myProfile.color || colorFor(nickname || '?');
  el.innerHTML = escapeHtml(initials(nickname));
};

function renderColorSwatches() {
  const wrap = document.getElementById('color-swatches');
  const options = COLORS.concat([null]);
  wrap.innerHTML = options.map(c => `<button type="button" class="swatch${(myProfile.color || null) === c ? ' active' : ''}" data-color="${c || ''}" style="background:${c || 'linear-gradient(135deg,#5865f2,#eb459e)'}"></button>`).join('');
  wrap.querySelectorAll('.swatch').forEach(sw => {
    sw.onclick = () => {
      wrap.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      wrap.dataset.selected = sw.dataset.color || '';
    };
  });
  wrap.dataset.selected = myProfile.color || '';
}

function openProfileModal() {
  document.querySelectorAll('.status-option').forEach(b => b.classList.toggle('active', b.dataset.status === myProfile.status));
  document.getElementById('status-text-input').value = myProfile.statusText || '';
  renderColorSwatches();
  resetAvatarPreview();
  document.getElementById('profile-error').style.display = 'none';
  profileModal.style.display = 'flex';
}

function closeProfileModal() {
  profileModal.style.display = 'none';
}

document.getElementById('profile-trigger').onclick = openProfileModal;
document.getElementById('profile-cancel').onclick = closeProfileModal;

document.querySelectorAll('.status-option').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.status-option').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  };
});

document.getElementById('profile-save').onclick = async () => {
  const activeBtn = document.querySelector('.status-option.active');
  myProfile.status = activeBtn ? activeBtn.dataset.status : 'online';
  myProfile.statusText = document.getElementById('status-text-input').value.trim().slice(0, 60);
  const wrap = document.getElementById('color-swatches');
  myProfile.color = wrap.dataset.selected || null;
  document.getElementById('profile-error').style.display = 'none';
  const saveBtn = document.getElementById('profile-save');
  saveBtn.disabled = true;
  saveBtn.textContent = pendingAvatarBlob ? 'Uploading…' : 'Save';
  try {
    if (pendingAvatarRemoved) {
      myProfile.avatarUrl = null;
    }
    if (pendingAvatarBlob) {
      myProfile.avatarUrl = await uploadAvatar(pendingAvatarBlob);
    }
    saveProfileLocal();
    updateMyBadge();
    pushPresence();
    closeProfileModal();
  } catch (err) {
    showProfileError(friendlyStorageError(err.code));
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
};

// ---------- Chat ----------
function renderMessages(docs) {
  const el = document.getElementById('messages');
  if (!docs.length) {
    el.innerHTML = '<div id="empty">No messages yet. Say hi 👋</div>';
    return;
  }
  el.innerHTML = docs.map(m => `
    <div class="msg">
      <div class="avatar" style="${m.avatarUrl ? '' : 'background:' + (m.color || colorFor(m.author || '?'))}">${m.avatarUrl ? '<img src="' + escapeHtml(m.avatarUrl) + '" alt="">' : initials(m.author)}</div>
      <div class="msg-body">
        <div class="top"><span class="author">${escapeHtml(m.author || 'Someone')}</span><span class="time">${fmtTime(m.ts)}</span></div>
        <div class="text">${formatMessage(m.text || '')}</div>
      </div>
    </div>
  `).join('');
  el.scrollTop = el.scrollHeight;
}

function subscribeChannel(ch) {
  if (!db) return;
  if (unsubMessages) unsubMessages();
  document.getElementById('messages').innerHTML = '<div id="empty">Loading...</div>';
  unsubMessages = db.collection('hangout_messages')
    .where('channel', '==', ch).orderBy('ts').limitToLast(200)
    .onSnapshot(snap => renderMessages(snap.docs.map(d => d.data())),
      err => { document.getElementById('messages').innerHTML = '<div id="empty">Could not load messages: ' + escapeHtml(err.message || err.code || 'unknown error') + '</div>'; });
}

document.querySelectorAll('.channel').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('.channel').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    currentChannel = el.dataset.ch;
    document.getElementById('header').textContent = '# ' + currentChannel;
    document.getElementById('msg-input').placeholder = 'Message #' + currentChannel;
    subscribeChannel(currentChannel);
  };
});

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !db) return;
  input.value = '';
  try {
    await db.collection('hangout_messages').add({
      channel: currentChannel,
      author: nickname,
      text,
      color: myProfile.color || null,
      avatarUrl: myProfile.avatarUrl || null,
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    document.getElementById('messages').insertAdjacentHTML('beforeend', '<div id="empty">Send failed: ' + escapeHtml(e.message || e.code || 'unknown error') + '</div>');
  }
}

document.getElementById('send-btn').onclick = sendMessage;
const messageInput = document.getElementById('msg-input');

messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
  if (e.key === 'Escape') document.getElementById('mention-menu').classList.remove('open');
});

function renderMentionMenu() {
  const menu = document.getElementById('mention-menu');
  const cursor = messageInput.selectionStart ?? messageInput.value.length;
  const before = messageInput.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    menu.classList.remove('open');
    return;
  }
  const query = match[1].toLowerCase();
  const members = uniquePeers(latestPeers).filter(p => p.name && p.name.trim().toLowerCase() !== nickname.trim().toLowerCase() && p.name.toLowerCase().includes(query));
  const cutoff = Date.now() - 20000;
  menu.innerHTML = members.map(p => {
    const isOffline = p.ts <= cutoff || p.status === 'invisible';
    const dotColor = isOffline ? STATUS_META.invisible.color : statusColor(p.status || 'online');
    const avatarInner = p.avatarUrl ? '<img src="' + escapeHtml(p.avatarUrl) + '" alt="">' : escapeHtml(initials(p.name));
    const avatarBg = p.avatarUrl ? '' : `background:${peerColor(p)}`;
    return `<button class="mention-option" type="button" data-name="${escapeHtml(p.name)}">
    <span class="member-avatar" style="${avatarBg}">${avatarInner}</span>
    <span class="member-info"><span class="member-name">${escapeHtml(p.name)}</span><span class="member-handle">@${escapeHtml(handleFor(p.name))}</span></span>
    <span class="mention-status" style="background:${dotColor}" title="${isOffline ? 'Offline' : (STATUS_META[p.status] || STATUS_META.online).label}"></span>
  </button>`;
  }).join('') || '<div class="mention-option" style="color:var(--muted)">No matching members</div>';
  menu.classList.add('open');
  menu.querySelectorAll('.mention-option[data-name]').forEach(button => {
    button.onmousedown = e => {
      e.preventDefault();
      const name = button.dataset.name;
      const tokenStart = before.lastIndexOf('@');
      const after = messageInput.value.slice(cursor);
      messageInput.value = messageInput.value.slice(0, tokenStart) + '@' + name + ' ' + after;
      const nextCursor = tokenStart + name.length + 2;
      messageInput.focus();
      messageInput.setSelectionRange(nextCursor, nextCursor);
      renderMentionMenu();
    };
  });
}

messageInput.addEventListener('input', renderMentionMenu);

document.addEventListener('click', e => {
  if (!document.getElementById('input-row').contains(e.target)) document.getElementById('mention-menu').classList.remove('open');
});

function peerRow(p, offline) {
  const dotColor = offline ? STATUS_META.invisible.color : statusColor(p.status || 'online');
  const statusLabel = offline ? 'Offline' : (STATUS_META[p.status] || STATUS_META.online).label;
  const isMe = p.name.trim().toLowerCase() === nickname.trim().toLowerCase();
  const avatarInner = p.avatarUrl ? '<img src="' + escapeHtml(p.avatarUrl) + '" alt="">' : escapeHtml(initials(p.name));
  const avatarBg = p.avatarUrl ? '' : `background:${peerColor(p)}`;
  return `
    <div class="peer" style="${offline ? 'opacity:.62' : ''}">
      <span class="avatar-wrap">
        <span class="member-avatar" style="${avatarBg}">${avatarInner}</span>
        <span class="status-dot" style="background:${dotColor}" title="${statusLabel}"></span>
      </span>
      <span class="member-info">
        <span class="member-name">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</span>
        ${p.statusText ? `<span class="member-status-text">${escapeHtml(p.statusText)}</span>` : `<span class="member-handle">@${escapeHtml(handleFor(p.name))}</span>`}
      </span>
    </div>`;
}

function renderOnline() {
  const cutoff = Date.now() - 20000;
  const peers = uniquePeers(latestPeers);
  const active = peers.filter(p => p.ts > cutoff && p.status !== 'invisible');
  const offline = peers.filter(p => !(p.ts > cutoff) || p.status === 'invisible');
  document.getElementById('online-count').textContent = active.length;
  document.getElementById('online-list').innerHTML =
    active.map(p => peerRow(p, false)).join('') +
    (offline.length ? '<div class="member-group-label">Offline</div>' + offline.map(p => peerRow(p, true)).join('') : '') ||
    '<div class="peer" style="color:var(--muted)">No members yet</div>';
  if (document.getElementById('mention-menu').classList.contains('open')) renderMentionMenu();
}

function pushPresence() {
  if (!db || !nickname) return;
  const ref = db.collection('hangout_presence').doc(presenceId);
  ref.set({
    name: nickname,
    ts: Date.now(),
    status: myProfile.status,
    statusText: myProfile.statusText || '',
    color: myProfile.color || null
  }).catch(() => {});
}

function startPresence() {
  if (!db || !nickname) return;
  presenceId = auth.currentUser?.uid || clientId;
  pushPresence();
  setInterval(pushPresence, 8000);
  if (unsubPresence) unsubPresence();
  unsubPresence = db.collection('hangout_presence').onSnapshot(snap => {
    latestPeers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderOnline();
  });
  setInterval(renderOnline, 5000);
}

function enableChat() {
  document.getElementById('msg-input').disabled = false;
  document.getElementById('send-btn').disabled = false;
  subscribeChannel(currentChannel);
}

function disableChat() {
  document.getElementById('msg-input').disabled = true;
  document.getElementById('send-btn').disabled = true;
  if (unsubMessages) unsubMessages();
  if (unsubPresence) unsubPresence();
}

function firebaseConfigured() {
  return FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== 'PASTE_ME';
}

function init() {
  if (!firebaseConfigured()) {
    document.getElementById('setup-banner').style.display = 'block';
    return;
  }
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
  auth = firebase.auth();
  try { storage = firebase.storage(); } catch (e) { storage = null; }

  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {
    showAuthError('Firebase is connected, but this browser could not save the login session.');
  });

  auth.onAuthStateChanged(user => {
    if (user) {
      nickname = user.displayName || 'Someone';
      document.getElementById('nick-display').textContent = nickname;
      document.getElementById('auth-modal').style.display = 'none';
      updateMyBadge();
      enableChat();
      startPresence();
    } else {
      nickname = '';
      document.getElementById('auth-modal').style.display = 'flex';
      disableChat();
    }
  });
}

init();