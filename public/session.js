(function () {
  var _fetch = window.fetch;

  // If the session expires, send the user to the login page
  window.fetch = function () {
    return _fetch.apply(this, arguments).then(function (r) {
      if (r.status === 401) location.href = 'login.html';
      return r;
    });
  };

  window.logout = function () {
    _fetch('/api/auth/logout', { method: 'POST' }).then(function () { location.href = 'login.html'; });
  };

  window.changePw = function () {
    var cur = prompt('Current password:');
    if (cur === null) return;
    var np = prompt('New password (min 8 characters, letters and numbers):');
    if (np === null) return;
    _fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: cur, new_password: np })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) { alert(x.ok ? 'Password changed successfully.' : x.d.error); });
  };

  var ROLE_LABEL = { admin: 'admin', user: 'user', viewer: 'view only' };

  // Hides every Delete button (used for non-admin roles)
  function hideDeleteButtons() {
    document.querySelectorAll('button, a').forEach(function (b) {
      var t = (b.textContent || '').trim().toLowerCase();
      var oc = (b.getAttribute('onclick') || '').toLowerCase();
      if (t === 'delete' || t.indexOf('delete') === 0 || /(^|[^a-z])del[a-z]*\(/.test(oc)) {
        b.style.display = 'none';
      }
    });
  }

  function setup(u) {
    var h = document.querySelector('aside h1');
    if (h) h.insertAdjacentHTML('afterbegin', '<img src="logo.png" alt="" onerror="this.remove()" style="display:block;height:42px;background:#fff;border-radius:8px;padding:4px;margin-bottom:10px">');

    var box = document.querySelector('.topbar > div');
    if (box) box.insertAdjacentHTML('beforeend',
      ' <span style="margin:0 8px;font-size:13px">👤 ' + u.full_name + ' (' + (ROLE_LABEL[u.role] || 'view only') + ')</span><button onclick="logout()">Logout</button>');

    var nav = document.querySelector('aside nav');
    if (nav) {
      if (u.role === 'admin') nav.insertAdjacentHTML('beforeend', '<button onclick="location.href=\'users.html\'">👥 Users</button>');
      nav.insertAdjacentHTML('beforeend', '<button onclick="changePw()">🔑 Change Password</button>');
    }

    if (u.role === 'viewer') {
      // View only: hide forms, delete and small action buttons
      var st = document.createElement('style');
      st.textContent = '.form,.del,.sm{display:none!important}';
      document.head.appendChild(st);
    } else if (u.role === 'user') {
      // User: can add and edit, but never delete
      var st2 = document.createElement('style');
      st2.textContent = '.del{display:none!important}';
      document.head.appendChild(st2);
    }

    if (u.role !== 'admin') {
      // Tables are drawn after data loads, so keep hiding Delete buttons as they appear
      hideDeleteButtons();
      var timer = null;
      new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(hideDeleteButtons, 50);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  _fetch('/api/auth/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (u) {
    if (!u || u.must_change) { location.href = 'login.html'; return; }
    window.ME = u;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setup(u); });
    else setup(u);
  });
})();