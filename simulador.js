(() => {
    'use strict';

    // Geometría del prototipo (unidades = mm en vista superior)
    const CENTER = 75;          // posición X del centro de la carrera
    const TRAVEL = 150;         // carrera total en mm
    const PITCH = 2;            // paso de la correa GT2 (mm)
    const RAPID = 6000;         // mm/min asumidos para G0
    const DEFAULT_FEED = 2000;  // mm/min si el G-code no define F
    const MAX_BYTES = 20 * 1024 * 1024;

    const VW = 580, VH = 340, CX = 290, CY = 190;
    const BASE = { x: 20, y: 50, w: 540, h: 280 };
    const ROD_DY = 85, PLATE_H = 95, BLOCK_DX = 62;
    const MOTOR_PX = 490, IDLER_PX = 100;
    const SUPPORT_X = [82, 455];
    const VIEW_LINES = 13;

    const $ = (id) => document.getElementById(id);
    const stage = $('stage'), chart = $('chart');
    const sctx = stage.getContext('2d');
    const cctx = chart.getContext('2d');

    const ui = {
        play: $('btn-play'), reset: $('btn-reset'), scrub: $('scrub'),
        file: $('file'), demo: $('btn-demo'), msg: $('msg'), tip: $('tip'),
        loop: $('opt-loop'), ghost: $('opt-transparent'), limits: $('opt-limits'),
        time: $('hud-time'), x: $('hud-x'), d: $('hud-d'), v: $('hud-v'), line: $('hud-line'),
        gview: $('gcode-view'), drop: $('dropzone'),
        info: {
            name: $('info-name'), dur: $('info-dur'), moves: $('info-moves'),
            range: $('info-range'), amp: $('info-amp'), vmax: $('info-vmax')
        }
    };

    let prog = null;
    let t = 0, speed = 1, playing = false, raf = 0, last = 0;
    let sc = 1, dpr = 1, curX = CENTER, hover = null;
    let chartBase = null, chartBox = null;

    // ---------- G-code ----------

    function parseGcode(text) {
        const lines = text.split(/\r?\n/);
        const T = [0], X = [CENTER], L = [];
        let x = CENTER, tt = 0, feed = DEFAULT_FEED, motion = 1, abs = true, unit = 1;
        let min = x, max = x, vmax = 0;

        const push = (dt, nx, line) => {
            if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(nx)) return;
            vmax = Math.max(vmax, Math.abs(nx - x) / dt);
            tt += dt;
            T.push(tt); X.push(nx); L.push(line);
            x = nx;
            min = Math.min(min, x);
            max = Math.max(max, x);
        };

        for (let i = 0; i < lines.length; i++) {
            const code = lines[i].replace(/\([^)]*\)/g, '').split(';')[0].trim().toUpperCase();
            if (!code || code[0] === '$') continue;

            const gs = [], ms = [], w = {};
            for (const m of code.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
                const v = parseFloat(m[2]);
                if (m[1] === 'G') gs.push(v);
                else if (m[1] === 'M') ms.push(v);
                else w[m[1]] = v;
            }

            for (const g of gs) {
                if (g === 0 || g === 1) motion = g;
                else if (g === 90) abs = true;
                else if (g === 91) abs = false;
                else if (g === 20) unit = 25.4;
                else if (g === 21) unit = 1;
            }
            if (w.F > 0) feed = w.F * unit;

            if (gs.includes(4)) {
                if (w.P >= 0) push(w.P, x, i);
            } else if ('X' in w) {
                const v = w.X * unit;
                const nx = abs ? v : x + v;
                const f = motion === 0 ? RAPID : feed;
                push(Math.abs(nx - x) / (f / 60), nx, i);
            }

            if (ms.includes(2) || ms.includes(30)) break;
        }

        if (!L.length) return null;
        return {
            lines, T: Float64Array.from(T), X: Float64Array.from(X), L: Int32Array.from(L),
            n: L.length, dur: tt, min, max, vmax,
            amp: Math.max(Math.abs(min - CENTER), Math.abs(max - CENTER))
        };
    }

    function sample(time) {
        if (!prog) return { x: CENTER, v: 0, line: -1 };
        const { T, X, L, n } = prog;
        let lo = 0, hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (T[mid] <= time) lo = mid; else hi = mid - 1;
        }
        const dt = T[lo + 1] - T[lo];
        const f = dt > 0 ? Math.min(Math.max((time - T[lo]) / dt, 0), 1) : 0;
        return { x: X[lo] + (X[lo + 1] - X[lo]) * f, v: dt > 0 ? (X[lo + 1] - X[lo]) / dt : 0, line: L[lo] };
    }

    function demoGcode() {
        const dur = 40, step = 0.02;
        const out = ['; G-CODE DEMO SISMA (sismo sintético)', 'G21', 'G90', 'G94', 'G1 X75.0000 F2000'];
        const peak = 60;
        const raw = [];
        for (let k = 0; k <= dur / step; k++) {
            const s = k * step;
            const env = Math.min(s / 4, 1) * Math.exp(-Math.max(s - 8, 0) / 9);
            raw.push(env * (0.6 * Math.sin(2 * Math.PI * 1.3 * s) + 0.3 * Math.sin(2 * Math.PI * 2.9 * s + 1) + 0.2 * Math.sin(2 * Math.PI * 5.1 * s + 2)));
        }
        const m = Math.max(...raw.map(Math.abs));
        let prev = CENTER;
        for (const r of raw) {
            const nx = CENTER + (r / m) * peak;
            const f = Math.max(Math.abs(nx - prev) / step * 60, 1);
            out.push(`G1 X${nx.toFixed(4)} F${f.toFixed(3)}`);
            prev = nx;
        }
        out.push('G1 X75.0000 F2000', 'M2');
        return out.join('\n');
    }

    function loadProgram(text, name) {
        const p = parseGcode(text);
        if (!p) {
            showMsg('El archivo no contiene movimientos en el eje X.');
            return;
        }
        prog = p;
        t = 0;
        hideMsg();
        if (p.min < 0 || p.max > TRAVEL) {
            showMsg(`Atención: el G-code excede la carrera de 0 a ${TRAVEL} mm (${p.min.toFixed(1)} a ${p.max.toFixed(1)}).`);
        }
        ui.info.name.textContent = name;
        ui.info.name.title = name;
        ui.info.dur.textContent = fmtTime(p.dur);
        ui.info.moves.textContent = p.n.toLocaleString('es-AR');
        ui.info.range.textContent = `${p.min.toFixed(1)} a ${p.max.toFixed(1)} mm`;
        ui.info.amp.textContent = `±${p.amp.toFixed(1)} mm`;
        ui.info.vmax.textContent = `${p.vmax.toFixed(0)} mm/s`;
        buildChart();
        render();
        setPlaying(true);
    }

    function readFile(file) {
        if (!file) return;
        if (file.size > MAX_BYTES) {
            showMsg('El archivo es demasiado grande (máx. 20 MB).');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => loadProgram(String(reader.result), file.name);
        reader.onerror = () => showMsg('No se pudo leer el archivo.');
        reader.readAsText(file);
    }

    // ---------- Utilidades ----------

    function fmtTime(s) {
        if (s < 60) return `${s.toFixed(1)} s`;
        const m = Math.floor(s / 60);
        return `${m} min ${(s - m * 60).toFixed(0)} s`;
    }

    function niceStep(v) {
        const p = Math.pow(10, Math.floor(Math.log10(v)));
        return p * ([1, 2, 5, 10].find((m) => m * p >= v) || 10);
    }

    function showMsg(text) { ui.msg.textContent = text; ui.msg.hidden = false; }
    function hideMsg() { ui.msg.hidden = true; }

    function rr(c, x, y, w, h, r) {
        c.beginPath();
        if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
    }

    // ---------- Vista superior ----------

    function getParts(px) {
        const P = [];
        const add = (name, desc, x0, y0, x1, y1) => P.push({ name, desc, r: [x0, y0, x1, y1] });
        add('Mesa vibratoria', `Plataforma donde se fija la maqueta. Se desplaza sobre el eje X dentro de una carrera de ${TRAVEL} mm.`,
            px - PLATE_H, CY - PLATE_H, px + PLATE_H, CY + PLATE_H);
        for (const s of [-1, 1]) for (const b of [-1, 1]) {
            add('Bloque deslizante', 'Soporte con rulemán lineal: guía la mesa sobre la varilla.',
                px + b * BLOCK_DX - 14, CY + s * ROD_DY - 14, px + b * BLOCK_DX + 14, CY + s * ROD_DY + 14);
        }
        if (ui.ghost.checked) add('Sujeción de la correa', 'Pieza bajo la mesa que abraza la correa: la mesa se mueve junto con ella.', px - 15, CY - 8, px + 15, CY + 8);
        add('Polea GT2 del motor', 'Fija al eje del motor: arrastra la correa.', MOTOR_PX - 9, CY - 7, MOTOR_PX + 9, CY + 7);
        add('Polea GT2 loca', 'Gira libre en el extremo opuesto y mantiene la correa tensa.', IDLER_PX - 9, CY - 7, IDLER_PX + 9, CY + 7);
        add('Motor paso a paso NEMA 17', 'Gira la polea siguiendo los pasos que ordena el G-code.', 469, 126, 511, 166);
        add('Soporte del motor', 'Pieza impresa que sostiene el motor.', 462, 166, 518, 182);
        add('Soporte de la polea loca', 'Sostiene el eje de la polea que gira libre.', 82, 150, 118, 182);
        add('Correa GT2', 'Correa dentada abierta bajo la mesa: transforma el giro del motor en movimiento lineal.', IDLER_PX, CY - 4, MOTOR_PX, CY + 4);
        for (const s of [-1, 1]) for (const sx of SUPPORT_X) {
            add('Soporte de varilla', 'Fija los extremos de la varilla guía a la base.', sx - 8, CY + s * ROD_DY - 17, sx + 8, CY + s * ROD_DY + 17);
        }
        for (const s of [-1, 1]) add('Varilla guía', 'Varilla rectificada de 8 mm sobre la que desliza la mesa.', SUPPORT_X[0], CY + s * ROD_DY - 5, SUPPORT_X[1], CY + s * ROD_DY + 5);
        add('Base', 'Tablero rígido donde se montan todos los componentes.', BASE.x, BASE.y, BASE.x + BASE.w, BASE.y + BASE.h);
        return P;
    }

    function drawRuler(c, px) {
        c.save();
        c.strokeStyle = '#4b5964';
        c.fillStyle = '#34414b';
        c.lineWidth = 0.8;
        c.font = '9px "DM Sans", sans-serif';
        c.textAlign = 'center';
        for (let k = 0; k <= TRAVEL; k += 5) {
            const x = CX + k - CENTER;
            const major = k % 25 === 0;
            c.beginPath();
            c.moveTo(x, major ? 14 : 19);
            c.lineTo(x, 24);
            c.stroke();
            if (major) c.fillText(String(k), x, 11);
        }
        c.fillStyle = '#ef7c2d';
        c.beginPath();
        c.moveTo(px - 5, 27);
        c.lineTo(px + 5, 27);
        c.lineTo(px, 38);
        c.closePath();
        c.fill();
        c.restore();
    }

    function drawLimits(c) {
        c.save();
        c.setLineDash([5, 4]);
        c.lineWidth = 1;
        c.font = '9px "DM Sans", sans-serif';
        c.textAlign = 'center';
        const y0 = BASE.y + 4, y1 = BASE.y + BASE.h - 4;
        [[-TRAVEL / 2, 'Límite 0 mm', '#ffb36a'], [0, 'Centro 75 mm', '#9aa3ab'], [TRAVEL / 2, `Límite ${TRAVEL} mm`, '#ffb36a']].forEach(([d, label, col]) => {
            c.strokeStyle = col;
            c.fillStyle = col;
            c.beginPath();
            c.moveTo(CX + d, y0);
            c.lineTo(CX + d, y1);
            c.stroke();
            c.fillText(label, CX + d, y1 - 4);
        });
        c.restore();
    }

    function drawRod(c, y) {
        const g = c.createLinearGradient(0, y - 4, 0, y + 4);
        g.addColorStop(0, '#f7f9fb');
        g.addColorStop(0.45, '#aeb5bb');
        g.addColorStop(1, '#6f767c');
        c.fillStyle = g;
        c.fillRect(SUPPORT_X[0], y - 4, SUPPORT_X[1] - SUPPORT_X[0], 8);
    }

    function drawSupport(c, x, y) {
        c.fillStyle = '#e5322d';
        rr(c, x - 7, y - 16, 14, 32, 2); c.fill();
        c.strokeStyle = '#8f1b18'; c.lineWidth = 1; c.stroke();
        c.fillStyle = '#7a1613';
        for (const dy of [-11, 11]) { c.beginPath(); c.arc(x, y + dy, 1.8, 0, Math.PI * 2); c.fill(); }
        c.fillStyle = '#c9ced3';
        c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
    }

    function drawBelt(c, xmm) {
        c.save();
        c.fillStyle = '#23262a';
        c.fillRect(IDLER_PX, CY - 3, MOTOR_PX - IDLER_PX, 6);
        c.strokeStyle = '#7a8188';
        c.lineWidth = 0.8;
        const phase = ((xmm % PITCH) + PITCH) % PITCH;
        c.beginPath();
        for (let sx = IDLER_PX + phase; sx < MOTOR_PX; sx += PITCH) {
            c.moveTo(sx, CY - 3);
            c.lineTo(sx, CY + 3);
        }
        c.stroke();
        c.restore();
    }

    function drawPulley(c, cx) {
        c.fillStyle = '#e9edf0';
        c.strokeStyle = '#9aa1a8';
        c.lineWidth = 1;
        rr(c, cx - 8, CY - 5, 16, 10, 2); c.fill(); c.stroke();
        c.fillStyle = '#c9ced3';
        c.fillRect(cx - 9, CY - 7, 18, 2);
        c.fillRect(cx - 9, CY + 5, 18, 2);
    }

    function drawMotorAssembly(c) {
        // El eje del motor apunta hacia el frente (eje Y) y la polea queda sobre la línea de la correa
        const g = c.createLinearGradient(469, 0, 511, 0);
        g.addColorStop(0, '#2b2f34');
        g.addColorStop(0.5, '#15181b');
        g.addColorStop(1, '#0b0c0e');
        c.fillStyle = g;
        rr(c, 469, 126, 42, 40, 2); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.1)';
        c.lineWidth = 1;
        c.beginPath();
        for (let ly = 131; ly < 164; ly += 5) { c.moveTo(470, ly); c.lineTo(510, ly); }
        c.stroke();
        c.fillStyle = '#e9edf0';
        c.fillRect(484, 128, 12, 8);
        c.fillStyle = '#e5322d';
        rr(c, 462, 166, 56, 16, 3); c.fill();
        c.strokeStyle = '#8f1b18'; c.stroke();
        c.fillStyle = '#7a1613';
        for (const dx of [-24, 24]) { c.beginPath(); c.arc(MOTOR_PX + dx, 174, 1.8, 0, Math.PI * 2); c.fill(); }
        c.fillStyle = '#9aa1a8';
        c.beginPath(); c.arc(MOTOR_PX, 174, 5, 0, Math.PI * 2); c.fill();
        drawPulley(c, MOTOR_PX);
    }

    function drawLeftEnd(c) {
        c.fillStyle = '#0f1113';
        rr(c, 82, 150, 36, 32, 3); c.fill();
        c.strokeStyle = '#59616a'; c.lineWidth = 1; c.stroke();
        c.fillStyle = '#c9ced3';
        c.beginPath(); c.arc(IDLER_PX, 166, 6, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#0f1113';
        c.beginPath(); c.arc(IDLER_PX, 166, 2.5, 0, Math.PI * 2); c.fill();
        drawPulley(c, IDLER_PX);
    }

    function plateOutline(c, px) {
        const h = PLATE_H, k = 16, x0 = px - h, x1 = px + h, y0 = CY - h, y1 = CY + h;
        c.beginPath();
        c.moveTo(x0 + k, y0); c.lineTo(x1 - k, y0); c.lineTo(x1, y0 + k);
        c.lineTo(x1, y1 - k); c.lineTo(x1 - k, y1); c.lineTo(x0 + k, y1);
        c.lineTo(x0, y1 - k); c.lineTo(x0, y0 + k);
        c.closePath();
    }

    function drawPlate(c, px, ghost) {
        c.save();
        if (ghost) c.globalAlpha = 0.38;
        else { c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 14 * sc; c.shadowOffsetX = 4 * sc; c.shadowOffsetY = 6 * sc; }
        const g = c.createLinearGradient(px - PLATE_H, CY - PLATE_H, px + PLATE_H, CY + PLATE_H);
        g.addColorStop(0, '#22262b');
        g.addColorStop(1, '#0d0f12');
        c.fillStyle = g;
        plateOutline(c, px);
        c.fill();
        c.restore();

        c.save();
        if (ghost) c.globalAlpha = 0.7;
        c.strokeStyle = '#59616a';
        c.lineWidth = 1.2;
        plateOutline(c, px);
        c.stroke();

        c.beginPath();
        for (let gx = -75; gx <= 75; gx += 25) {
            for (let gy = -75; gy <= 75; gy += 25) {
                if (gx === 0 && (gy === 0 || gy === 50)) continue;
                c.moveTo(px + gx + 2.2, CY + gy);
                c.arc(px + gx, CY + gy, 2.2, 0, Math.PI * 2);
            }
        }
        c.fillStyle = '#050607';
        c.fill();
        c.strokeStyle = '#69717a';
        c.lineWidth = 0.7;
        c.stroke();

        for (const gy of [0, 50]) {
            c.beginPath(); c.arc(px, CY + gy, 4.6, 0, Math.PI * 2);
            c.fillStyle = '#9aa1a8'; c.fill();
            c.beginPath(); c.arc(px, CY + gy, 2.2, 0, Math.PI * 2);
            c.fillStyle = '#050607'; c.fill();
        }

        c.strokeStyle = '#ef7c2d';
        c.lineWidth = 1.2;
        c.beginPath();
        c.moveTo(px - 9, CY - 50); c.lineTo(px + 9, CY - 50);
        c.moveTo(px, CY - 59); c.lineTo(px, CY - 41);
        c.stroke();
        c.restore();
    }

    function drawStage(xmm) {
        const c = sctx;
        const ghost = ui.ghost.checked;
        const px = CX + (xmm - CENTER);
        c.setTransform(sc, 0, 0, sc, 0, 0);
        c.fillStyle = '#e3e9ee';
        c.fillRect(0, 0, VW, VH);

        drawRuler(c, px);

        c.save();
        c.shadowColor = 'rgba(0,0,0,0.35)';
        c.shadowBlur = 14 * sc;
        c.shadowOffsetY = 5 * sc;
        c.fillStyle = '#3b4046';
        rr(c, BASE.x, BASE.y, BASE.w, BASE.h, 4); c.fill();
        c.restore();
        c.strokeStyle = '#59616a';
        c.lineWidth = 1;
        rr(c, BASE.x, BASE.y, BASE.w, BASE.h, 4); c.stroke();

        if (ui.limits.checked) drawLimits(c);

        for (const s of [-1, 1]) drawRod(c, CY + s * ROD_DY);
        for (const s of [-1, 1]) for (const sx of SUPPORT_X) drawSupport(c, sx, CY + s * ROD_DY);
        drawBelt(c, xmm);
        drawLeftEnd(c);
        drawMotorAssembly(c);

        // Tuerca y bloques deslizantes (quedan bajo la mesa)
        c.fillStyle = '#1b1e22';
        rr(c, px - 15, CY - 8, 30, 16, 2); c.fill();
        c.strokeStyle = '#59616a'; c.lineWidth = 1; c.stroke();
        c.fillStyle = '#9aa1a8';
        for (const dx of [-8, 8]) { c.beginPath(); c.arc(px + dx, CY, 1.5, 0, Math.PI * 2); c.fill(); }
        for (const s of [-1, 1]) for (const b of [-1, 1]) {
            c.fillStyle = '#e5322d';
            rr(c, px + b * BLOCK_DX - 14, CY + s * ROD_DY - 14, 28, 28, 3); c.fill();
            c.strokeStyle = '#8f1b18'; c.stroke();
        }

        drawPlate(c, px, ghost);

        if (hover) {
            const [x0, y0, x1, y1] = hover.r;
            c.save();
            c.strokeStyle = '#ef7c2d';
            c.lineWidth = 2;
            c.setLineDash([6, 3]);
            c.strokeRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
            c.restore();
        }
    }

    // ---------- Sismograma ----------

    function buildChart() {
        const r = chart.getBoundingClientRect();
        if (!r.width) return;
        dpr = window.devicePixelRatio || 1;
        chart.width = Math.round(r.width * dpr);
        chart.height = Math.round(r.height * dpr);

        const w = r.width, h = r.height;
        chartBox = { l: 48, r: 12, t: 10, b: 22, w, h };
        const pw = w - chartBox.l - chartBox.r, ph = h - chartBox.t - chartBox.b;
        chartBox.pw = pw; chartBox.ph = ph;

        const off = document.createElement('canvas');
        off.width = chart.width; off.height = chart.height;
        const c = off.getContext('2d');
        c.scale(dpr, dpr);
        c.font = '10px "DM Sans", sans-serif';
        c.fillStyle = '#071d2a';
        c.fillRect(0, 0, w, h);

        if (!prog) {
            c.fillStyle = 'rgba(255,255,255,0.6)';
            c.textAlign = 'center';
            c.fillText('Cargá un G-code para ver el sismograma', w / 2, h / 2);
            chartBase = off;
            return;
        }

        const ym = Math.max(prog.amp, 1) * 1.1;
        const ys = (d) => chartBox.t + ph / 2 - (d / ym) * (ph / 2);
        const xs = (s) => chartBox.l + (s / prog.dur) * pw;

        c.lineWidth = 1;
        c.textAlign = 'right';
        const step = niceStep(ym / 2);
        for (let d = -Math.floor(ym / step) * step; d <= ym + 1e-9; d += step) {
            const y = ys(d);
            c.strokeStyle = d === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)';
            c.beginPath(); c.moveTo(chartBox.l, y); c.lineTo(w - chartBox.r, y); c.stroke();
            c.fillStyle = 'rgba(255,255,255,0.65)';
            c.fillText(d.toFixed(step < 1 ? 1 : 0), chartBox.l - 6, y + 3);
        }

        c.textAlign = 'center';
        const ts = niceStep(prog.dur / 6);
        for (let s = 0; s <= prog.dur + 1e-9; s += ts) {
            const x = xs(s);
            c.strokeStyle = 'rgba(255,255,255,0.08)';
            c.beginPath(); c.moveTo(x, chartBox.t); c.lineTo(x, h - chartBox.b); c.stroke();
            c.fillStyle = 'rgba(255,255,255,0.65)';
            c.fillText(`${+s.toFixed(2)} s`, x, h - 7);
        }

        c.strokeStyle = '#ffb36a';
        c.lineWidth = 1;
        c.beginPath();
        for (let i = 0; i <= prog.n; i++) {
            const x = xs(prog.T[i]), y = ys(prog.X[i] - CENTER);
            if (i) c.lineTo(x, y); else c.moveTo(x, y);
        }
        c.stroke();
        chartBase = off;
    }

    function drawChart(time, x) {
        if (!chartBase || !chartBox) return;
        cctx.setTransform(1, 0, 0, 1, 0, 0);
        cctx.drawImage(chartBase, 0, 0);
        if (!prog) return;
        cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const px = chartBox.l + (time / prog.dur) * chartBox.pw;
        const ym = Math.max(prog.amp, 1) * 1.1;
        const py = chartBox.t + chartBox.ph / 2 - ((x - CENTER) / ym) * (chartBox.ph / 2);
        cctx.strokeStyle = '#ef7c2d';
        cctx.lineWidth = 1.5;
        cctx.beginPath(); cctx.moveTo(px, chartBox.t); cctx.lineTo(px, chartBox.h - chartBox.b); cctx.stroke();
        cctx.fillStyle = '#ef7c2d';
        cctx.beginPath(); cctx.arc(px, py, 4, 0, Math.PI * 2); cctx.fill();
    }

    // ---------- G-code en ejecución ----------

    const gRows = [];
    for (let i = 0; i < VIEW_LINES; i++) {
        const row = document.createElement('div');
        row.className = 'gline';
        row.innerHTML = '<span class="n"></span><span class="t"></span>';
        ui.gview.appendChild(row);
        gRows.push(row);
    }
    let gStart = -2, gActive = -2;

    function updateGcodeView(line) {
        const lines = prog ? prog.lines : [];
        const start = Math.max(0, Math.min(lines.length - VIEW_LINES, line - 6));
        if (start === gStart && line === gActive) return;
        gStart = start; gActive = line;
        gRows.forEach((row, k) => {
            const idx = start + k;
            row.children[0].textContent = idx < lines.length ? idx + 1 : '';
            row.children[1].textContent = idx < lines.length ? lines[idx] : '';
            row.classList.toggle('active', idx === line);
        });
    }

    // ---------- Render y reproducción ----------

    function render() {
        const s = sample(t);
        curX = s.x;
        drawStage(s.x);
        drawChart(t, s.x);

        ui.time.textContent = `${t.toFixed(2)} s`;
        ui.x.textContent = `${s.x.toFixed(2)} mm`;
        ui.d.textContent = `${(s.x - CENTER).toFixed(2)} mm`;
        ui.v.textContent = `${s.v >= 0 ? '+' : ''}${s.v.toFixed(1)} mm/s`;
        ui.line.textContent = s.line >= 0 ? String(s.line + 1) : '-';
        ui.scrub.value = prog ? Math.round((t / prog.dur) * 1000) : 0;
        updateGcodeView(s.line);
    }

    function frame(now) {
        if (!playing) return;
        const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
        last = now;
        t += dt * speed;
        if (t >= prog.dur) {
            if (ui.loop.checked) t %= prog.dur;
            else { t = prog.dur; setPlaying(false); }
        }
        render();
        if (playing) raf = requestAnimationFrame(frame);
    }

    function setPlaying(p) {
        if (p && !prog) return;
        playing = p;
        ui.play.textContent = p ? '⏸ Pausar' : '▶ Reproducir';
        cancelAnimationFrame(raf);
        if (p) {
            if (t >= prog.dur) t = 0;
            last = performance.now();
            raf = requestAnimationFrame(frame);
        }
    }

    function seek(time) {
        if (!prog) return;
        t = Math.min(Math.max(time, 0), prog.dur);
        render();
    }

    function resizeStage() {
        const r = stage.getBoundingClientRect();
        if (!r.width) return;
        dpr = window.devicePixelRatio || 1;
        stage.width = Math.round(r.width * dpr);
        stage.height = Math.round(r.height * dpr);
        sc = stage.width / VW;
        render();
    }

    // ---------- Eventos ----------

    ui.play.addEventListener('click', () => setPlaying(!playing));
    ui.reset.addEventListener('click', () => seek(0));
    ui.scrub.addEventListener('input', () => { if (prog) seek((ui.scrub.value / 1000) * prog.dur); });
    ui.demo.addEventListener('click', () => loadProgram(demoGcode(), 'Demo (sismo sintético)'));
    ui.file.addEventListener('change', () => { readFile(ui.file.files[0]); ui.file.value = ''; });
    ui.ghost.addEventListener('change', render);
    ui.limits.addEventListener('change', render);

    document.querySelectorAll('.sim-speed button').forEach((b) => {
        b.addEventListener('click', () => {
            speed = parseFloat(b.dataset.speed);
            document.querySelectorAll('.sim-speed button').forEach((o) => o.classList.toggle('active', o === b));
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !/^(INPUT|BUTTON|LABEL)$/.test(e.target.tagName)) {
            e.preventDefault();
            setPlaying(!playing);
        }
    });

    ['dragenter', 'dragover'].forEach((ev) => ui.drop.addEventListener(ev, (e) => {
        e.preventDefault();
        ui.drop.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((ev) => ui.drop.addEventListener(ev, (e) => {
        e.preventDefault();
        ui.drop.classList.remove('dragging');
    }));
    ui.drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));

    stage.addEventListener('pointermove', (e) => {
        const r = stage.getBoundingClientRect();
        const vx = ((e.clientX - r.left) / r.width) * VW;
        const vy = ((e.clientY - r.top) / r.height) * VH;
        const hit = getParts(CX + (curX - CENTER)).find(({ r: [x0, y0, x1, y1] }) => vx >= x0 && vx <= x1 && vy >= y0 && vy <= y1) || null;
        const changed = (hit && hit.r.join()) !== (hover && hover.r.join());
        hover = hit;
        if (hit) {
            ui.tip.hidden = false;
            ui.tip.innerHTML = '<strong></strong><span></span>';
            ui.tip.children[0].textContent = hit.name;
            ui.tip.children[1].textContent = hit.desc;
            const wrap = ui.tip.parentElement.getBoundingClientRect();
            const left = Math.min(e.clientX - wrap.left + 14, wrap.width - ui.tip.offsetWidth - 6);
            ui.tip.style.left = `${Math.max(left, 6)}px`;
            ui.tip.style.top = `${e.clientY - wrap.top + 14}px`;
        } else {
            ui.tip.hidden = true;
        }
        if (changed && !playing) render();
    });
    stage.addEventListener('pointerleave', () => {
        hover = null;
        ui.tip.hidden = true;
        if (!playing) render();
    });

    let dragging = false;
    const chartSeek = (e) => {
        if (!prog || !chartBox) return;
        const r = chart.getBoundingClientRect();
        seek(((e.clientX - r.left - chartBox.l) / chartBox.pw) * prog.dur);
    };
    chart.addEventListener('pointerdown', (e) => { dragging = true; chart.setPointerCapture(e.pointerId); chartSeek(e); });
    chart.addEventListener('pointermove', (e) => { if (dragging) chartSeek(e); });
    chart.addEventListener('pointerup', () => { dragging = false; });
    chart.addEventListener('pointercancel', () => { dragging = false; });

    new ResizeObserver(resizeStage).observe(stage);
    new ResizeObserver(() => { buildChart(); render(); }).observe(chart);

    resizeStage();
    buildChart();
    render();
})();
