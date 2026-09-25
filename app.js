const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBuCWVloW2QxsX40IfUIReBg7HWZCzty_I",
  authDomain: "rod-of-discord.firebaseapp.com",
  databaseURL: "https://rod-of-discord-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "rod-of-discord",
  storageBucket: "rod-of-discord.firebasestorage.app",
  messagingSenderId: "881588222910",
  appId: "1:881588222910:web:96d0bf399f2ef8133817ef"
};

const GIPHY_MAX_SEARCHES_PER_DAY = 20;
const GIPHY_MIN_SEARCH_INTERVAL_MS = 1000;

// Paste your deployed Cloudflare Worker URL here, e.g. "https://hangout-upload.yourname.workers.dev"
const UPLOAD_WORKER_URL = "https://fruitless-upload.ericjudo2.workers.dev";
const GIPHY_PROXY_URL = UPLOAD_WORKER_URL + '/giphy-search';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB cap

let db = null, auth = null, rtdb = null;
let nickname = '';
let pendingAvatarBlob = null;
let pendingAvatarRemoved = false;
let pendingAvatarPreviewUrl = null;
let clientId = localStorage.getItem('hangout_client_id');

if (!clientId) {
  clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('hangout_client_id', clientId);
}

let currentChannel = 'general';
let unsubMessages = null, unsubPresence = null;
let pendingAttachment = null; // { file, previewUrl, isImage } — staged locally, not uploaded until Send
let pendingGif = null; // { url, title } — remote GIPHY URL, never uploaded locally
let pendingSticker = null; // { url, title } — remote custom sticker URL
let chatActive = false;
let latestPeers = [];
let customEmojis = [];
let customEmojiUnsub = null;
let customStickers = [];
let customStickerUnsub = null;
let presenceId = clientId;
let authMode = 'login';
let visibilityPauseTimer = null;
let presenceRefreshTimer = null;
let presenceConnectionRef = null;
let presenceConnectionHandler = null;
let presenceRef = null;

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
  customEmojis.forEach(emoji => {
    const token = ':' + emoji.name + ':';
    const pattern = new RegExp(escapeHtml(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(pattern, '<img class="custom-emoji" src="' + escapeHtml(emoji.url) + '" alt="' + escapeHtml(token) + '" title="' + escapeHtml(token) + '">');
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
    'storage/unauthorized': 'Not allowed to upload — check the Cloudflare Worker.',
    'storage/canceled': 'Upload canceled.',
    'storage/quota-exceeded': 'Upload storage quota exceeded.',
    'storage/unknown': 'Cloudflare upload failed. Try a different image.'
  };
  return map[code] || 'Could not upload photo to Cloudflare. Try again.';
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
  if (!UPLOAD_WORKER_URL || UPLOAD_WORKER_URL === 'PASTE_WORKER_URL') {
    throw { code: 'storage/unknown', message: 'Upload server is not configured' };
  }
  const uid = (auth.currentUser && auth.currentUser.uid) || clientId;
  const file = new File([blob], 'avatar-' + uid + '.jpg', { type: 'image/jpeg' });
  const result = await uploadFile(file);
  return result.url;
}

function revokeAvatarPreviewUrl() {
  if (pendingAvatarPreviewUrl) URL.revokeObjectURL(pendingAvatarPreviewUrl);
  pendingAvatarPreviewUrl = null;
}

function resetAvatarPreview() {
  pendingAvatarBlob = null;
  pendingAvatarRemoved = false;
  revokeAvatarPreviewUrl();
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
    revokeAvatarPreviewUrl();
    pendingAvatarBlob = blob;
    pendingAvatarRemoved = false;
    pendingAvatarPreviewUrl = URL.createObjectURL(blob);
    const el = document.getElementById('avatar-preview');
    el.style.background = 'transparent';
    el.innerHTML = `<img src="${pendingAvatarPreviewUrl}" alt="">`;
  } catch (err) {
    showProfileError(err.message || 'Could not process that image.');
  }
});

