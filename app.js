/*
 * RotarVideo — gira videos MP4/MOV sin recodificar.
 *
 * En vez de reprocesar los fotogramas, edita la matriz de transformación del
 * track de video (átomo moov > trak > tkhd), que es exactamente el mecanismo
 * que usa el propio iPhone para marcar la orientación de sus grabaciones.
 * El resultado se construye como Blob compuesto por trozos del archivo
 * original + 44 bytes nuevos, así que es instantáneo y no carga el video
 * entero en memoria.
 */

(function () {
  'use strict';

  var FIXED_1 = 65536;          // 1.0 en punto fijo 16.16
  var FIXED_W = 0x40000000;     // 1.0 en punto fijo 2.30 (componente w de la matriz)
  var MAX_MOOV = 128 * 1024 * 1024;

  function str4(dv, off) {
    return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  }

  async function readBytes(file, start, len) {
    var buf = await file.slice(start, start + len).arrayBuffer();
    return new DataView(buf);
  }

  /* Recorre los átomos de primer nivel del archivo leyendo solo cabeceras. */
  async function findTopLevelBox(file, type) {
    var off = 0;
    while (off + 8 <= file.size) {
      var headLen = Math.min(16, file.size - off);
      var dv = await readBytes(file, off, headLen);
      var size = dv.getUint32(0);
      var boxType = str4(dv, 4);
      if (size === 1) {
        if (headLen < 16) break;
        size = Number(dv.getBigUint64(8));
      } else if (size === 0) {
        size = file.size - off;
      }
      if (size < 8 || off + size > file.size) break;
      if (boxType === type) return { start: off, size: size };
      off += size;
    }
    return null;
  }

  /* Itera los átomos hijos dentro de un buffer ya cargado. */
  function childBoxes(dv, start, end) {
    var out = [];
    var off = start;
    while (off + 8 <= end) {
      var size = dv.getUint32(off);
      var type = str4(dv, off + 4);
      var header = 8;
      if (size === 1) {
        if (off + 16 > end) break;
        size = Number(dv.getBigUint64(off + 8));
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) break;
      out.push({ type: type, off: off, size: size, header: header });
      off += size;
    }
    return out;
  }

  function findChild(dv, box, type) {
    var kids = childBoxes(dv, box.off + box.header, box.off + box.size);
    for (var i = 0; i < kids.length; i++) if (kids[i].type === type) return kids[i];
    return null;
  }

  /* Ángulo de rotación (0/90/180/270, sentido horario) implícito en la matriz. */
  function angleFromMatrix(a, b) {
    if (a === 0 && b === 0) return 0; // matriz corrupta/vacía: asumimos 0
    var deg = Math.atan2(b, a) * 180 / Math.PI;
    return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  }

  /*
   * Matriz canónica de presentación para un giro horario de `angle` grados
   * sobre un fotograma codificado de W×H px. Orden en archivo: a b u c d v x y w.
   */
  function matrixBytes(angle, W, H) {
    var vals;
    switch (angle) {
      case 90:  vals = [0, FIXED_1, 0,   -FIXED_1, 0, 0,   H * FIXED_1, 0, FIXED_W]; break;
      case 180: vals = [-FIXED_1, 0, 0,   0, -FIXED_1, 0,  W * FIXED_1, H * FIXED_1, FIXED_W]; break;
      case 270: vals = [0, -FIXED_1, 0,   FIXED_1, 0, 0,   0, W * FIXED_1, FIXED_W]; break;
      default:  vals = [FIXED_1, 0, 0,    0, FIXED_1, 0,   0, 0, FIXED_W]; break;
    }
    var dv = new DataView(new ArrayBuffer(36));
    for (var i = 0; i < 9; i++) dv.setInt32(i * 4, vals[i]);
    return new Uint8Array(dv.buffer);
  }

  /*
   * Analiza el archivo: localiza el moov, y por cada track de video devuelve
   * su rotación actual, dimensiones codificadas y la posición absoluta de la
   * matriz dentro del archivo.
   */
  async function analyzeVideo(file) {
    var moov = await findTopLevelBox(file, 'moov');
    if (!moov) throw new Error('No se encontró la información del video. ¿Es un archivo MP4 o MOV?');
    if (moov.size > MAX_MOOV) throw new Error('El índice del video es demasiado grande.');

    var dv = new DataView(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
    var moovBox = childBoxes(dv, 0, moov.size)[0];
    if (!moovBox || moovBox.type !== 'moov') throw new Error('No se pudo leer la información del video.');

    var tracks = [];
    var kids = childBoxes(dv, moovBox.off + moovBox.header, moovBox.size);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].type !== 'trak') continue;
      var trak = kids[i];
      var tkhd = findChild(dv, trak, 'tkhd');
      var mdia = findChild(dv, trak, 'mdia');
      if (!tkhd || !mdia) continue;

      var hdlr = findChild(dv, mdia, 'hdlr');
      if (!hdlr || str4(dv, hdlr.off + hdlr.header + 8) !== 'vide') continue;

      var content = tkhd.off + tkhd.header;
      var version = dv.getUint8(content);
      var matrixRel = content + 4 + (version === 1 ? 32 : 20) + 8 + 8;
      if (matrixRel + 44 > tkhd.off + tkhd.size) continue;

      var a = dv.getInt32(matrixRel) / FIXED_1;
      var b = dv.getInt32(matrixRel + 4) / FIXED_1;
      var angle = angleFromMatrix(a, b);

      // Dimensiones del fotograma codificado, desde stsd (avc1/hvc1/…)
      var codedW = 0, codedH = 0;
      var minf = findChild(dv, mdia, 'minf');
      var stbl = minf && findChild(dv, minf, 'stbl');
      var stsd = stbl && findChild(dv, stbl, 'stsd');
      if (stsd) {
        var entry = stsd.off + stsd.header + 8; // ver/flags + entry_count
        if (entry + 36 <= stsd.off + stsd.size && dv.getUint32(entry) >= 36) {
          codedW = dv.getUint16(entry + 32);
          codedH = dv.getUint16(entry + 34);
        }
      }
      var writeWH = codedW > 0 && codedW < 10000 && codedH > 0 && codedH < 10000;
      if (!writeWH) {
        // Respaldo: parte entera del ancho/alto 16.16 del propio tkhd
        codedW = dv.getUint16(matrixRel + 36);
        codedH = dv.getUint16(matrixRel + 40);
        if (!codedW || !codedH) continue;
      }

      tracks.push({
        angle: angle,
        codedW: codedW,
        codedH: codedH,
        matrixAbs: moov.start + matrixRel,
        writeWH: writeWH
      });
    }

    if (!tracks.length) throw new Error('El archivo no contiene un track de video compatible.');
    return { tracks: tracks, angle: tracks[0].angle };
  }

  /*
   * Construye el archivo girado. deltaCW = grados extra en sentido horario.
   * Es síncrono: solo une trozos del archivo original con los bytes nuevos.
   */
  function buildRotated(file, info, deltaCW) {
    var edits = [];
    for (var i = 0; i < info.tracks.length; i++) {
      var t = info.tracks[i];
      var newAngle = ((t.angle + deltaCW) % 360 + 360) % 360;
      var matrix = matrixBytes(newAngle, t.codedW, t.codedH);
      var bytes;
      if (t.writeWH) {
        bytes = new Uint8Array(44);
        bytes.set(matrix, 0);
        var wh = new DataView(bytes.buffer, 36, 8);
        wh.setUint32(0, (t.codedW * FIXED_1) >>> 0); // ancho natural 16.16
        wh.setUint32(4, (t.codedH * FIXED_1) >>> 0); // alto natural 16.16
      } else {
        bytes = matrix;
      }
      edits.push({ offset: t.matrixAbs, bytes: bytes });
    }
    edits.sort(function (x, y) { return x.offset - y.offset; });

    var parts = [];
    var pos = 0;
    for (var j = 0; j < edits.length; j++) {
      parts.push(file.slice(pos, edits[j].offset), edits[j].bytes);
      pos = edits[j].offset + edits[j].bytes.length;
    }
    parts.push(file.slice(pos));

    var isMov = /\.mov$/i.test(file.name) || file.type === 'video/quicktime';
    var type = isMov ? 'video/quicktime'
      : (file.type && file.type.indexOf('video/') === 0 ? file.type : 'video/mp4');

    var extMatch = /\.[A-Za-z0-9]+$/.exec(file.name || '');
    var ext = extMatch ? extMatch[0] : (isMov ? '.mov' : '.mp4');
    var base = (file.name || 'video').replace(/\.[A-Za-z0-9]+$/, '');
    var name = base + '-girado' + ext;

    return new File(parts, name, { type: type, lastModified: Date.now() });
  }

  // Núcleo accesible para pruebas y depuración
  var core = {
    analyzeVideo: analyzeVideo,
    buildRotated: buildRotated,
    matrixBytes: matrixBytes,
    findTopLevelBox: findTopLevelBox,
    angleFromMatrix: angleFromMatrix
  };
  if (typeof globalThis !== 'undefined') globalThis.RotarCore = core;

  /* ======================== Interfaz ======================== */

  if (typeof document === 'undefined') return;

  var items = [];
  var nextId = 1;

  var $ = function (id) { return document.getElementById(id); };

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function tapsLabel(taps) {
    if (taps === 0) return 'Sin giro · 0°';
    return taps + (taps === 1 ? ' giro · ' : ' giros · ') + (taps * 90) + '°';
  }

  /* taps = giros de 90° en sentido antihorario (como el botón de Fotos).
     Equivalencia en grados horarios para los metadatos: */
  function deltaCWFromTaps(taps) {
    return (360 - (taps * 90) % 360) % 360;
  }

  function rebuildOutput(item) {
    if (!item.info) return;
    try {
      item.outFile = core.buildRotated(item.file, item.info, deltaCWFromTaps(item.taps));
    } catch (e) {
      item.state = 'error';
      item.error = 'No se pudo preparar el video: ' + e.message;
      item.outFile = null;
    }
  }

  function updateCard(item) {
    var el = item.el;
    el.video.style.transform = 'rotate(' + (item.taps * -90) + 'deg)';
    el.chip.textContent = tapsLabel(item.taps);

    var st = el.status;
    st.classList.remove('ok', 'err', 'loading');
    if (item.state === 'loading') {
      st.classList.add('loading');
      st.textContent = '⏳ Analizando el video…';
      el.save.disabled = true;
    } else if (item.state === 'error') {
      st.classList.add('err');
      st.textContent = '⚠️ ' + item.error;
      el.save.disabled = true;
    } else {
      st.classList.add('ok');
      st.textContent = item.taps === 0
        ? '✅ Listo · se guardará sin cambios'
        : '✅ Listo · se guardará girado ' + (item.taps * 90) + '° ⟲';
      el.save.disabled = false;
    }
    updateSaveBar();
  }

  function readyItems() {
    return items.filter(function (it) { return it.state === 'ready' && it.outFile; });
  }

  function updateSaveBar() {
    var ready = readyItems();
    $('saveBar').hidden = items.length === 0;
    $('emptyState').hidden = items.length !== 0;
    $('saveCount').textContent = String(ready.length);
    $('saveAll').disabled = ready.length === 0;
  }

  function shareOrDownload(files) {
    if (navigator.canShare && navigator.share && navigator.canShare({ files: files })) {
      navigator.share({ files: files }).catch(function (err) {
        if (err && err.name !== 'AbortError') {
          alert('No se pudo compartir: ' + err.message + '\nSe descargará el archivo en su lugar.');
          files.forEach(download);
        }
      });
    } else {
      files.forEach(download);
    }
  }

  function download(file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function removeItem(item) {
    var idx = items.indexOf(item);
    if (idx >= 0) items.splice(idx, 1);
    if (item.url) URL.revokeObjectURL(item.url);
    item.card.remove();
    updateSaveBar();
  }

  function createCard(item) {
    var card = document.createElement('article');
    card.className = 'card';
    card.innerHTML =
      '<div class="preview">' +
        '<video muted loop playsinline preload="metadata"></video>' +
        '<span class="play-hint">toca para reproducir</span>' +
        '<button class="remove-overlay act-remove" aria-label="Quitar video">✕</button>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="card-name"></div>' +
        '<div class="card-meta"></div>' +
        '<div class="card-status loading">⏳ Analizando el video…</div>' +
        '<div class="card-controls">' +
          '<button class="btn btn-secondary btn-sm act-rotate">⟲ Girar 90°</button>' +
          '<span class="rot-chip"></span>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-primary btn-sm act-save">Guardar</button>' +
        '</div>' +
      '</div>';

    var video = card.querySelector('video');
    item.url = URL.createObjectURL(item.file);
    video.src = item.url;

    card.querySelector('.card-name').textContent = item.file.name || 'video';
    card.querySelector('.card-meta').textContent = fmtSize(item.file.size);

    video.addEventListener('click', function () {
      if (video.paused) video.play().catch(function () {}); else video.pause();
    });

    card.querySelector('.act-rotate').addEventListener('click', function () {
      item.taps = (item.taps + 1) % 4;
      rebuildOutput(item);
      updateCard(item);
    });

    card.querySelector('.act-save').addEventListener('click', function () {
      if (item.outFile) shareOrDownload([item.outFile]);
    });

    card.querySelector('.act-remove').addEventListener('click', function () {
      removeItem(item);
    });

    item.card = card;
    item.el = {
      video: video,
      chip: card.querySelector('.rot-chip'),
      status: card.querySelector('.card-status'),
      save: card.querySelector('.act-save')
    };
    return card;
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (file) {
      var item = {
        id: nextId++,
        file: file,
        taps: 3,          // 3 giros de 90° antihorarios = 270°, como en Fotos
        state: 'loading',
        info: null,
        error: null,
        outFile: null
      };
      items.push(item);
      $('cards').appendChild(createCard(item));
      updateCard(item);

      core.analyzeVideo(file).then(function (info) {
        item.info = info;
        item.state = 'ready';
        var meta = item.card.querySelector('.card-meta');
        var dims = info.tracks[0].codedW + '×' + info.tracks[0].codedH;
        meta.textContent = fmtSize(file.size) + ' · ' + dims + ' · orientación actual ' + info.angle + '°';
        rebuildOutput(item);
        updateCard(item);
      }).catch(function (err) {
        item.state = 'error';
        item.error = err.message || 'No se pudo leer el archivo.';
        updateCard(item);
      });
    });
    updateSaveBar();
  }

  function init() {
    var input = $('fileInput');
    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = '';
    });

    $('saveAll').addEventListener('click', function () {
      var files = readyItems().map(function (it) { return it.outFile; });
      if (files.length) shareOrDownload(files);
    });

    $('clearAll').addEventListener('click', function () {
      items.slice().forEach(removeItem);
    });

    // Aviso de instalación (solo iPhone/iPad en Safari, fuera de la app instalada)
    var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    if (isIOS && !standalone && !localStorage.getItem('installDismissed')) {
      $('installBanner').hidden = false;
    }
    $('installClose').addEventListener('click', function () {
      $('installBanner').hidden = true;
      try { localStorage.setItem('installDismissed', '1'); } catch (e) {}
    });

    // Service worker para funcionar sin conexión
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }

    updateSaveBar();

    // Gancho para pruebas automatizadas
    window.__rotar = { items: items, addFiles: addFiles };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
