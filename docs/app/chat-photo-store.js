const DATABASE = 'ethere-chat-photos';
const STORE = 'originals';
let databasePromise;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

export async function saveChatPhotoOriginal(file) {
  const database = await openDatabase();
  if (!database) return null;
  const id = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(file, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return id;
}

export async function loadChatPhotoOriginal(id) {
  if (!id) return null;
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function removeChatPhotoOriginal(id) {
  if (!id) return;
  const database = await openDatabase();
  if (!database) return;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