document.getElementById('avatar-remove-btn').onclick = () => {
  pendingAvatarBlob = null;
  pendingAvatarRemoved = true;
  revokeAvatarPreviewUrl();
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
  pendingAvatarBlob = null;
  pendingAvatarRemoved = false;
  revokeAvatarPreviewUrl();
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

function renderAttachment(m) {
  if (m.stickerUrl) {
    const safeStickerUrl = escapeHtml(m.stickerUrl);
    return `<div class="attachment sticker-attachment"><img src="${safeStickerUrl}" alt="${escapeHtml(m.stickerTitle || 'Sticker')}" loading="lazy" decoding="async"></div>`;
  }
  if (m.gifUrl) {
    const safeGifUrl = escapeHtml(m.gifUrl);
    return `<div class="attachment gif-attachment"><img src="${safeGifUrl}" alt="${escapeHtml(m.gifTitle || 'GIF')}" loading="lazy" decoding="async"></div>`;
  }
  if (!m.fileUrl) return '';
  const type = m.fileType || '';
  const safeUrl = escapeHtml(m.fileUrl);
  if (type.startsWith('image/')) return `<div class="attachment"><img src="${safeUrl}" alt="attachment" loading="lazy" decoding="async"></div>`;
  if (type.startsWith('video/')) return `<div class="attachment"><video src="${safeUrl}" controls preload="metadata"></video></div>`;
  return `<div class="attachment"><a href="${safeUrl}" target="_blank" rel="noopener">📎 ${escapeHtml(m.fileName || 'Download file')}</a></div>`;
}

// ---------- Chat ----------
const MESSAGE_PAGE_SIZE = 20;
const messageList = document.getElementById('messages');
let loadedMessages = new Map();
let oldestMessageDoc = null;
let loadingOlderMessages = false;
let hasOlderMessages = true;

function messageTimestamp(message) {
  if (!message || !message.ts) return 0;
  return typeof message.ts.toMillis === 'function' ? message.ts.toMillis() : message.ts;
}

function renderMessages(docs, keepPosition = false) {
  const el = document.getElementById('messages');
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  if (!docs.length) {
    el.innerHTML = '<div id="empty">No messages yet. Say hi 👋</div>';
    return;
  }
  el.innerHTML = docs.map(m => `
    <div class="msg">
      <div class="avatar" style="${m.avatarUrl ? '' : 'background:' + (m.color || colorFor(m.author || '?'))}">${m.avatarUrl ? '<img src="' + escapeHtml(m.avatarUrl) + '" alt="">' : initials(m.author)}</div>
      <div class="msg-body">
        <div class="top"><span class="author">${escapeHtml(m.author || 'Someone')}</span><span class="time">${fmtTime(m.ts)}</span></div>
        ${m.text ? `<div class="text">${formatMessage(m.text)}</div>` : ''}
        ${renderAttachment(m)}
      </div>
    </div>
  `).join('');
  const followBottom = !keepPosition || wasAtBottom;
  if (followBottom) el.scrollTop = el.scrollHeight;
  if (followBottom) {
    el.querySelectorAll('img, video').forEach(media => {
      const keepBottom = () => { el.scrollTop = el.scrollHeight; };
      media.addEventListener('load', keepBottom, { once: true });
      media.addEventListener('loadedmetadata', keepBottom, { once: true });
    });
  }
}

function subscribeChannel(ch) {
  if (!db) return;
  if (unsubMessages) unsubMessages();
  loadedMessages = new Map();
  oldestMessageDoc = null;
  loadingOlderMessages = false;
  hasOlderMessages = true;
  messageList.innerHTML = '<div id="empty">Loading...</div>';
  unsubMessages = db.collection('hangout_messages')
    .where('channel', '==', ch).orderBy('ts', 'desc').limit(MESSAGE_PAGE_SIZE)
    .onSnapshot(snap => {
      snap.docs.forEach(doc => loadedMessages.set(doc.id, doc.data()));
      if (!oldestMessageDoc && snap.docs.length) oldestMessageDoc = snap.docs[snap.docs.length - 1];
      hasOlderMessages = snap.docs.length === MESSAGE_PAGE_SIZE;
      const docs = [...loadedMessages.values()].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
      renderMessages(docs, loadedMessages.size > snap.docs.length);
    }, err => {
      messageList.innerHTML = '<div id="empty">Could not load messages: ' + escapeHtml(err.message || err.code || 'unknown error') + '</div>';
    });
}

async function loadOlderMessages() {
  if (!db || !oldestMessageDoc || loadingOlderMessages || !hasOlderMessages) return;
  loadingOlderMessages = true;
  const previousHeight = messageList.scrollHeight;
  const previousTop = messageList.scrollTop;
  const channelAtStart = currentChannel;
  try {
    const snap = await db.collection('hangout_messages')
      .where('channel', '==', channelAtStart)
      .orderBy('ts', 'desc')
      .startAfter(oldestMessageDoc)
      .limit(MESSAGE_PAGE_SIZE)
      .get();
    if (channelAtStart !== currentChannel) return;
    snap.docs.forEach(doc => loadedMessages.set(doc.id, doc.data()));
    if (snap.docs.length) oldestMessageDoc = snap.docs[snap.docs.length - 1];
    hasOlderMessages = snap.docs.length === MESSAGE_PAGE_SIZE;
    const docs = [...loadedMessages.values()].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
    renderMessages(docs, true);
    messageList.scrollTop = messageList.scrollHeight - previousHeight + previousTop;
  } catch (err) {
    console.error('Could not load older messages', err);
  } finally {
    loadingOlderMessages = false;
  }
}

messageList.addEventListener('scroll', () => {
  if (messageList.scrollTop <= 80) loadOlderMessages();
});

document.querySelectorAll('.channel').forEach(el => {
  el.onclick = () => {
    document.getElementById('channels').classList.remove('mobile-open');
    if (currentChannel === el.dataset.ch) return;
    document.querySelectorAll('.channel').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    currentChannel = el.dataset.ch;
    document.getElementById('header-channel').textContent = '# ' + currentChannel;
    document.getElementById('msg-input').placeholder = 'Message #' + currentChannel;
    subscribeChannel(currentChannel);
  };
});

document.getElementById('mobile-channel-toggle').onclick = () => {
  document.getElementById('channels').classList.toggle('mobile-open');
  document.getElementById('online').classList.remove('mobile-open');
  document.getElementById('mobile-online-toggle').setAttribute('aria-expanded', 'false');
};

document.getElementById('mobile-online-toggle').onclick = () => {
  const online = document.getElementById('online');
  const isOpen = online.classList.toggle('mobile-open');
  document.getElementById('channels').classList.remove('mobile-open');
  document.getElementById('mobile-online-toggle').setAttribute('aria-expanded', String(isOpen));
};

document.getElementById('mobile-online-back').onclick = () => {
  document.getElementById('online').classList.remove('mobile-open');
  document.getElementById('mobile-online-toggle').setAttribute('aria-expanded', 'false');
};

window.addEventListener('resize', () => {
  if (window.innerWidth > 640) {
    document.getElementById('online').classList.remove('mobile-open');
    document.getElementById('channels').classList.remove('mobile-open');
  }
});

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!db) return;
  if (!text && !pendingAttachment && !pendingGif && !pendingSticker) return;

  const attachment = pendingAttachment;
  input.value = '';

  let fileUrl = null, fileName = null, fileType = null;
  const gif = pendingGif;
  const sticker = pendingSticker;

  if (attachment) {
    document.getElementById('attach-btn').disabled = true;
    document.getElementById('send-btn').disabled = true;
    showUploadStatus('Compressing ' + attachment.file.name + '…');
    try {
      const compressedFile = await compressMediaFile(attachment.file);
      if (compressedFile.size > MAX_FILE_BYTES) throw new Error('That file is still too big after compression (50MB max).');
      showUploadStatus('Uploading ' + compressedFile.name + '…');
      const result = await uploadFile(compressedFile);
      fileUrl = result.url;
      fileName = result.name;
      fileType = result.type;
    } catch (err) {
      showUploadStatus('Upload failed: ' + (err.message || 'unknown error'));
      input.value = text; // don't lose what they typed
      document.getElementById('attach-btn').disabled = false;
      document.getElementById('send-btn').disabled = false;
      return; // keep the attachment staged so they can just hit Send again
    }
    clearPendingAttachment();
    hideUploadStatus();
    document.getElementById('attach-btn').disabled = false;
    document.getElementById('send-btn').disabled = false;
  }

  clearPendingGif();
  clearPendingSticker();

  try {
    await db.collection('hangout_messages').add({
      channel: currentChannel,
      author: nickname,
      text,
      color: myProfile.color || null,
      avatarUrl: myProfile.avatarUrl || null,
      fileUrl, fileName, fileType,
      gifUrl: gif ? gif.url : null,
      gifTitle: gif ? gif.title : null,
      stickerUrl: sticker ? sticker.url : null,
      stickerTitle: sticker ? sticker.title : null,
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    document.getElementById('messages').insertAdjacentHTML('beforeend', '<div id="empty">Send failed: ' + escapeHtml(e.message || e.code || 'unknown error') + '</div>');
  }
}

document.getElementById('send-btn').onclick = sendMessage;
const messageInput = document.getElementById('msg-input');

const NORMAL_EMOJIS = Array.from('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👋 🙏 👏 🙌 💪 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❌ ✅ ⭐ 🔥 🎉 🎂 🎁 💯'.split(' '));
const SHORTCODE_EMOJIS = {
  sob: '😭', cry: '😢', joy: '😂', laugh: '😆', smile: '😄', blush: '😊',
  grin: '😁', wink: '😉', heart: '❤️', broken_heart: '💔', love: '😍',
  angry: '😠', rage: '😡', scream: '😱', worried: '😟', confused: '😕',
  thinking: '🤔', cool: '😎', nerd: '🤓', sunglasses: '😎', sleepy: '😴',
  tired: '🥱', dizzy: '😵', clown: '🤡', skull: '💀', ghost: '👻', poop: '💩',
  alien: '👽', robot: '🤖', wave: '👋', clap: '👏', pray: '🙏', muscle: '💪',
  thumbs_up: '👍', thumbs_down: '👎', ok_hand: '👌', raised_hands: '🙌',
  fire: '🔥', star: '⭐', tada: '🎉', gift: '🎁', check: '✅', x: '❌',
  hundred: '💯', eyes: '👀', heart_eyes: '😍', sobbing: '😭', scream_cat: '🙀'
};
const emojiPicker = document.getElementById('emoji-picker');
const emojiButton = document.getElementById('emoji-btn');
const emojiSearch = document.getElementById('emoji-search');
const customEmojiList = document.getElementById('custom-emoji-list');
const normalEmojiList = document.getElementById('normal-emoji-list');
const gifSearch = document.getElementById('gif-search');
const gifResults = document.getElementById('gif-results');
const gifStatus = document.getElementById('gif-status');
const stickerResults = document.getElementById('sticker-results');
const stickerStatus = document.getElementById('sticker-status');
const emojiStorageKey = 'hangout_emoji_preferences_' + clientId;
let emojiPreferences = { favorites: [], recent: [] };
let activeEmojiSubtab = 'favorites';
let gifSearchController = null;
const giphyUsageKey = 'hangout_giphy_usage_' + clientId;
let giphyUsage = { date: '', count: 0, lastAt: 0 };

try {
  giphyUsage = Object.assign(giphyUsage, JSON.parse(localStorage.getItem(giphyUsageKey) || '{}'));
} catch (e) {}

function saveGiphyUsage() {
  try { localStorage.setItem(giphyUsageKey, JSON.stringify(giphyUsage)); } catch (e) {}
}

try {
  emojiPreferences = Object.assign(emojiPreferences, JSON.parse(localStorage.getItem(emojiStorageKey) || '{}'));
} catch (e) {}

function saveEmojiPreferences() {
  try { localStorage.setItem(emojiStorageKey, JSON.stringify(emojiPreferences)); } catch (e) {}
}

function emojiValue(item) {
  return item.custom ? `:${item.name}:` : item.value;
}

function emojiTitle(item) {
  return item.custom ? ':' + item.name + ':' : item.value;
}

function emojiButtonElement(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'emoji-choice';
  button.title = emojiTitle(item) + ' (right-click to favorite)';
  button.setAttribute('aria-label', emojiTitle(item));
  if (item.custom) {
    button.innerHTML = `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(emojiTitle(item))}">`;
  } else {
    button.textContent = item.value;
  }
  button.onclick = () => insertEmoji(emojiValue(item));
  button.oncontextmenu = event => {
    event.preventDefault();
    toggleFavorite(emojiValue(item));
  };
  return button;
}

function toggleFavorite(value) {
  const favorites = emojiPreferences.favorites;
  const index = favorites.indexOf(value);
  if (index >= 0) favorites.splice(index, 1);
  else favorites.unshift(value);
  emojiPreferences.favorites = favorites.slice(0, 40);
  saveEmojiPreferences();
  renderEmojiSubtab(activeEmojiSubtab);
}

function addRecent(value) {
  emojiPreferences.recent = [value, ...emojiPreferences.recent.filter(item => item !== value)].slice(0, 24);
  saveEmojiPreferences();
}

function findEmoji(value) {
  if (value.startsWith(':') && value.endsWith(':')) {
    const name = value.slice(1, -1);
    const custom = customEmojis.find(item => item.name === name);
    return custom ? { custom: true, name: custom.name, url: custom.url } : null;
  }
  return NORMAL_EMOJIS.includes(value) ? { value } : null;
}

function renderEmojiGroup(container, title, values) {
  if (!values.length) return;
  const section = document.createElement('div');
  section.className = 'emoji-group';
  section.innerHTML = `<h4>${title}</h4>`;
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  values.map(findEmoji).filter(Boolean).forEach(item => grid.appendChild(emojiButtonElement(item)));
  section.appendChild(grid);
  container.appendChild(section);
}

function renderCustomEmojis() {
  customEmojiList.innerHTML = '';
  customEmojis.forEach(emoji => customEmojiList.appendChild(emojiButtonElement({
    custom: true,
    name: emoji.name,
    url: emoji.url
  })));
  document.getElementById('custom-emoji-empty').style.display = customEmojis.length ? 'none' : 'block';
}

function renderNormalEmojis() {
  const query = emojiSearch.value.trim();
  normalEmojiList.innerHTML = '';
  if (query) {
    renderEmojiGroup(normalEmojiList, 'Results', NORMAL_EMOJIS.filter(value => value.includes(query)));
    return;
  }
  renderEmojiGroup(normalEmojiList, 'All emoji', NORMAL_EMOJIS);
}

function renderEmojiValues(containerId, title, values) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (values.length) renderEmojiGroup(container, title, values);
  else container.innerHTML = '<p class="emoji-empty-state">Nothing here yet.</p>';
}

