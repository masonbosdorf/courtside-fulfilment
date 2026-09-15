/* pick-slip.js — renders a saved wave (the decrypted slips payload from pick-lib buildWave /
   recheck) into ONE PDF: one A4 page per order, plus continuation pages only when an order's
   route is longer than a page. Browser only.

   Needs, loaded first:  jsPDF 2.5.1 (window.jspdf) · JsBarcode 3.11.6 · optional pick-logo.js (window.PICK_LOGO)
   Thumbnails: the Stock Finder image bank, same filename rule as its tools/build_thumbs.py.

     const doc = await PickSlip.render(slips, { thumbBase, printedAt });
     doc.save(PickSlip.fileName(slips));

   Layout (mm, A4 portrait): header · order no + type badge + Code 128 · NetSuite SO / date /
   method / units · zone (+ "continues to") · SHIP TO | BILL TO · note (only if the customer left
   one) · route table in walk order (stop · thumb · BIN + backup · SKU/description · SIZE · QTY · tick)
   · footer with picked-by / packed-by lines. Black on white — nothing that burns toner. */
(function (root) {
  'use strict';

  const TZ = 'Australia/Melbourne';
  const PAGE = { L: 12, R: 198 };
  const ROW_H = 26, HEAD_H = 7, BOTTOM = 272;
  const TABLE_Y = 106;                       // first-page table top when there is no note
  const CONT_TABLE_Y = 32;                   // continuation-page table top
  const INK = 17, MID = 105, FAINT = 160, RULE = 205, FILL = 243;
  const COL = { n: 12, img: 20, bin: 47, sku: 90, size: 158, qty: 176, tick: 190 };
  const DEFAULT_THUMBS = 'https://masonbosdorf.github.io/courtside-stock-finder/img/';

  // ---------------------------------------------------------------- small helpers

  const pad2 = n => String(n).padStart(2, '0');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const thumbFile = parent => String(parent).replace(/[^A-Za-z0-9._-]/g, '_') + '.webp';
  const typeLabel = t => (t === 'express' ? 'Express' : t === 'pickup' ? 'Store pickup' : 'Standard');

  // jsPDF's built-in Helvetica is WinAnsi: keep Latin-1, line breaks and the common typographic
  // marks; drop emoji outright; collapse any other run of unprintable characters to one '?'
  const clean = s => String(s == null ? '' : s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[^\n -ÿ–—‘’“”…•€]+/g, '?')
    .replace(/[ \t]+$/gm, '');

  const when = iso => {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric',
      month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  };
  const stamp = d => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(',', '');

  function font(doc, size, style) { doc.setFont('helvetica', style || 'normal'); doc.setFontSize(size); }

  function txt(doc, s, x, y, size, style, gray, opts) {
    font(doc, size, style);
    doc.setTextColor(gray == null ? INK : gray);
    doc.text(Array.isArray(s) ? s.map(clean) : clean(s), x, y, opts || {});
  }

  function rule(doc, y, width, gray, x1, x2) {
    doc.setDrawColor(gray); doc.setLineWidth(width);
    doc.line(x1 == null ? PAGE.L : x1, y, x2 == null ? PAGE.R : x2, y);
  }

  // truncate to width with an ellipsis (names, address lines, descriptions)
  function fit(doc, s, maxW, size, style) {
    font(doc, size, style);
    s = clean(s);
    if (doc.getTextWidth(s) <= maxW) return s;
    while (s.length > 1 && doc.getTextWidth(s + '…') > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  // shrink the font until it fits — for things that must never be truncated (bins, sizes)
  function shrink(doc, s, maxW, size, style, min) {
    for (let z = size; z >= (min || 8); z -= 0.5) {
      font(doc, z, style);
      if (doc.getTextWidth(clean(s)) <= maxW) return z;
    }
    return min || 8;
  }

  function tag(doc, label, x, y) {
    font(doc, 6.5, 'bold');
    const w = doc.getTextWidth(label) + 3;
    doc.setFillColor(INK); doc.roundedRect(x, y, w, 4.2, 0.8, 0.8, 'F');
    txt(doc, label, x + 1.5, y + 3.05, 6.5, 'bold', 255);
  }

  function loadImage(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'), s = 240;
          c.width = s; c.height = s;
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
          const k = Math.min(s / img.naturalWidth, s / img.naturalHeight);
          const w = img.naturalWidth * k, h = img.naturalHeight * k;
          g.drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function barcode(text) {
    const c = document.createElement('canvas');
    root.JsBarcode(c, String(text), { format: 'CODE128', displayValue: false, margin: 0, height: 90, width: 3 });
    return { url: c.toDataURL('image/png'), ratio: c.width / c.height };
  }

  // ---------------------------------------------------------------- blocks

  function noteLines(doc, o) {
    const parts = [];
    if (o.note) parts.push('Note: ' + o.note);
    for (const [k, v] of o.attrs || []) parts.push(k + ': ' + v);
    if (!parts.length) return [];
    font(doc, 9, 'normal');
    return doc.splitTextToSize(clean(parts.join('\n')), PAGE.R - PAGE.L - 8).slice(0, 5);
  }
  const noteHeight = n => (n ? 7 + n * 4.2 + 4 : 0);

  function pageCount(doc, o) {
    const tableTop = TABLE_Y + noteHeight(noteLines(doc, o).length) + HEAD_H;
    const first = Math.max(1, Math.floor((BOTTOM - tableTop) / ROW_H));
    const more = Math.floor((BOTTOM - CONT_TABLE_Y - HEAD_H) / ROW_H);
    const rest = o.stops.length - first;
    return rest <= 0 ? 1 : 1 + Math.ceil(rest / more);
  }

  function header(doc, slips, o) {
    let tx = PAGE.L;
    if (root.PICK_LOGO) { doc.addImage(root.PICK_LOGO, 'PNG', PAGE.L, 11, 11, 11); tx += 14; }
    txt(doc, 'CourtSide', tx, 16.3, 12, 'bold', INK);
    txt(doc, 'ONLINE ORDER PICK SLIP', tx, 21, 6.5, 'bold', MID, { charSpace: 0.6 });
    txt(doc, slips.id, PAGE.R, 16.5, 15, 'bold', INK, { align: 'right' });
    txt(doc, `${pad2(o.seq)} / ${pad2(slips.count)}   ·   ${slips.zoneLabel || slips.zone || ''}`,
      PAGE.R, 22, 8.5, 'normal', MID, { align: 'right' });
    rule(doc, 26, 0.6, INK);
  }

  function badge(doc, type, x, y) {
    const label = type === 'express' ? 'EXPRESS' : type === 'pickup' ? 'PICKUP' : 'STANDARD';
    font(doc, 10, 'bold');
    const w = doc.getTextWidth(label) + 6, h = 8;
    if (type === 'express') {
      doc.setFillColor(INK); doc.roundedRect(x, y, w, h, 1.2, 1.2, 'F');
      txt(doc, label, x + 3, y + 5.6, 10, 'bold', 255);
    } else {
      doc.setDrawColor(type === 'pickup' ? INK : FAINT);
      doc.setLineWidth(type === 'pickup' ? 0.8 : 0.3);
      doc.roundedRect(x, y, w, h, 1.2, 1.2, 'S');
      txt(doc, label, x + 3, y + 5.6, 10, 'bold', type === 'pickup' ? INK : MID);
    }
  }

  function orderBlock(doc, o) {
    const no = '#' + o.no;
    txt(doc, no, PAGE.L, 42, 30, 'bold', INK);
    font(doc, 30, 'bold');
    badge(doc, o.type, PAGE.L + doc.getTextWidth(no) + 4, 34.5);

    const bc = barcode(o.no), bh = 14, bw = Math.min(60, bh * bc.ratio);
    doc.addImage(bc.url, 'PNG', PAGE.R - bw, 30.5, bw, bh);
    txt(doc, o.no, PAGE.R - bw / 2, 48.5, 7, 'normal', MID, { align: 'center', charSpace: 1.2 });

    const bits = [o.so ? 'NetSuite ' + o.so : 'NOT IN NETSUITE', 'Ordered ' + when(o.at),
      o.method || typeLabel(o.type), plural(o.units, 'unit')];
    txt(doc, fit(doc, bits.join('   ·   '), PAGE.R - PAGE.L - 64, 9, 'normal'), PAGE.L, 50, 9, 'normal', MID);

    const labels = [];
    for (const s of o.stops) if (!labels.includes(s.zoneLabel)) labels.push(s.zoneLabel);
    txt(doc, 'ZONE  ' + (labels[0] || ''), PAGE.L, 57.5, 9, 'bold', INK, { charSpace: 0.3 });
    if (labels.length > 1) {
      font(doc, 9, 'bold');
      const w = doc.getTextWidth('ZONE  ' + labels[0]) + labels[0].length * 0.3 + 4;
      tag(doc, 'CONTINUES TO ' + labels.slice(1).join(', ').toUpperCase(), PAGE.L + w, 54.4);
    }
  }

  function addressBox(doc, label, a, x, y, w, h) {
    doc.setDrawColor(RULE); doc.setLineWidth(0.3); doc.roundedRect(x, y, w, h, 1.5, 1.5, 'S');
    txt(doc, label, x + 4, y + 6, 6.5, 'bold', MID, { charSpace: 0.6 });
    if (a && a.pickup) {
      txt(doc, 'STORE PICKUP', x + 4, y + 15, 13, 'bold', INK);
      txt(doc, 'Customer collects in store', x + 4, y + 21, 9, 'normal', MID);
      return;
    }
    if (!a || !(a.name || a.a1)) { txt(doc, '—', x + 4, y + 14, 11, 'normal', FAINT); return; }
    let yy = y + 13;
    txt(doc, fit(doc, a.name, w - 8, 11, 'bold'), x + 4, yy, 11, 'bold', INK);
    yy += 5.2;
    const lines = [a.company, a.a1, a.a2, [a.city, a.state, a.zip].filter(Boolean).join(' '),
      a.country && a.country !== 'AU' ? a.country : ''].filter(Boolean).slice(0, 4);
    for (const l of lines) { txt(doc, fit(doc, l, w - 8, 9.5, 'normal'), x + 4, yy, 9.5, 'normal', INK); yy += 4.6; }
    if (a.phone) txt(doc, fit(doc, a.phone, w - 8, 8.5, 'normal'), x + 4, y + h - 3.5, 8.5, 'normal', MID);
  }

  function addresses(doc, o) {
    const y = 62, h = 40, w = (PAGE.R - PAGE.L - 6) / 2;
    const ship = o.type === 'pickup' && !(o.shipTo && o.shipTo.a1) ? { pickup: true } : o.shipTo;
    addressBox(doc, 'SHIP TO', ship, PAGE.L, y, w, h);
    addressBox(doc, 'BILL TO', o.billTo, PAGE.L + w + 6, y, w, h);
    return y + h + 4;
  }

  function note(doc, o, y) {
    const lines = noteLines(doc, o);
    if (!lines.length) return y;
    const h = 7 + lines.length * 4.2;
    doc.setFillColor(FILL); doc.roundedRect(PAGE.L, y, PAGE.R - PAGE.L, h, 1.5, 1.5, 'F');
    txt(doc, lines, PAGE.L + 4, y + 5.6, 9, 'normal', INK, { lineHeightFactor: 1.45 });
    return y + noteHeight(lines.length);
  }

  function tableHead(doc, y) {
    doc.setFillColor(INK); doc.rect(PAGE.L, y, PAGE.R - PAGE.L, HEAD_H, 'F');
    const t = (s, x, o) => txt(doc, s, x, y + 4.7, 6.5, 'bold', 255, Object.assign({ charSpace: 0.5 }, o || {}));
    t('#', COL.n + 2.5, { align: 'center' });
    t('ITEM', COL.img + 1);
    t('BIN', COL.bin);
    t('SKU · DESCRIPTION', COL.sku);
    t('SIZE', (COL.size + COL.qty) / 2, { align: 'center' });
    t('QTY', (COL.qty + COL.tick) / 2, { align: 'center' });
    t('PICK', COL.tick + 3.8, { align: 'center' });
    return y + HEAD_H;
  }

  function row(doc, s, i, y, img) {
    const mid = y + ROW_H / 2;
    txt(doc, String(i + 1), COL.n + 2.5, mid + 2, 12, 'bold', FAINT, { align: 'center' });

    const box = 23, bx = COL.img, by = y + (ROW_H - box) / 2;
    if (img) {
      doc.addImage(img, 'JPEG', bx, by, box, box);
    } else {
      doc.setFillColor(FILL); doc.rect(bx, by, box, box, 'F');
      txt(doc, 'NO IMAGE', bx + box / 2, by + box / 2 + 1, 6, 'bold', FAINT, { align: 'center' });
    }

    const binW = COL.sku - COL.bin - 3;
    const bz = shrink(doc, s.bin, binW, 15, 'bold', 9);
    txt(doc, s.bin, COL.bin, y + 10.5, bz, 'bold', INK);
    let ty = y + 15.5;
    if (s.backup) { txt(doc, fit(doc, 'backup  ' + s.backup, binW, 7.5, 'normal'), COL.bin, ty, 7.5, 'normal', MID); ty += 2; }
    if (s.lastResort) { tag(doc, 'SALES FLOOR BIN', COL.bin, ty); ty += 5.2; }
    if (s.check) tag(doc, 'CHECK BIN — STOCK MOVED', COL.bin, ty);

    const skuW = COL.size - COL.sku - 4;
    txt(doc, fit(doc, s.sku, skuW, 10, 'bold'), COL.sku, y + 9, 10, 'bold', INK);
    font(doc, 8.5, 'normal');
    let desc = doc.splitTextToSize(clean(s.desc || ''), skuW);
    if (desc.length > 3) { desc = desc.slice(0, 3); desc[2] = fit(doc, desc[2] + '…', skuW, 8.5, 'normal'); }
    txt(doc, desc, COL.sku, y + 14, 8.5, 'normal', MID, { lineHeightFactor: 1.3 });

    const sx = (COL.size + COL.qty) / 2, sz = shrink(doc, s.size || '—', COL.qty - COL.size - 2, 15, 'bold', 8);
    txt(doc, s.size || '—', sx, mid + 2.4, sz, 'bold', INK, { align: 'center' });

    const qx = (COL.qty + COL.tick) / 2;
    txt(doc, String(s.qty), qx, mid + 2.6, 16, 'bold', INK, { align: 'center' });
    if (s.qty > 1) { doc.setDrawColor(INK); doc.setLineWidth(0.7); doc.circle(qx, mid + 0.4, 4.6, 'S'); }

    doc.setDrawColor(INK); doc.setLineWidth(0.5); doc.rect(COL.tick + 1, mid - 3.5, 7, 7, 'S');
    rule(doc, y + ROW_H, 0.2, RULE);
    return y + ROW_H;
  }

  function continued(doc, slips, o, page, pages) {
    txt(doc, '#' + o.no + '  continued', PAGE.L, 20, 16, 'bold', INK);
    txt(doc, `${slips.id}   ·   ${pad2(o.seq)} / ${pad2(slips.count)}   ·   page ${page} of ${pages}`,
      PAGE.R, 20, 8.5, 'normal', MID, { align: 'right' });
    rule(doc, 26, 0.6, INK);
    return CONT_TABLE_Y;
  }

  function footer(doc, slips, o, page, pages, printed) {
    rule(doc, 275, 0.4, INK);
    txt(doc, 'PICKED BY', PAGE.L, 283, 6.5, 'bold', MID, { charSpace: 0.5 });
    rule(doc, 283.6, 0.3, MID, PAGE.L + 17, PAGE.L + 60);
    txt(doc, 'PACKED BY', PAGE.L + 66, 283, 6.5, 'bold', MID, { charSpace: 0.5 });
    rule(doc, 283.6, 0.3, MID, PAGE.L + 83, PAGE.L + 126);
    txt(doc, `${plural(o.stops.length, 'stop')}   ·   ${plural(o.units, 'unit')}`, PAGE.R, 283, 9, 'bold', INK, { align: 'right' });
    txt(doc, '#' + o.no, PAGE.L, 290, 6.5, 'bold', FAINT);
    txt(doc, `${slips.id}  ·  slip ${o.seq} of ${slips.count}  ·  page ${page} of ${pages}  ·  printed ${printed}`,
      PAGE.R, 290, 6.5, 'normal', FAINT, { align: 'right' });
  }

  // ---------------------------------------------------------------- public

  async function render(slips, opts) {
    opts = opts || {};
    const { jsPDF } = root.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    doc.setProperties({ title: fileName(slips).replace(/\.pdf$/, ''), creator: 'CourtSide Pick Waves' });
    const base = opts.thumbBase || DEFAULT_THUMBS;
    const printed = stamp(opts.printedAt ? new Date(opts.printedAt) : new Date());

    const parents = [...new Set(slips.orders.flatMap(o => o.stops.map(s => s.parent)).filter(Boolean))];
    const thumbs = new Map(await Promise.all(parents.map(async p => [p, await loadImage(base + thumbFile(p))])));

    slips.orders.forEach((o, n) => {
      if (n) doc.addPage();
      const pages = pageCount(doc, o);
      let page = 1;
      header(doc, slips, o);
      orderBlock(doc, o);
      let y = note(doc, o, addresses(doc, o));
      y = tableHead(doc, y);
      o.stops.forEach((s, i) => {
        if (y + ROW_H > BOTTOM) {
          footer(doc, slips, o, page, pages, printed);
          doc.addPage(); page++;
          y = tableHead(doc, continued(doc, slips, o, page, pages));
        }
        y = row(doc, s, i, y, thumbs.get(s.parent));
      });
      footer(doc, slips, o, page, pages, printed);
    });
    return doc;
  }

  function fileName(slips) {
    const z = String(slips.zoneLabel || slips.zone || '').replace(/[\\/:*?"<>|]/g, '-');
    return `${slips.id} · ${z} · ${plural(slips.count, 'order')}.pdf`;
  }

  root.PickSlip = { render, fileName, thumbFile, pageCount };
})(typeof self !== 'undefined' ? self : this);
