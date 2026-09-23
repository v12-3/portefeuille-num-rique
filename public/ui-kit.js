/**
 * Composants d'interface partagés par le dashboard (/) et l'app mobile (/m/).
 *
 *  - PatrimoineUI.mountAuth(el)   écran de connexion autonome : il gère
 *    lui-même son état (saisie conservée en cas d'erreur, bouton bloqué pendant
 *    l'envoi, messages clairs, Google, mot de passe oublié) sans dépendre du
 *    rendu de la page — c'est ce qui effaçait la saisie à chaque erreur.
 *  - PatrimoineUI.dialog(opts)    boîte de dialogue (remplace prompt/confirm) ;
 *    l'action peut s'exécuter dedans, l'erreur s'affiche sans la fermer.
 *  - PatrimoineUI.confirm(...)    confirmation simple.
 *  - PatrimoineUI.toast(msg,kind) notification brève.
 *  - PatrimoineUI.whenReady(el,cb) attend Firebase ; si le service ne se charge
 *    pas (réseau, bloqueur), affiche une erreur avec « Réessayer » au lieu d'un
 *    chargement infini.
 *  - PatrimoineUI.run(fn,arg)     exécute une action en affichant ses erreurs.
 *
 * Script classique, sans dépendance, chargé AVANT firebase-client.js.
 */