function renderEmojiSubtab(tab) {
  activeEmojiSubtab = tab;
  document.querySelectorAll('.emoji-subtab').forEach(button => {
    const active = button.dataset.emojiSubtab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const sections = {
    custom: 'custom-emoji-section',
    normal: 'normal-emoji-section',
    favorites: 'favorite-emoji-section',
    recent: 'recent-emoji-section'
  };
  Object.entries(sections).forEach(([name, id]) => {
    document.getElementById(id).hidden = name !== tab;
  });
  if (tab === 'custom') renderCustomEmojis();
  if (tab === 'normal') renderNormalEmojis();
  if (tab === 'favorites') renderEmojiValues('favorite-emoji-list', '★ Favorites', emojiPreferences.favorites);
  if (tab === 'recent') renderEmojiValues('recent-emoji-list', '◷ Recently Used', emojiPreferences.recent);
}

function insertEmoji(value) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  messageInput.value = messageInput.value.slice(0, start) + value + messageInput.value.slice(end);
  messageInput.focus();
  messageInput.setSelectionRange(start + value.length, start + value.length);
  addRecent(value);
}

function setEmojiTab(tab) {
  document.querySelectorAll('.emoji-tab').forEach(button => {
    const active = button.dataset.emojiTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.getElementById('emoji-picker-body').hidden = tab !== 'emoji';
  document.getElementById('gif-content').hidden = tab !== 'gif';
  document.getElementById('sticker-content').hidden = tab !== 'sticker';
  if (tab === 'emoji') renderEmojiSubtab(activeEmojiSubtab);
}

function closeEmojiPicker() {
  if (gifSearchController) {
    gifSearchController.abort();
    gifSearchController = null;
  }
  emojiPicker.classList.remove('open');
  emojiButton.setAttribute('aria-expanded', 'false');
}

emojiButton.onclick = () => {
  const isOpen = emojiPicker.classList.toggle('open');
  emojiButton.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    renderCustomEmojis();
    setEmojiTab('emoji');
    renderEmojiSubtab(activeEmojiSubtab);
  }
};

document.querySelectorAll('.emoji-tab').forEach(button => {
  button.onclick = () => setEmojiTab(button.dataset.emojiTab);
});
document.querySelectorAll('.emoji-subtab').forEach(button => {
  button.onclick = () => renderEmojiSubtab(button.dataset.emojiSubtab);
});
emojiSearch.oninput = renderNormalEmojis;

async function searchGiphyGifs(query) {
  if (!query.trim()) {
    gifStatus.textContent = 'Search GIPHY for a GIF.';
    gifResults.innerHTML = '';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (giphyUsage.date !== today) giphyUsage = { date: today, count: 0, lastAt: 0 };
  const now = Date.now();
  if (giphyUsage.count >= GIPHY_MAX_SEARCHES_PER_DAY) {
    gifStatus.textContent = 'Daily GIF search limit reached. Try again tomorrow.';
    return;
  }
  if (now - giphyUsage.lastAt < GIPHY_MIN_SEARCH_INTERVAL_MS) return;
  giphyUsage.count += 1;
  giphyUsage.lastAt = now;
  saveGiphyUsage();
  if (gifSearchController) gifSearchController.abort();
  gifSearchController = new AbortController();
  gifStatus.textContent = 'Searching GIPHY…';
  try {
    const response = await fetch(GIPHY_PROXY_URL + '?q=' + encodeURIComponent(query.trim()), { signal: gifSearchController.signal });
    if (!response.ok) throw new Error('GIPHY search failed (' + response.status + ')');
    const data = await response.json();
    gifResults.innerHTML = '';
    const results = (data.data || []).map(result => ({
      url: result.images?.fixed_width_small?.url || result.images?.downsized_medium?.url || result.images?.original?.url,
      title: result.title || 'GIPHY GIF'
    })).filter(result => result.url);
    gifStatus.textContent = results.length ? 'Click a GIF to stage it.' : 'No GIFs found.';
    results.forEach(result => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gif-result';
      button.title = result.title;
      button.innerHTML = `<img src="${escapeHtml(result.url)}" alt="${escapeHtml(result.title)}" loading="lazy">`;
      button.onclick = () => stageGif(result.url, result.title);
      gifResults.appendChild(button);
    });
  } catch (error) {
    if (error.name === 'AbortError') return;
    gifStatus.textContent = error.message || 'Could not search GIPHY.';
  }
}

gifSearch.onkeydown = event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    searchGiphyGifs(gifSearch.value);
  }
};

