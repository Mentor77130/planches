/* Planches — worker de décompression des archives RAR (CBR).
 * Un worker par archive ouverte : le fil principal le termine à la fermeture.
 *
 * Protocole (fil principal → worker) :
 *   open { id, file }       lit l'en-tête et renvoie la liste des pages ;
 *   need { id, indices }    pages à décompresser, par priorité (remplace la demande précédente) ;
 *   drop { id, indices }    pages libérées par le fil principal : à redécompresser si redemandées.
 * Seules les pages demandées sont décompressées : la mémoire reste bornée même pour une BD de 700 Mo. */
// même version que le worker (paramètre ?v=…), pour ne jamais mélanger deux déploiements
importScripts('formats.js' + self.location.search);
const F = self.PlanchesFormats;

let session = null;

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.cmd === 'open') { open(m.id, m.file); return; }
  if (!session || session.id !== m.id) return;
  if (m.cmd === 'need') session.need(m.indices || []);
  else if (m.cmd === 'drop') session.drop(m.indices || []);
};

function sourceFor(file) {
  const frs = new FileReaderSync();
  return {
    size: file.size,
    read(pos, len) {
      const end = Math.min(file.size, pos + len);
      if (end <= pos) return new Uint8Array(0);
      return new Uint8Array(frs.readAsArrayBuffer(file.slice(pos, end)));
    },
  };
}

function open(id, file) {
  let arc;
  try {
    arc = F.openRar(sourceFor(file));
  } catch (err) {
    postMessage({ type: 'error', id, code: err.code || 'error', message: err.message || String(err) });
    return;
  }
  const files = arc.entries.filter((e) => !e.isDir);
  const images = files.filter((e) => F.isImageName(e.name));
  if (!images.length) {
    const enc = files.some((e) => e.encrypted);
    postMessage({
      type: 'error', id, code: enc ? 'encrypted' : 'empty',
      message: enc ? 'Archive protégée par un mot de passe : non prise en charge.' : "Aucune image trouvée dans l'archive.",
    });
    return;
  }
  const order = images.slice().sort((a, b) => F.naturalCompare(a.name, b.name));
  const solid = files.some((e) => e.solid && e.method !== 0);
  postMessage({
    type: 'list', id, solid, format: arc.format,
    entries: order.map((e) => ({ index: e.index, name: e.name, size: e.unpSize })),
  });
  session = new Session(id, arc, solid);
}

class Session {
  constructor(id, arc, solid) {
    this.id = id;
    this.arc = arc;
    this.solid = solid;
    this.queue = [];
    this.sent = new Set();
    this.running = false;
    // archive solide : atteindre une page lointaine oblige à décompresser toutes celles d'avant
    let last = 0;
    arc.onChain = (done, total) => {
      const now = Date.now();
      if (total < 4 || (now - last < 250 && done < total)) return;
      last = now;
      postMessage({ type: 'chain', id, done, total });
    };
  }
  need(indices) {
    const q = indices.filter((i) => !this.sent.has(i));
    // archive solide : dans l'ordre de l'archive, pour ne jamais revenir en arrière sans nécessité
    if (this.solid) q.sort((a, b) => a - b);
    this.queue = q;
    if (!this.running && q.length) this.run();
  }
  drop(indices) { for (const i of indices) this.sent.delete(i); }
  async run() {
    this.running = true;
    while (this.queue.length) {
      const index = this.queue.shift();
      if (this.sent.has(index)) continue;
      this.sent.add(index);
      const e = this.arc.entries[index];
      try {
        const data = this.arc.extract(index);
        const info = F.sniffImage(data.subarray(0, Math.min(data.length, 1 << 18))) || {};
        const buffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
        postMessage({
          type: 'page', id: this.id, index, buffer,
          mime: info.mime || F.mimeFromName(e.name), w: info.w || 0, h: info.h || 0,
          crcOk: e.crcOk !== false,
        }, [buffer]);
      } catch (err) {
        postMessage({ type: 'page-error', id: this.id, index, code: err.code || 'error', message: err.message || String(err) });
      }
      // laisse passer les nouvelles demandes (la lecture a pu avancer) entre deux pages
      await new Promise((r) => setTimeout(r, 0));
    }
    this.running = false;
  }
}