(function () {
  'use strict';

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const CSS = `
.pk-overlay{position:fixed;inset:0;background:rgba(10,11,13,.5);display:flex;align-items:center;justify-content:center;padding:16px;z-index:1000;animation:pk-fade .12s ease-out}
.pk-dialog{background:#fff;color:var(--ink,#0a0b0d);border-radius:20px;width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow:auto;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.25);animation:pk-up .16s ease-out}
.pk-dt{font-size:18px;font-weight:600;letter-spacing:-.2px}
.pk-dm{font-size:14px;color:var(--mut,#5b616e);line-height:1.55;margin-top:8px}
.pk-df{margin-top:16px}
.pk-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
.pk-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.pk-field>span{font-size:13px;font-weight:600;color:var(--mut,#5b616e)}
.pk-field small{font-size:12px;color:var(--mut2,#7c828a);line-height:1.45}
.pk-field input,.pk-field select{height:46px;border:1px solid var(--line,#dee1e6);border-radius:12px;padding:0 14px;font-size:16px;font-family:inherit;color:var(--ink,#0a0b0d);background:#fff;width:100%;box-sizing:border-box}
.pk-field input:focus,.pk-field select:focus{outline:2px solid var(--blue,#0052ff);outline-offset:-1px;border-color:var(--blue,#0052ff)}
.pk-field input[aria-invalid=true]{border-color:var(--red,#cf202f)}
.pk-pw{position:relative}
.pk-pw input{padding-right:84px}
.pk-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);height:34px;padding:0 10px;border:0;background:transparent;color:var(--blue,#0052ff);font:600 13px/1 inherit;font-family:inherit;cursor:pointer;border-radius:8px}
.pk-eye:focus-visible{outline:2px solid var(--blue,#0052ff)}
.pk-btn{height:46px;padding:0 20px;border-radius:100px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;border:1px solid transparent;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.pk-btn[disabled]{opacity:.55;cursor:default}
.pk-btn:focus-visible{outline:2px solid var(--blue,#0052ff);outline-offset:2px}
.pk-primary{background:var(--blue,#0052ff);color:#fff}
.pk-primary:not([disabled]):hover{background:var(--blue-d,#003ecc)}
.pk-danger{background:var(--red,#cf202f);color:#fff}
.pk-ghost{background:#fff;color:var(--ink,#0a0b0d);border-color:var(--line,#dee1e6)}
.pk-block{width:100%}
.pk-msg{border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.5;margin-bottom:14px}
.pk-msg.err{background:#fff5f5;border:1px solid #f3c9cd;color:#8c1620}
.pk-msg.ok{background:#f0fdf6;border:1px solid #b9ecd2;color:#0a5c3a}
.pk-msg.info{background:#f7f9ff;border:1px solid #cfdcff;color:#1d3a8a}
.pk-spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:pk-rot .7s linear infinite;flex:none}
.pk-toasts{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:1100;width:min(92vw,440px);pointer-events:none}
.pk-toast{background:#16181c;color:#fff;border-radius:14px;padding:12px 16px;font-size:14px;line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.2);animation:pk-up .16s ease-out;pointer-events:auto}
.pk-toast.err{background:#8c1620}
.pk-toast.ok{background:#0a5c3a}
.pk-shell{box-sizing:border-box;height:100dvh;overflow-y:auto;display:flex;flex-direction:column;padding:24px 16px calc(24px + env(safe-area-inset-bottom));background:var(--bg,#f7f7f7)}
.pk-card{margin:auto;width:100%;max-width:400px;background:#fff;border:1px solid var(--line,#dee1e6);border-radius:24px;padding:32px 28px;box-sizing:border-box}
.pk-brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;font-size:18px;font-weight:600}
.pk-mark{width:32px;height:32px;border-radius:9999px;background:var(--blue,#0052ff);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700}
.pk-h{font-size:20px;font-weight:600;letter-spacing:-.3px;margin:0}
.pk-sub{font-size:14px;color:var(--mut2,#7c828a);margin:4px 0 20px;line-height:1.5}
.pk-or{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--mut3,#a8acb3);font-size:12px}
.pk-or::before,.pk-or::after{content:"";flex:1;height:1px;background:var(--line,#dee1e6)}
.pk-google{width:100%;height:46px;border-radius:100px;background:#fff;border:1px solid var(--line,#dee1e6);color:var(--ink,#0a0b0d);font-size:15px;font-weight:600;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer}
.pk-google[disabled]{opacity:.55;cursor:default}
.pk-links{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:20px;font-size:14px;color:var(--mut,#5b616e)}
.pk-link{background:none;border:0;padding:4px;font:inherit;font-weight:600;color:var(--blue,#0052ff);cursor:pointer;border-radius:6px}
.pk-link[disabled]{opacity:.55;cursor:default}
.pk-link:focus-visible{outline:2px solid var(--blue,#0052ff)}
.pk-caps{font-size:12px;color:#b7791f;margin:-8px 0 12px}
.pk-center{text-align:center;color:var(--mut,#5b616e);font-size:15px;display:flex;align-items:center;justify-content:center;gap:10px}
@media (max-width:480px){.pk-card{border:0;background:transparent;padding:8px 4px}.pk-dialog{padding:20px}}
@keyframes pk-fade{from{opacity:0}to{opacity:1}}
@keyframes pk-up{from{transform:translateY(12px);opacity:.6}to{transform:none;opacity:1}}
@keyframes pk-rot{to{transform:rotate(360deg)}}
[hidden]{display:none!important}`;

  function injectCss() {
    if (document.getElementById('pk-css')) return;
    const s = document.createElement('style');
    s.id = 'pk-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  injectCss();

  /* ============================================================
     Notifications
     ============================================================ */
  let toastBox = null;
  function toast(message, kind = 'info', ms = 4500) {
    if (!message) return;
    if (!toastBox || !document.body.contains(toastBox)) {
      toastBox = document.createElement('div');
      toastBox.className = 'pk-toasts';
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    const t = document.createElement('div');
    t.className = 'pk-toast ' + kind;
    t.textContent = message;
    t.addEventListener('click', () => t.remove());
    toastBox.appendChild(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    setTimeout(() => t.remove(), ms);
  }

  /* ============================================================
     Boîte de dialogue
     ============================================================ */
  /**
   * @param {object} o
   * @param {string} o.title
   * @param {string} [o.message]
   * @param {Array<{name,label,value?,type?,inputmode?,placeholder?,hint?,options?}>} [o.fields]
   * @param {string} [o.confirmLabel] @param {string} [o.cancelLabel] @param {boolean} [o.danger]
   * @param {(values)=>string|null} [o.validate]   message d'erreur ou null
   * @param {(values)=>Promise} [o.onConfirm]       action exécutée dans la boîte
   * @returns {Promise<object|true|null>} valeurs (ou true), null si annulé
   */
  function dialog(o) {
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'pk-overlay';
      const fields = o.fields || [];
      wrap.innerHTML = `
        <div class="pk-dialog" role="dialog" aria-modal="true" aria-labelledby="pk-dt">
          <div class="pk-dt" id="pk-dt">${esc(o.title)}</div>
          ${o.message ? `<div class="pk-dm">${esc(o.message).replace(/\n/g, '<br>')}</div>` : ''}
          <form class="pk-df" novalidate>
            ${fields.map(f => `
              <label class="pk-field"><span>${esc(f.label)}</span>
                ${f.options
                  ? `<select name="${esc(f.name)}">${f.options.map(op => `<option value="${esc(op)}"${op === f.value ? ' selected' : ''}>${esc(op)}</option>`).join('')}</select>`
                  : `<input name="${esc(f.name)}" type="${esc(f.type || 'text')}" ${f.inputmode ? `inputmode="${esc(f.inputmode)}"` : ''} ${f.max ? `max="${esc(f.max)}"` : ''}
                       placeholder="${esc(f.placeholder || '')}" value="${esc(f.value ?? '')}" autocomplete="off">`}
                ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}
              </label>`).join('')}
            <div class="pk-msg err" role="alert" hidden></div>
            <div class="pk-actions">
              <button type="button" class="pk-btn pk-ghost" data-x="cancel">${esc(o.cancelLabel || 'Annuler')}</button>
              <button type="submit" class="pk-btn ${o.danger ? 'pk-danger' : 'pk-primary'}">${esc(o.confirmLabel || 'Valider')}</button>
            </div>
          </form>
        </div>`;
      document.body.appendChild(wrap);

      const form = wrap.querySelector('form');
      const msg = wrap.querySelector('.pk-msg');
      const submit = form.querySelector('[type=submit]');
      const cancel = form.querySelector('[data-x=cancel]');
      let busy = false;

      const close = value => {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
        resolve(value);
      };
      const onKey = e => {
        if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); close(null); }
      };
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('mousedown', e => { if (e.target === wrap && !busy) close(null); });
      cancel.addEventListener('click', () => { if (!busy) close(null); });

      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (busy) return;
        const values = Object.fromEntries(new FormData(form));
        const err = o.validate ? o.validate(values) : null;
        if (err) { msg.textContent = err; msg.hidden = false; return; }
        if (o.onConfirm) {
          busy = true;
          const label = submit.innerHTML;
          submit.disabled = cancel.disabled = true;
          submit.innerHTML = '<span class="pk-spin"></span>' + label;
          msg.hidden = true;
          try { await o.onConfirm(values); }
          catch (ex) {
            busy = false;
            submit.disabled = cancel.disabled = false;
            submit.innerHTML = label;
            msg.textContent = ex?.message || 'Une erreur est survenue.';
            msg.hidden = false;
            return;
          }
        }
        close(fields.length ? values : true);
      });

      const first = form.querySelector('input,select');
      setTimeout(() => { (first || submit).focus(); first?.select?.(); }, 30);
    });
  }

  const confirmDialog = (title, message, opts = {}) =>
    dialog({ title, message, confirmLabel: opts.confirmLabel || 'Confirmer', danger: !!opts.danger, onConfirm: opts.onConfirm })
      .then(v => v === true);

  /* ============================================================
     Écran de connexion
     ============================================================ */
  const auth = { mode: 'signin', email: '', busy: false, msg: null, kind: 'err' };

  const GOOGLE_ICON = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.68-3.87 2.68-6.64z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.27c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.34C2.44 16.02 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.95 10.69A5.4 5.4 0 013.68 9c0-.59.1-1.16.27-1.69V4.97H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.03l2.99-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 1.98.96 4.97l2.99 2.34C4.66 5.17 6.65 3.58 9 3.58z"/></svg>';

  const TEXT = {
    signin: { h: 'Connexion', sub: 'Retrouve ton portefeuille sur tous tes appareils.', btn: 'Se connecter', busy: 'Connexion…' },
    signup: { h: 'Créer un compte', sub: 'Gratuit. Tes données restent privées, visibles de toi seul.', btn: 'Créer mon compte', busy: 'Création du compte…' },
    reset:  { h: 'Mot de passe oublié', sub: 'Indique ton e-mail : tu recevras un lien pour choisir un nouveau mot de passe.', btn: 'Envoyer le lien', busy: 'Envoi…' }
  };

  function mountAuth(container) {
    const A = window.PatrimoineAuth;
    const redirectErr = A?.takeRedirectError?.();
    if (redirectErr) { auth.msg = redirectErr; auth.kind = 'err'; }
    auth.busy = false;
    draw(container);
  }

  function draw(container) {
    const t = TEXT[auth.mode];
    const pwd = auth.mode !== 'reset';
    const signup = auth.mode === 'signup';
    container.innerHTML = `
      <div class="pk-shell">
        <div class="pk-card pk-auth">
          <div class="pk-brand"><div class="pk-mark" aria-hidden="true">P</div><div>Patrimoine</div></div>
          <h1 class="pk-h">${t.h}</h1>
          <p class="pk-sub">${t.sub}</p>
          <div class="pk-msg" role="alert" aria-live="polite" hidden></div>
          <form novalidate>
            <label class="pk-field"><span>E-mail</span>
              <input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" value="${esc(auth.email)}" required>
            </label>
            ${pwd ? `
            <label class="pk-field"><span>Mot de passe${signup ? ' (6 caractères minimum)' : ''}</span>
              <div class="pk-pw">
                <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
                <button type="button" class="pk-eye" data-eye aria-label="Afficher le mot de passe">Afficher</button>
              </div>
            </label>` : ''}
            ${signup ? `
            <label class="pk-field"><span>Confirme le mot de passe</span>
              <input name="confirm" type="password" autocomplete="new-password" required>
            </label>` : ''}
            <div class="pk-caps" hidden>Verrouillage des majuscules activé</div>
            <button type="submit" class="pk-btn pk-primary pk-block">${t.btn}</button>
          </form>
          ${auth.mode !== 'reset' ? `
          <div class="pk-or">ou</div>
          <button type="button" class="pk-google" data-google>${GOOGLE_ICON}Continuer avec Google</button>` : ''}
          <div class="pk-links">
            ${auth.mode === 'signin' ? `
              <button type="button" class="pk-link" data-mode="reset">Mot de passe oublié ?</button>
              <div>Pas encore de compte ? <button type="button" class="pk-link" data-mode="signup">Créer un compte</button></div>` : ''}
            ${auth.mode === 'signup' ? `<div>Déjà un compte ? <button type="button" class="pk-link" data-mode="signin">Se connecter</button></div>` : ''}
            ${auth.mode === 'reset' ? `<button type="button" class="pk-link" data-mode="signin">← Retour à la connexion</button>` : ''}
          </div>
        </div>
      </div>`;

    const root = container.querySelector('.pk-auth');
    const form = root.querySelector('form');
    const email = form.elements.email;
    const password = form.elements.password;
    const confirm = form.elements.confirm;
    const submit = form.querySelector('[type=submit]');
    const google = root.querySelector('[data-google]');
    const msgBox = root.querySelector('.pk-msg');
    const caps = root.querySelector('.pk-caps');

    const showMsg = (text, kind = 'err') => {
      auth.msg = text; auth.kind = kind;
      msgBox.textContent = text || '';
      msgBox.className = 'pk-msg ' + kind;
      msgBox.hidden = !text;
    };
    const setBusy = on => {
      auth.busy = on;
      root.querySelectorAll('input,button').forEach(el => { if (!el.hasAttribute('data-eye')) el.disabled = on; });
      submit.innerHTML = on ? `<span class="pk-spin"></span>${t.busy}` : t.btn;
    };
    if (auth.msg) showMsg(auth.msg, auth.kind);

    email.addEventListener('input', () => { auth.email = email.value; email.removeAttribute('aria-invalid'); });

    root.querySelector('[data-eye]')?.addEventListener('click', e => {
      const show = password.type === 'password';
      password.type = show ? 'text' : 'password';
      if (confirm) confirm.type = password.type;
      e.currentTarget.textContent = show ? 'Masquer' : 'Afficher';
      e.currentTarget.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      password.focus();
    });

    const capsCheck = e => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
    password?.addEventListener('keydown', capsCheck);
    password?.addEventListener('keyup', capsCheck);

    root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      if (auth.busy) return;
      auth.mode = b.dataset.mode;
      auth.email = email.value.trim();
      auth.msg = null;
      draw(container);
      container.querySelector('input[name=email]')?.focus();
    }));

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (auth.busy) return;
      const A = window.PatrimoineAuth;
      const mail = email.value.trim();
      auth.email = mail;
      showMsg(null);

      // vérifications locales : message immédiat, sans aller-retour réseau
      if (!mail) { showMsg('Renseigne ton adresse e-mail.'); email.setAttribute('aria-invalid', 'true'); email.focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) { showMsg('Adresse e-mail invalide.'); email.setAttribute('aria-invalid', 'true'); email.focus(); return; }
      if (password && !password.value) { showMsg('Renseigne ton mot de passe.'); password.focus(); return; }
      if (auth.mode === 'signup') {
        if (password.value.length < 6) { showMsg('Mot de passe trop court : 6 caractères minimum.'); password.focus(); return; }
        if (password.value !== confirm.value) { showMsg('Les deux mots de passe ne sont pas identiques.'); confirm.focus(); confirm.select(); return; }
      }

      setBusy(true);
      try {
        if (auth.mode === 'reset') {
          await A.resetPassword(mail);
          setBusy(false);
          showMsg(`Si un compte existe pour ${mail}, un lien de réinitialisation vient d'être envoyé. Pense à regarder dans les spams.`, 'ok');
          return;
        }
        if (auth.mode === 'signup') await A.signUp(mail, password.value);
        else await A.signIn(mail, password.value);
        // succès : la page bascule d'elle-même sur le portefeuille. Filet de
        // sécurité si la bascule tarde : on rend la main au formulaire.
        auth.msg = null;
        setTimeout(() => { if (document.contains(root) && auth.busy) setBusy(false); }, 8000);
      } catch (ex) {
        setBusy(false);
        showMsg(ex?.message || 'Connexion impossible. Réessaie.');
        if (password) { password.value = ''; password.focus(); }
        if (confirm) confirm.value = '';
      }
    });

    google?.addEventListener('click', async () => {
      if (auth.busy) return;
      showMsg(null);
      setBusy(true);
      try {
        const r = await window.PatrimoineAuth.signInGoogle();
        if (r?.cancelled) { setBusy(false); return; }
        if (r?.redirecting) { showMsg('Redirection vers Google…', 'info'); return; }
        setTimeout(() => { if (document.contains(root) && auth.busy) setBusy(false); }, 8000);
      } catch (ex) {
        setBusy(false);
        showMsg(ex?.message || 'Connexion Google impossible. Réessaie.');
      }
    });

    // focus automatique seulement sur ordinateur (sur mobile il ouvrirait le clavier)
    if (window.matchMedia?.('(pointer:fine)').matches) {
      setTimeout(() => ((auth.email && password) ? password : email).focus(), 30);
    }
  }

  /* ============================================================
     Démarrage : attendre Firebase, ou expliquer pourquoi il manque
     ============================================================ */
  let bootFailed = null;
  const bootFailListeners = new Set();
  function bootFail(message) {
    if (bootFailed || window.PatrimoineAuth) return;
    bootFailed = message;
    bootFailListeners.forEach(cb => cb(message));
  }
  // échec de chargement d'un script essentiel (y compris le SDK Firebase importé
  // par le module) : l'erreur est visible en phase de capture sur window
  window.addEventListener('error', e => {
    const el = e.target;
    if (el && el.tagName === 'SCRIPT' && /firebase-client|app-core|firebase-config/.test(el.src || '')) {
      bootFail(navigator.onLine === false
        ? 'Pas de connexion internet : impossible de charger l\'application.'
        : 'Le service de connexion n\'a pas pu être chargé (réseau filtré ou bloqueur de contenu ?).');
    }
  }, true);
  window.addEventListener('patrimoine:failed', e => bootFail(e.detail || 'Démarrage impossible.'));

  function loading(container, text = 'Chargement…') {
    container.innerHTML = `<div class="pk-shell"><div class="pk-center" style="margin:auto"><span class="pk-spin"></span>${esc(text)}</div></div>`;
  }

  function showBootError(container, message) {
    container.innerHTML = `
      <div class="pk-shell"><div class="pk-card">
        <div class="pk-brand"><div class="pk-mark" aria-hidden="true">P</div><div>Patrimoine</div></div>
        <h1 class="pk-h">Impossible de démarrer</h1>
        <p class="pk-sub">${esc(message)}</p>
        <button type="button" class="pk-btn pk-primary pk-block" data-reload>Réessayer</button>
      </div></div>`;
    container.querySelector('[data-reload]').addEventListener('click', () => location.reload());
  }

  function whenReady(container, cb, timeout = 20000) {
    if (window.PatrimoineAuth) { cb(); return; }
    let done = false;
    const finish = fn => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const onFail = msg => finish(() => showBootError(container, msg));
    if (window.PatrimoineBootError) { onFail(window.PatrimoineBootError); return; }
    if (bootFailed) { onFail(bootFailed); return; }
    bootFailListeners.add(onFail);
    window.addEventListener('patrimoine:ready', () => finish(cb), { once: true });
    const timer = setTimeout(() => onFail(navigator.onLine === false
      ? 'Pas de connexion internet : impossible de joindre le service de connexion.'
      : 'Le service de connexion ne répond pas. Vérifie ta connexion, désactive un éventuel bloqueur de contenu pour ce site, puis réessaie.'), timeout);
  }

  /* ============================================================
     Actions et erreurs non rattrapées
     ============================================================ */
  function run(fn, arg) {
    const fail = e => { console.error(e); toast(e?.message || 'Une erreur est survenue.', 'err'); };
    try {
      const r = fn(arg);
      if (r && typeof r.then === 'function') r.catch(fail);
    } catch (e) { fail(e); }
  }

  let lastReport = 0;
  window.addEventListener('error', e => {
    if (e.target && e.target !== window) return;                      // ressource : traité plus haut
    if (e.filename && !e.filename.startsWith(location.origin)) return; // extension du navigateur, etc.
    if (/ResizeObserver loop/.test(e.message || '')) return;          // bénin
    console.error('[erreur]', e.error || e.message);
    if (Date.now() - lastReport < 5000) return;
    lastReport = Date.now();
    toast('Une erreur inattendue est survenue. Si l\'affichage semble bloqué, recharge la page.', 'err', 6000);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    if (r?.name === 'AbortError') return;
    console.error('[promesse]', r);
    if (r?.userMessage && Date.now() - lastReport > 5000) { lastReport = Date.now(); toast(r.message, 'err'); }
  });

  window.PatrimoineUI = { mountAuth, dialog, confirm: confirmDialog, toast, whenReady, loading, run, esc };
})();