document.addEventListener('click', event => {
  if (!emojiPicker.contains(event.target) && event.target !== emojiButton) closeEmojiPicker();
});

document.getElementById('custom-emoji-upload').onclick = () => document.getElementById('custom-emoji-file').click();
document.getElementById('custom-emoji-file').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !db) return;
  const name = (window.prompt('Name this custom emoji (letters, numbers, _ or -):', file.name.replace(/\.[^.]+$/, '').toLowerCase()) || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(name)) return;
  if (customEmojis.some(emoji => emoji.name === name)) {
    showUploadStatus('That custom emoji name is already taken.');
    return;
  }
  const uploadButton = document.getElementById('custom-emoji-upload');
  uploadButton.disabled = true;
  try {
    showUploadStatus('Preparing custom emoji…');
    const compressed = await compressMediaFile(file);
    if (compressed.size > 5 * 1024 * 1024) throw new Error('Custom emojis must be under 5MB.');
    showUploadStatus('Uploading custom emoji…');
    const result = await uploadFile(compressed);
    await db.collection('hangout_custom_emojis').add({
      name,
      url: result.url,
      type: result.type,
      creator: nickname,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    hideUploadStatus();
  } catch (error) {
    showUploadStatus('Custom emoji upload failed: ' + (error.message || 'unknown error'));
  } finally {
    uploadButton.disabled = false;
  }
};

function renderCustomStickers() {
  stickerResults.innerHTML = '';
  customStickers.forEach(sticker => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gif-result';
    button.title = sticker.name;
    button.innerHTML = `<img src="${escapeHtml(sticker.url)}" alt="${escapeHtml(sticker.name)}" loading="lazy">`;
    button.onclick = () => stageSticker(sticker.url, sticker.name);
    stickerResults.appendChild(button);
  });
  stickerStatus.textContent = customStickers.length ? 'Click a sticker to stage it.' : 'Upload a custom sticker to share it.';
}

