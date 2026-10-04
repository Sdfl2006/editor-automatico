const axios = require('axios');
const sharp = require('sharp');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function descargarImagen(url) {
    const respuesta = await axios({ 
        url, 
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    return Buffer.from(respuesta.data, 'binary');
}

async function extraerUrls(urlPagina) {
    let browser;
    try {
        console.log("-> Levantando navegador invisible para evadir CloudFront...");
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Lee la ruta del Dockerfile
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Previene bloqueos de memoria en contenedores
                '--disable-gpu'
            ]
        });
        
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        await page.goto(urlPagina, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const html = await page.content();
        
        console.log("-> Buscando patrones de resolución en el código...");
        const regexAlta = /https:\/\/[^"']*\?s=2048x2048[^"']*/g;
        const regexBaja = /https:\/\/[^"']*\?s=594x594[^"']*/g;

        const matchAlta = html.match(regexAlta);
        const matchBaja = html.match(regexBaja);

        if (!matchAlta || !matchBaja) {
            throw new Error("CloudFront superado, pero no se encontraron las URLs en el HTML. Revisa el enlace.");
        }

        const urlAlta = matchAlta[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
        const urlBaja = matchBaja[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');

        console.log("-> URL 2048px obtenida y limpiada exitosamente.");
        return { urlAlta, urlBaja };

    } finally {
        if (browser) await browser.close();
    }
}

async function procesarDesdeEnlaceWeb(urlPagina) {
    const { urlAlta, urlBaja } = await extraerUrls(urlPagina);
    
    const bufferAlta = await descargarImagen(urlAlta);
    const bufferBaja = await descargarImagen(urlBaja);

    const metadatosAlta = await sharp(bufferAlta).metadata();
    const { width: ancho, height: alto } = metadatosAlta;
    const esHorizontal = ancho > alto;

    const idAncho = Math.round(ancho * 0.25);
    const idAlto = Math.round(alto * 0.06);
    const idX = 0;
    const idY = alto - idAlto;
    
    const marcaAncho = Math.round(ancho * (esHorizontal ? 0.60 : 0.95)); 
    const marcaAlto = Math.round(alto * (esHorizontal ? 0.35 : 0.22));   
    
    const marcaX = ancho - marcaAncho;
    
    const marcaY = Math.round(alto * (esHorizontal ? 0.45 : 0.58));

    const mascaraSvg = `
        <svg width="${ancho}" height="${alto}">
            <rect x="${idX}" y="${idY}" width="${idAncho}" height="${idAlto}" fill="black" />
            <rect x="${marcaX}" y="${marcaY}" width="${marcaAncho}" height="${marcaAlto}" fill="black" />
        </svg>
    `;

    const capaSuperiorRecortada = await sharp(bufferAlta)
        .composite([{ input: Buffer.from(mascaraSvg), blend: 'dest-out' }])
        .png()
        .toBuffer();

    const capaInferiorEscalada = await sharp(bufferBaja)
        .resize(ancho, alto)
        .toBuffer();

    // Retorna directamente el buffer en formato JPEG
    return await sharp(capaInferiorEscalada)
        .composite([{ input: capaSuperiorRecortada, blend: 'over' }])
        .jpeg({ quality: 95 })
        .toBuffer();
}

module.exports = { procesarDesdeEnlaceWeb };