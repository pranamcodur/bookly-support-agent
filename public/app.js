(function () {
  const chatLog = document.getElementById('chatLog');
  const form = document.getElementById('composer');
  const input = document.getElementById('messageInput');
  const micBtn = document.getElementById('micBtn');
  const engineSelect = document.getElementById('engineSelect');
  const accountBox = document.getElementById('accountBox');

  let sessionId = localStorage.getItem('bookly-session-id') || null;
  let currentEngine = localStorage.getItem('bookly-engine') || 'llm';
  let authToken = localStorage.getItem('bookly-auth-token') || null;
  let currentUser = null; // { username, email } | null
  engineSelect.value = currentEngine;

  function authHeaders(extra) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return headers;
  }

  function scrollToBottom() {
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function addMessage(text, who) {
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.textContent = text;
    chatLog.appendChild(el);
    scrollToBottom();
    return el;
  }

  // Tool-driven replies (order lookups, refund confirmations) render as a
  // dashed "receipt" card instead of a plain chat bubble, so it's visually
  // clear when the agent actually took an action against a backend system.
  function addToolReceipt(text, toolName) {
    const el = document.createElement('div');
    el.className = 'msg tool-receipt';
    const label = document.createElement('span');
    label.className = 'receipt-label';
    label.textContent = `◆ ${toolName}`;
    el.appendChild(label);
    const body = document.createElement('span');
    body.textContent = text;
    el.appendChild(body);
    chatLog.appendChild(el);
    scrollToBottom();
  }

  function addSystemNote(text) {
    const el = document.createElement('div');
    el.className = 'msg system-note';
    el.textContent = text;
    chatLog.appendChild(el);
    scrollToBottom();
  }

  function addTyping() {
    const el = document.createElement('div');
    el.className = 'typing';
    el.textContent = 'Bookly is typing…';
    chatLog.appendChild(el);
    scrollToBottom();
    return el;
  }

  function greet() {
    const who = currentUser ? `, ${currentUser.username}` : '';
    addMessage(`Hi${who}! I'm the Bookly support assistant. How can I help today?`, 'bot');
  }

  async function sendMessage(text) {
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';
    const typingEl = addTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, message: text, engine: currentEngine }),
      });
      const data = await res.json();
      typingEl.remove();

      if (data.sessionId) {
        sessionId = data.sessionId;
        localStorage.setItem('bookly-session-id', sessionId);
      }
      if (data.engine && data.engine !== currentEngine) {
        // Server had to fall back (e.g. no API key) — reflect the actual engine used.
        currentEngine = data.engine;
        engineSelect.value = currentEngine;
        localStorage.setItem('bookly-engine', currentEngine);
      }
      if (data.note) addSystemNote(data.note);

      if (data.meta && data.meta.tool) {
        addToolReceipt(data.reply, data.meta.tool);
      } else {
        addMessage(data.reply, 'bot');
      }
    } catch (err) {
      typingEl.remove();
      addMessage("Sorry, I'm having trouble reaching the support desk right now.", 'bot');
      console.error(err);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(input.value.trim());
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => sendMessage(chip.dataset.msg));
  });

  async function resetConversation(requestedEngine) {
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, engine: requestedEngine }),
      });
      const data = await res.json();
      currentEngine = data.engine || requestedEngine;
      engineSelect.value = currentEngine;
      localStorage.setItem('bookly-engine', currentEngine);
      if (data.sessionId) {
        sessionId = data.sessionId;
        localStorage.setItem('bookly-session-id', sessionId);
      }
      chatLog.innerHTML = '';
      greet();
      if (data.note) addSystemNote(data.note);
    } catch (err) {
      console.error(err);
    }
  }

  engineSelect.addEventListener('change', () => resetConversation(engineSelect.value));

  // --- Voice input (Web Speech API) ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let listening = false;

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add('listening');
    };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove('listening');
    };
    recognition.onerror = () => {
      listening = false;
      micBtn.classList.remove('listening');
    };
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      input.value = transcript;
      sendMessage(transcript.trim());
    };

    micBtn.addEventListener('click', () => {
      if (listening) {
        recognition.stop();
      } else {
        recognition.start();
      }
    });
  } else {
    micBtn.disabled = true;
    micBtn.title = 'Voice input not supported in this browser';
  }

  // ---------------------------------------------------------------------
  // Auth: login / registration / password reset
  // ---------------------------------------------------------------------

  const backdrop = document.getElementById('authBackdrop');
  const closeBtn = document.getElementById('authCloseBtn');
  const loginOpenBtn = document.getElementById('loginOpenBtn');
  const tabs = document.querySelectorAll('.auth-tab');
  const title = document.getElementById('authTitle');
  const panels = {
    login: document.getElementById('loginForm'),
    register: document.getElementById('registerForm'),
    forgot: document.getElementById('forgotForm'),
    reset: document.getElementById('resetForm'),
  };
  const titles = {
    login: 'Log in to Bookly',
    register: 'Create your Bookly account',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  };

  function showView(view) {
    Object.entries(panels).forEach(([name, el]) => {
      el.hidden = name !== view;
    });
    title.textContent = titles[view];
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    document.getElementById('authTabs').style.display = view === 'login' || view === 'register' ? 'flex' : 'none';
    document.querySelectorAll('.auth-error').forEach((el) => (el.textContent = ''));
  }

  function openModal(view) {
    backdrop.hidden = false;
    showView(view || 'login');
  }
  function closeModal() {
    backdrop.hidden = true;
  }

  loginOpenBtn.addEventListener('click', () => openModal('login'));
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  tabs.forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
  document.getElementById('forgotPasswordLink').addEventListener('click', () => showView('forgot'));
  document.getElementById('backToLoginLink').addEventListener('click', () => showView('login'));

  function setError(formName, message) {
    const el = document.querySelector(`.auth-error[data-error-for="${formName}"]`);
    if (el) el.textContent = message || '';
  }

  function renderAccountBox() {
    accountBox.innerHTML = '';
    if (currentUser) {
      const span = document.createElement('span');
      span.className = 'account-user';
      span.textContent = currentUser.username;
      const logoutBtn = document.createElement('button');
      logoutBtn.type = 'button';
      logoutBtn.className = 'logout-btn';
      logoutBtn.textContent = 'Log out';
      logoutBtn.addEventListener('click', logout);
      accountBox.appendChild(span);
      accountBox.appendChild(logoutBtn);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'account-btn primary';
      btn.textContent = 'Log in';
      btn.addEventListener('click', () => openModal('login'));
      accountBox.appendChild(btn);
    }
  }

  async function onAuthSuccess(user, token) {
    currentUser = user;
    authToken = token;
    localStorage.setItem('bookly-auth-token', token);
    renderAccountBox();
    closeModal();
    // Personalize the running conversation for the now-known/changed user.
    await resetConversation(currentEngine);
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
    } catch (err) {
      /* best effort */
    }
    currentUser = null;
    authToken = null;
    localStorage.removeItem('bookly-auth-token');
    renderAccountBox();
    await resetConversation(currentEngine);
  }

  panels.login.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('login', '');
    const fd = new FormData(panels.login);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
      });
      const data = await res.json();
      if (!res.ok) return setError('login', data.error || 'Login failed.');
      panels.login.reset();
      await onAuthSuccess(data.user, data.token);
    } catch (err) {
      setError('login', 'Something went wrong. Please try again.');
    }
  });

  panels.register.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('register', '');
    const fd = new FormData(panels.register);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: fd.get('username'),
          email: fd.get('email'),
          password: fd.get('password'),
        }),
      });
      const data = await res.json();
      if (!res.ok) return setError('register', data.error || 'Registration failed.');
      panels.register.reset();
      await onAuthSuccess(data.user, data.token);
    } catch (err) {
      setError('register', 'Something went wrong. Please try again.');
    }
  });

  panels.forgot.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('forgot', '');
    const fd = new FormData(panels.forgot);
    try {
      const res = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: fd.get('usernameOrEmail') }),
      });
      const data = await res.json();
      if (!res.ok) return setError('forgot', data.error || 'Something went wrong.');
      panels.forgot.reset();
      const note = document.getElementById('resetDevNote');
      if (data.devResetToken) {
        note.textContent =
          `No email service is configured in this demo, so here's your reset code directly: ${data.devResetToken}`;
        panels.reset.querySelector('input[name="token"]').value = data.devResetToken;
      } else {
        note.textContent = "If an account exists for that username/email, we've sent reset instructions.";
      }
      showView('reset');
    } catch (err) {
      setError('forgot', 'Something went wrong. Please try again.');
    }
  });

  panels.reset.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('reset', '');
    const fd = new FormData(panels.reset);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fd.get('token'), newPassword: fd.get('newPassword') }),
      });
      const data = await res.json();
      if (!res.ok) return setError('reset', data.error || 'Reset failed.');
      panels.reset.reset();
      showView('login');
      setError('login', '');
      addSystemNote('Password updated — you can log in with your new password now.');
    } catch (err) {
      setError('reset', 'Something went wrong. Please try again.');
    }
  });

  // Restore session on page load, if we have a stored token.
  async function restoreSession() {
    if (!authToken) {
      renderAccountBox();
      greet();
      input.focus();
      return;
    }
    try {
      const res = await fetch('/api/auth/me', { headers: authHeaders() });
      if (!res.ok) throw new Error('invalid session');
      const data = await res.json();
      currentUser = data.user;
    } catch (err) {
      authToken = null;
      localStorage.removeItem('bookly-auth-token');
    }
    renderAccountBox();
    greet();
    input.focus();
  }

  restoreSession();
})();