document.getElementById('custom-sticker-upload').onclick = () => document.getElementById('custom-sticker-file').click();
document.getElementById('custom-sticker-file').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !db) return;
  const name = (window.prompt('Name this custom sticker:', file.name.replace(/\.[^.]+$/, '').toLowerCase()) || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(name)) return;
  if (customStickers.some(sticker => sticker.name === name)) {
    showUploadStatus('That custom sticker name is already taken.');
    return;
  }
  const uploadButton = document.getElementById('custom-sticker-upload');
  uploadButton.disabled = true;
  try {
    showUploadStatus('Preparing custom sticker…');
    const compressed = await compressMediaFile(file);
    if (compressed.size > 5 * 1024 * 1024) throw new Error('Custom stickers must be under 5MB.');
    showUploadStatus('Uploading custom sticker…');
    const result = await uploadFile(compressed);
    await db.collection('hangout_custom_stickers').add({
      name,
      url: result.url,
      type: result.type,
      creator: nickname,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    hideUploadStatus();
  } catch (error) {
    showUploadStatus('Custom sticker upload failed: ' + (error.message || 'unknown error'));
  } finally {
    uploadButton.disabled = false;
  }
};

function startCustomEmojiListener() {
  if (!db || customEmojiUnsub) return;
  customEmojiUnsub = db.collection('hangout_custom_emojis')
    .orderBy('createdAt', 'desc').limit(100)
    .onSnapshot(snapshot => {
      customEmojis = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(emoji => emoji.name && emoji.url);
      renderCustomEmojis();
    }, () => { customEmojis = []; renderCustomEmojis(); });
}

function stopCustomEmojiListener() {
  if (customEmojiUnsub) customEmojiUnsub();
  customEmojiUnsub = null;
  customEmojis = [];
}

function startCustomStickerListener() {
  if (!db || customStickerUnsub) return;
  customStickerUnsub = db.collection('hangout_custom_stickers')
    .orderBy('createdAt', 'desc').limit(100)
    .onSnapshot(snapshot => {
      customStickers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(sticker => sticker.name && sticker.url);
      renderCustomStickers();
    }, () => { customStickers = []; renderCustomStickers(); });
}

function stopCustomStickerListener() {
  if (customStickerUnsub) customStickerUnsub();
  customStickerUnsub = null;
  customStickers = [];
}

// ---------- File uploads (Cloudflare Worker + R2) ----------
function showUploadStatus(msg) {
  const el = document.getElementById('upload-status');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideUploadStatus() {
  document.getElementById('upload-status').style.display = 'none';
}

function compressedFileName(name, extension) {
  return name.replace(/\.[^.]+$/, '') + extension;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const maxDimension = 1600;
      const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(sourceUrl);
        if (!blob) {
          reject(new Error('Could not compress image'));
          return;
        }
        const compressed = new File([blob], compressedFileName(file.name, '.jpg'), { type: 'image/jpeg' });
        resolve(compressed.size < file.size ? compressed : file);
      }, 'image/jpeg', 0.8);
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new Error('Could not read image'));
    };
    image.src = sourceUrl;
  });
}

