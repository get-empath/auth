// Stand-in for the Firebase compat SDKs, served in place of the gstatic
// scripts. Tests drive it through window.__fake: sign a user in, push
// snapshots of users/{uid}, and read back the writes the page made.
(() => {
  const fake = {
    user: null,
    authCallbacks: [],
    listeners: [],
    calls: [],
    signedIn(user) {
      fake.user = user;
      fake.authCallbacks.forEach((cb) => cb(user));
    },
    signedOut() {
      fake.user = null;
      fake.authCallbacks.forEach((cb) => cb(null));
    },
    // data: object for an existing document, null for a missing one.
    snapshot(data, { fromCache = false } = {}) {
      const doc = {
        exists: data !== null,
        data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
        metadata: { fromCache }
      };
      fake.listeners.filter((l) => l.active).forEach((l) => l.next(doc));
    },
    fail(code) {
      fake.listeners.filter((l) => l.active).forEach((l) => l.error({ code, message: code }));
    },
    activeListeners: () => fake.listeners.filter((l) => l.active).length,
    updateShouldFail: false
  };
  window.__fake = fake;

  // Sign-out ends in a navigation, so its steps also go to sessionStorage,
  // which the next page on this origin can still read.
  function logSignOutStep(step) {
    fake.calls.push([step]);
    const log = JSON.parse(sessionStorage.getItem('signOutLog') || '[]');
    log.push({ step, activeListeners: fake.activeListeners() });
    sessionStorage.setItem('signOutLog', JSON.stringify(log));
  }

  const auth = {
    get currentUser() { return fake.user; },
    onAuthStateChanged(cb) {
      fake.authCallbacks.push(cb);
    },
    async signOut() {
      logSignOutStep('signOut');
      fake.signedOut();
    }
  };

  function docRef(collection, id) {
    return {
      onSnapshot(options, next, error) {
        fake.calls.push(['onSnapshot', collection, id, options]);
        const listener = { next, error, active: true };
        fake.listeners.push(listener);
        return () => { listener.active = false; };
      },
      async get() {
        fake.calls.push(['get', collection, id]);
        throw new Error('dashboard should not call get()');
      },
      async set(data, options) {
        fake.calls.push(['set', collection, id, data, options]);
      },
      async update(data) {
        fake.calls.push(['update', collection, id, data]);
        if (fake.updateShouldFail) throw new Error('update failed');
      }
    };
  }

  const firestore = {
    enablePersistence(options) {
      fake.calls.push(['enablePersistence', options]);
      return Promise.resolve();
    },
    collection: (name) => ({ doc: (id) => docRef(name, id) }),
    async terminate() { logSignOutStep('terminate'); },
    async clearPersistence() { logSignOutStep('clearPersistence'); }
  };

  const firestoreFn = () => firestore;
  firestoreFn.FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true }) };

  window.firebase = {
    initializeApp(config) { fake.calls.push(['initializeApp', config.projectId]); },
    auth: () => auth,
    firestore: firestoreFn
  };
})();
