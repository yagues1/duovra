// Imagen local reproducible para probar importación, recorte y lectura del historial.
export async function landscape(page, type = 'image/png') {
  const data = await page.evaluate((mime) => {
    const canvas = document.createElement('canvas');
    const w = canvas.width = 1280;
    const h = canvas.height = 800;
    const ctx = canvas.getContext('2d');
    let seed = 16383;
    const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    for (const [stop, color] of [[0, '#070f2d'], [0.38, '#1d4d78'], [0.69, '#51799b'], [1, '#11192e']]) sky.addColorStop(stop, color);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    for (const [x, y, radius, color] of [[880, 380, 630, 'rgba(116,206,237,.46)'], [215, 450, 390, 'rgba(216,167,227,.25)']]) {
      const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
      light.addColorStop(0, color);
      light.addColorStop(1, 'transparent');
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, w, h);
    }

    for (let i = 0; i < 450; i++) {
      const [x, y, r] = [random() * w, random() * h * 0.63, random() * 0.92 + 0.25];
      ctx.fillStyle = `rgba(198,226,255,${random() * 0.55 * (1 - y / h) + 0.2})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 34; i++) {
      const y = 144 + i * 2.9;
      const color = ctx.createLinearGradient(50, y, 1160, y + 50);
      color.addColorStop(0, 'transparent');
      color.addColorStop(0.46, `rgba(104,186,167,${(1 - i / 34) * 0.055})`);
      color.addColorStop(0.76, `rgba(104,197,207,${(1 - i / 34) * 0.13})`);
      color.addColorStop(1, 'transparent');
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4 + i / 8;
      ctx.beginPath();
      ctx.moveTo(20, y + 216);
      ctx.bezierCurveTo(360, y + 226, 405, y - 141 - i, 640, y + 16);
      ctx.bezierCurveTo(897, y + 160, 1030, y + 33, 1260, y + 10);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    function mountains(points, light, dark, depth) {
      const gradient = ctx.createLinearGradient(0, 385 + depth, 0, h);
      gradient.addColorStop(0, light);
      gradient.addColorStop(1, dark);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(0, points[0][1]);
      for (let i = 1; i < points.length; i++) {
        const [x1, y1] = points[i - 1];
        const [x2, y2] = points[i];
        for (let x = x1 + 3; x < x2; x += 3) {
          const t = (x - x1) / (x2 - x1);
          ctx.lineTo(x, y1 + (y2 - y1) * t + (random() - 0.5) * 12 * Math.sin(Math.PI * t));
        }
        ctx.lineTo(x2, y2);
      }
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
    }

    mountains([[0, 541], [104, 489], [153, 520], [244, 456], [287, 482], [397, 423], [447, 459], [545, 505], [687, 412],
      [709, 432], [770, 393], [816, 439], [877, 475], [967, 443], [1056, 519], [1172, 486], [1280, 533]], '#385a75', '#162946', 0);
    mountains([[0, 497], [49, 493], [156, 453], [184, 478], [236, 462], [302, 519], [354, 500], [466, 580], [534, 558], [634, 615],
      [774, 555], [845, 594], [948, 524], [1060, 550], [1200, 459], [1280, 479]], '#203450', '#13243a', 80);
    mountains([[0, 540], [97, 578], [151, 562], [241, 615], [393, 630], [514, 665], [631, 628], [760, 680], [922, 596],
      [997, 600], [1058, 560], [1093, 573], [1176, 517], [1225, 505], [1280, 482]], '#152639', '#080e1d', 140);
    mountains([[0, 685], [150, 697], [180, 706], [283, 739], [402, 734], [535, 762], [701, 748], [882, 704], [1006, 688],
      [1120, 612], [1220, 631], [1280, 601]], '#0b162a', '#070c18', 225);

    return canvas.toDataURL(mime, 0.86).split(',')[1];
  }, type);
  return Buffer.from(data, 'base64');
}

export async function oversizedImage(page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4097;
    canvas.height = 100;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(data, 'base64');
}
