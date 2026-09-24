const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBuCWVloW2QxsX40IfUIReBg7HWZCzty_I",
  authDomain: "rod-of-discord.firebaseapp.com",
  databaseURL: "https://rod-of-discord-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "rod-of-discord",
  storageBucket: "rod-of-discord.firebasestorage.app",
  messagingSenderId: "881588222910",
  appId: "1:881588222910:web:96d0bf399f2ef8133817ef"
};

// Paste your deployed Cloudflare Worker URL here, e.g. "https://hangout-upload.yourname.workers.dev"
const UPLOAD_WORKER_URL = "https://fruitless-upload.ericjudo2.workers.dev";
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB cap

let db = null, auth = null, storage = null, rtdb = null;
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
let chatActive = false;
let latestPeers = [];
let presenceId = clientId;
let authMode = 'login';
let visibilityPauseTimer = null;
let presenceRefreshTimer = null;
let onlineRenderTimer = null;
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
  if (!m.fileUrl) return '';
  const type = m.fileType || '';
  const safeUrl = escapeHtml(m.fileUrl);
  if (type.startsWith('image/')) return `<div class="attachment"><img src="${safeUrl}" alt="attachment"></div>`;
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
  if (!keepPosition || wasAtBottom) el.scrollTop = el.scrollHeight;
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

document.getElementById('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
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
  showUploadStatus('Compressing ' + file.name + '…');
  try {
    const compressedFile = await compressMediaFile(file);
    if (compressedFile.size > MAX_FILE_BYTES) {
      showUploadStatus('The compressed file is still too big — 50MB max for now.');
      return;
    }
    showUploadStatus('Uploading ' + compressedFile.name + '…');
    const result = await uploadFile(compressedFile);
    await db.collection('hangout_messages').add({
      channel: currentChannel,
      author: nickname,
      text: '',
      color: myProfile.color || null,
      avatarUrl: myProfile.avatarUrl || null,
      fileUrl: result.url,
      fileName: result.name,
      fileType: result.type,
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
    hideUploadStatus();
  } catch (err) {
    showUploadStatus('Upload failed: ' + (err.message || 'unknown error'));
  } finally {
    document.getElementById('attach-btn').disabled = false;
  }
});

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
  if (onlineRenderTimer) clearInterval(onlineRenderTimer);
  presenceRefreshTimer = null;
  onlineRenderTimer = null;
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

  onlineRenderTimer = setInterval(renderOnline, 5000);
}

function enableChat() {
  chatActive = true;
  document.getElementById('msg-input').disabled = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('attach-btn').disabled = false;
  subscribeChannel(currentChannel);
}

function disableChat() {
  chatActive = false;
  clearTimeout(visibilityPauseTimer);
  visibilityPauseTimer = null;
  document.getElementById('msg-input').disabled = true;
  document.getElementById('send-btn').disabled = true;
  document.getElementById('attach-btn').disabled = true;
  if (unsubMessages) unsubMessages();
  unsubMessages = null;
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
  try { storage = firebase.storage(); } catch (e) { storage = null; }
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