function compressVideo(file) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return Promise.resolve(file);
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return Promise.resolve(file);

  return new Promise((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = sourceUrl;
    let animationFrame = null;
    let outputStream = null;
    let sourceStream = null;
    let recorder = null;
    const chunks = [];

    const cleanup = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      if (outputStream) outputStream.getTracks().forEach(track => track.stop());
      if (sourceStream) sourceStream.getTracks().forEach(track => track.stop());
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(sourceUrl);
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Could not read video'));
    };
    video.onloadedmetadata = async () => {
      try {
        const maxDimension = 1280;
        const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        outputStream = canvas.captureStream(30);
        if (video.captureStream) {
          sourceStream = video.captureStream();
          sourceStream.getAudioTracks().forEach(track => outputStream.addTrack(track));
        }
        recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 2_500_000 });
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => { cleanup(); reject(new Error('Could not compress video')); };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          cleanup();
          const compressed = new File([blob], compressedFileName(file.name, '.webm'), { type: mimeType });
          resolve(compressed.size < file.size ? compressed : file);
        };
        video.onended = () => {
          if (recorder.state !== 'inactive') recorder.stop();
        };
        const drawFrame = () => {
          if (recorder.state === 'recording') {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            animationFrame = requestAnimationFrame(drawFrame);
          }
        };
        recorder.start(1000);
        await video.play();
        drawFrame();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
  });
}

