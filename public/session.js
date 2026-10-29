(function () {
  var _fetch = window.fetch;

  // Session khatam ho to login page par bhejo
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

  function setup(u) {
    var h = document.querySelector('aside h1');
    if (h) h.insertAdjacentHTML('afterbegin', '<img src="logo.png" alt="" onerror="this.remove()" style="display:block;height:42px;background:#fff;border-radius:8px;padding:4px;margin-bottom:10px">');

    var box = document.querySelector('.topbar > div');
    if (box) box.insertAdjacentHTML('beforeend',
      ' <span style="margin:0 8px;font-size:13px">👤 ' + u.full_name + ' (' + (u.role === 'admin' ? 'admin' : 'view only') + ')</span><button onclick="logout()">Logout</button>');

    var nav = document.querySelector('aside nav');
    if (nav) {
      if (u.role === 'admin') nav.insertAdjacentHTML('beforeend', '<button onclick="location.href=\'users.html\'">👥 Users</button>');
      nav.insertAdjacentHTML('beforeend', '<button onclick="changePw()">🔑 Change Password</button>');
    }

    if (u.role !== 'admin') {
      var st = document.createElement('style');
      st.textContent = '.form,.del,.sm{display:none!important}';
      document.head.appendChild(st);
    }
  }

  _fetch('/api/auth/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (u) {
    if (!u || u.must_change) { location.href = 'login.html'; return; }
    window.ME = u;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setup(u); });
    else setup(u);
  });
})();