async function compressMediaFile(file) {
  if (file.type === 'image/gif') return file;
  if (file.type.startsWith('image/')) return compressImage(file);
  if (file.type.startsWith('video/')) return compressVideo(file);
  return file;
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_WORKER_URL + '/upload');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        showUploadStatus('Uploading ' + file.name + '… ' + Math.round((e.loaded / e.total) * 100) + '%');
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error('Bad response from upload server')); }
      } else {
        reject(new Error('Upload failed (status ' + xhr.status + ')'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

const attachButton = document.getElementById('attach-btn');
const attachMenu = document.getElementById('attach-menu');
const uploadFileButton = document.getElementById('upload-file-btn');

attachButton.onclick = () => {
  const isOpen = attachMenu.classList.toggle('open');
  attachButton.setAttribute('aria-expanded', String(isOpen));
};

uploadFileButton.onclick = () => {
  attachMenu.classList.remove('open');
  attachButton.setAttribute('aria-expanded', 'false');
  document.getElementById('file-input').click();
};

document.addEventListener('click', e => {
  if (!document.getElementById('attach-menu-wrap').contains(e.target)) {
    attachMenu.classList.remove('open');
    attachButton.setAttribute('aria-expanded', 'false');
  }
});

// ---------- Staged attachment (Discord-style: stays local until Send) ----------
function stageAttachment(file) {
  clearPendingGif();
  clearPendingSticker();
  clearPendingAttachment();
  const isImage = file.type.startsWith('image/');
  pendingAttachment = {
    file,
    previewUrl: isImage ? URL.createObjectURL(file) : null,
    isImage
  };
  renderPendingAttachment();
  document.getElementById('msg-input').focus();
}

function stageGif(url, title) {
  clearPendingAttachment();
  clearPendingSticker();
  pendingGif = { url, title: title || 'GIPHY GIF' };
  renderPendingAttachment();
  closeEmojiPicker();
  document.getElementById('msg-input').focus();
}

function stageSticker(url, title) {
  clearPendingAttachment();
  clearPendingGif();
  clearPendingSticker();
  pendingSticker = { url, title: title || 'Custom sticker' };
  renderPendingAttachment();
  closeEmojiPicker();
  document.getElementById('msg-input').focus();
}

function clearPendingGif() {
  pendingGif = null;
  renderPendingAttachment();
}

function clearPendingSticker() {
  pendingSticker = null;
  renderPendingAttachment();
}

function clearPendingAttachment() {
  if (pendingAttachment && pendingAttachment.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
  pendingAttachment = null;
  renderPendingAttachment();
}

function renderPendingAttachment() {
  const wrap = document.getElementById('pending-attachment');
  if (!pendingAttachment && !pendingGif && !pendingSticker) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  if (pendingGif) {
    wrap.innerHTML = `
      <img src="${escapeHtml(pendingGif.url)}" alt="" class="pending-attachment-thumb">
      <span class="pending-attachment-name">${escapeHtml(pendingGif.title)} <small>(GIPHY)</small></span>
      <button type="button" id="pending-attachment-remove" aria-label="Remove GIF">✕</button>
    `;
    wrap.style.display = 'flex';
    document.getElementById('pending-attachment-remove').onclick = clearPendingGif;
    return;
  }
  if (pendingSticker) {
    wrap.innerHTML = `
      <img src="${escapeHtml(pendingSticker.url)}" alt="" class="pending-attachment-thumb">
      <span class="pending-attachment-name">${escapeHtml(pendingSticker.title)} <small>(sticker)</small></span>
      <button type="button" id="pending-attachment-remove" aria-label="Remove sticker">✕</button>
    `;
    wrap.style.display = 'flex';
    document.getElementById('pending-attachment-remove').onclick = clearPendingSticker;
    return;
  }
  const { file, previewUrl, isImage } = pendingAttachment;
  wrap.innerHTML = `
    ${isImage
      ? `<img src="${previewUrl}" alt="" class="pending-attachment-thumb">`
      : `<span class="pending-attachment-icon">📎</span>`}
    <span class="pending-attachment-name">${escapeHtml(file.name)}</span>
    <button type="button" id="pending-attachment-remove" aria-label="Remove attachment">✕</button>
  `;
  wrap.style.display = 'flex';
  document.getElementById('pending-attachment-remove').onclick = clearPendingAttachment;
}

async function handleIncomingFile(file) {
  if (!file || !db) return;
  if (!UPLOAD_WORKER_URL || UPLOAD_WORKER_URL === 'PASTE_WORKER_URL') {
    showUploadStatus("File uploads aren't configured yet — add your Worker URL to app.js.");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showUploadStatus('That file is too big — 50MB max for now.');
    return;
  }
  document.getElementById('attach-btn').disabled = true;
  showUploadStatus('Preparing ' + file.name + '…');
  try {
    const compressedFile = await compressMediaFile(file);
    if (compressedFile.size > MAX_FILE_BYTES) {
      showUploadStatus('The compressed file is still too big — 50MB max for now.');
      return;
    }
    hideUploadStatus();
    stageAttachment(compressedFile);
  } catch (err) {
    showUploadStatus('Could not process that file: ' + (err.message || 'unknown error'));
  } finally {
    document.getElementById('attach-btn').disabled = false;
  }
}

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  handleIncomingFile(file);
});

// Paste an image straight into the message box (screenshot, copied photo, etc.)
// and it stages exactly like a picked file — caption it and hit Send/Enter.
messageInput.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const imageItem = [...items].find(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (!imageItem) return; // no image on the clipboard — let normal text paste happen
  e.preventDefault();
  const blob = imageItem.getAsFile();
  if (!blob) return;
  const ext = (imageItem.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: imageItem.type });
  handleIncomingFile(file);
});

messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
  if (e.key === 'Escape') {
    document.getElementById('mention-menu').classList.remove('open');
    document.getElementById('emoji-autocomplete').classList.remove('open');
  }
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
  menu.innerHTML = members.map(p => {
    const isOffline = p.online === false || p.status === 'invisible';
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

function renderEmojiAutocomplete() {
  const menu = document.getElementById('emoji-autocomplete');
  const cursor = messageInput.selectionStart ?? messageInput.value.length;
  const before = messageInput.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)(::|:)([a-z0-9_+-]*)$/i);
  if (!match) {
    menu.classList.remove('open');
    return;
  }
  const delimiter = match[1];
  const query = match[2].toLowerCase();
  const suggestions = Object.entries(SHORTCODE_EMOJIS)
    .map(([name, value]) => ({ name, value }))
    .concat(customEmojis.map(emoji => ({ name: emoji.name, value: `:${emoji.name}:`, url: emoji.url, custom: true })))
    .filter((item, index, items) => items.findIndex(candidate => candidate.name === item.name) === index)
    .filter(item => !query || item.name.includes(query))
    .slice(0, 12);
  menu.innerHTML = suggestions.length ? suggestions.map(item => `
    <button type="button" class="emoji-autocomplete-option" role="option" data-emoji-name="${escapeHtml(item.name)}">
      ${item.custom ? `<img src="${escapeHtml(item.url)}" alt="">` : `<span>${item.value}</span>`}
      <span>:${escapeHtml(item.name)}:</span>
    </button>`).join('') : '<div class="emoji-autocomplete-empty">No matching emoji</div>';
  menu.classList.add('open');
  menu.querySelectorAll('[data-emoji-name]').forEach(button => {
    button.onmousedown = event => {
      event.preventDefault();
      const name = button.dataset.emojiName;
      const item = suggestions.find(candidate => candidate.name === name);
      const value = item.custom ? `:${name}:` : item.value;
      const tokenStart = before.lastIndexOf(delimiter + query);
      const after = messageInput.value.slice(cursor);
      messageInput.value = messageInput.value.slice(0, tokenStart) + value + after;
      const nextCursor = tokenStart + value.length;
      messageInput.focus();
      messageInput.setSelectionRange(nextCursor, nextCursor);
      addRecent(value);
      menu.classList.remove('open');
    };
  });
}

messageInput.addEventListener('input', () => {
  renderMentionMenu();
  renderEmojiAutocomplete();
});

document.addEventListener('click', e => {
  if (!document.getElementById('input-row').contains(e.target)) {
    document.getElementById('mention-menu').classList.remove('open');
    document.getElementById('emoji-autocomplete').classList.remove('open');
  }
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
  const peers = uniquePeers(latestPeers);
  const active = peers.filter(p => p.online !== false && p.status !== 'invisible');
  const offline = peers.filter(p => p.online === false || p.status === 'invisible');
  document.getElementById('online-count').textContent = active.length;
  document.getElementById('mobile-online-count').textContent = active.length;
  document.getElementById('online-list').innerHTML =
    active.map(p => peerRow(p, false)).join('') +
    (offline.length ? '<div class="member-group-label">Offline</div>' + offline.map(p => peerRow(p, true)).join('') : '') ||
    '<div class="peer" style="color:var(--muted)">No members yet</div>';
  if (document.getElementById('mention-menu').classList.contains('open')) renderMentionMenu();
}

function pushPresence() {
  if (!rtdb || !nickname || !presenceId) return;
  rtdb.ref('presence/' + presenceId).set({
    name: nickname,
    online: true,
    ts: firebase.database.ServerValue.TIMESTAMP,
    status: myProfile.status,
    statusText: myProfile.statusText || '',
    color: myProfile.color || null,
    avatarUrl: myProfile.avatarUrl || null
  }).catch(() => {});
}

function stopPresence() {
  if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
  presenceRefreshTimer = null;
  if (presenceConnectionRef && presenceConnectionHandler) {
    presenceConnectionRef.off('value', presenceConnectionHandler);
  }
  if (presenceRef && unsubPresence) presenceRef.off('value', unsubPresence);
  presenceConnectionRef = null;
  presenceConnectionHandler = null;
  presenceRef = null;
  unsubPresence = null;
}

function startPresence() {
  if (!rtdb || !nickname) return;
  stopPresence();
  presenceId = auth.currentUser?.uid || clientId;

  const myRef = rtdb.ref('presence/' + presenceId);

  // Re-register the disconnect hook on every (re)connect — RTDB drops it on
  // reconnect, so this also covers brief network blips, not just tab close.
  // We mark ourselves offline (keeping the record) rather than removing it,
  // so friends still show up in the "Offline" list instead of vanishing.
  presenceConnectionRef = rtdb.ref('.info/connected');
  presenceConnectionHandler = snap => {
    if (snap.val() !== true) return;
    myRef.onDisconnect().update({
      online: false,
      ts: firebase.database.ServerValue.TIMESTAMP
    }).then(() => pushPresence());
  };
  presenceConnectionRef.on('value', presenceConnectionHandler);

  presenceRefreshTimer = setInterval(pushPresence, 25000);

  presenceRef = rtdb.ref('presence');
  unsubPresence = snap => {
    const val = snap.val() || {};
    latestPeers = Object.entries(val).map(([id, data]) => ({ id, ...data }));
    renderOnline();
  };
  presenceRef.on('value', unsubPresence);

}

function enableChat() {
  chatActive = true;
  document.getElementById('msg-input').disabled = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('emoji-btn').disabled = false;
  document.getElementById('attach-btn').disabled = false;
  startCustomEmojiListener();
  startCustomStickerListener();
  subscribeChannel(currentChannel);
}

function disableChat() {
  chatActive = false;
  clearTimeout(visibilityPauseTimer);
  visibilityPauseTimer = null;
  document.getElementById('msg-input').disabled = true;
  document.getElementById('send-btn').disabled = true;
  document.getElementById('emoji-btn').disabled = true;
  document.getElementById('attach-btn').disabled = true;
  closeEmojiPicker();
  clearPendingAttachment();
  clearPendingGif();
  if (unsubMessages) unsubMessages();
  unsubMessages = null;
  stopCustomEmojiListener();
  stopCustomStickerListener();
  stopPresence();
}

// Keep short app switches from rereading the newest page. Long-idle tabs still
// release the listener to avoid paying for messages while they are unattended.
document.addEventListener('visibilitychange', () => {
  if (!chatActive) return;
  if (document.hidden) {
    clearTimeout(visibilityPauseTimer);
    visibilityPauseTimer = setTimeout(() => {
      if (document.hidden && unsubMessages) {
        unsubMessages();
        unsubMessages = null;
      }
    }, 5 * 60 * 1000);
  } else {
    clearTimeout(visibilityPauseTimer);
    if (!unsubMessages) subscribeChannel(currentChannel);
  }
});

window.addEventListener('pagehide', () => {
  clearTimeout(visibilityPauseTimer);
  visibilityPauseTimer = null;
  if (unsubMessages) {
    unsubMessages();
    unsubMessages = null;
  }
  stopPresence();
});

window.addEventListener('pageshow', event => {
  if (event.persisted && chatActive && !unsubMessages) {
    subscribeChannel(currentChannel);
    startPresence();
  }
});

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
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  auth = firebase.auth();
  try { rtdb = firebase.database(); } catch (e) { rtdb = null; }

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