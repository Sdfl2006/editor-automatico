const axios = require('axios');
const sharp = require('sharp');

const DOMINIOS_GETTY = new Set([
    'gettyimages.com', 'gettyimages.es', 'gettyimages.co.uk',
    'gettyimages.ca', 'gettyimages.com.au', 'gettyimages.fr',
    'gettyimages.de', 'gettyimages.it', 'gettyimages.pt',
    'gettyimages.com.mx', 'gettyimages.com.br'
]);
const CDN_GETTY = 'media.gettyimages.com';
const REDIRECCIONES = new Set([301, 302, 303, 307, 308]);

class ErrorProcesamiento extends Error {
    constructor(status, mensaje, opciones) {
        super(mensaje, opciones);
        this.status = status;
    }
}

function esUrlHttps(url) {
    return url.protocol === 'https:' && !url.username && !url.password && !url.port;
}

function esPaginaGetty(url) {
    return esUrlHttps(url) && DOMINIOS_GETTY.has(url.hostname.replace(/^www\./, ''));
}

function esImagenGetty(url) {
    return esUrlHttps(url) && url.hostname === CDN_GETTY;
}

async function obtenerRecurso(url, { validar, accept, tipoRespuesta, limite }) {
    for (let redirecciones = 0; redirecciones <= 3; redirecciones++) {
        let respuesta;
        try {
            respuesta = await axios.get(url.href, {
                headers: { Accept: accept },
                responseType: tipoRespuesta,
                timeout: 12000,
                maxContentLength: limite,
                maxRedirects: 0,
                validateStatus: () => true
            });
        } catch (error) {
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                throw new ErrorProcesamiento(504, 'Getty tardó demasiado en responder.', { cause: error });
            }
            throw new ErrorProcesamiento(502, 'No se pudo conectar con Getty.', { cause: error });
        }

        if (REDIRECCIONES.has(respuesta.status) && respuesta.headers.location) {
            let destino;
            try {
                destino = new URL(respuesta.headers.location, url);
            } catch {
                throw new ErrorProcesamiento(502, 'Getty devolvió una redirección inválida.');
            }
            if (!validar(destino)) {
                throw new ErrorProcesamiento(502, 'Getty redirigió la solicitud fuera del dominio esperado.');
            }
            url = destino;
            continue;
        }
        if (respuesta.status === 401 || respuesta.status === 403 || respuesta.status === 429) {
            throw new ErrorProcesamiento(502, 'Getty rechazó la solicitud (HTTP ' + respuesta.status + ').');
        }
        if (respuesta.status !== 200) {
            throw new ErrorProcesamiento(502, 'Getty devolvió HTTP ' + respuesta.status + '.');
        }
        return respuesta;
    }
    throw new ErrorProcesamiento(502, 'Getty devolvió demasiadas redirecciones.');
}

function extraerUrls(html, id) {
    const contenido = html.replace(/\\\//g, '/')
        .replace(/\\u0026|&amp;|&#38;|&#x26;/gi, '&');
    const urls = new Map();
    const candidatos = contenido.matchAll(/https:\/\/media\.gettyimages\.com\/id\/[^\s"'<>\\]+/gi);
    for (const [candidato] of candidatos) {
        const url = new URL(candidato);
        if (url.pathname.split('/')[2] !== id) continue;
        const tamano = url.searchParams.get('s');
        if (!urls.has(tamano)) urls.set(tamano, url);
    }
    const alta = urls.get('2048x2048');
    const baja = urls.get('594x594');
    if (!alta || !baja) {
        const faltantes = [!alta && '2048 px', !baja && '594 px'].filter(Boolean).join(' y ');
        throw new ErrorProcesamiento(422, 'La respuesta de Getty no incluye la variante de ' + faltantes + ' para esta imagen.');
    }
    return [alta, baja];
}

async function descargarImagen(url) {
    const { data, headers } = await obtenerRecurso(url, {
        validar: esImagenGetty,
        accept: 'image/*',
        tipoRespuesta: 'arraybuffer',
        limite: 16 * 1024 * 1024
    });
    if (!headers['content-type']?.startsWith('image/')) {
        throw new ErrorProcesamiento(502, 'Getty devolvió un archivo que no es una imagen.');
    }
    return Buffer.from(data);
}

async function prepararParche(capa, region, ancho, alto, transicion) {
    const left = Math.max(0, region.x - transicion);
    const top = Math.max(0, region.y - transicion);
    const width = Math.min(ancho, region.x + region.ancho + transicion) - left;
    const height = Math.min(alto, region.y + region.alto + transicion) - top;
    const mascara = Buffer.alloc(width * height * 4, 255);

    for (let y = 0; y < height; y++) {
        const dy = Math.max(region.y - top - y, top + y - (region.y + region.alto - 1), 0);
        for (let x = 0; x < width; x++) {
            const dx = Math.max(region.x - left - x, left + x - (region.x + region.ancho - 1), 0);
            const t = Math.min(1, Math.hypot(dx, dy) / transicion);
            const opacidad = 1 - t * t * (3 - 2 * t);
            mascara[(y * width + x) * 4 + 3] = Math.round(opacidad * 255);
        }
    }
    const recorte = await sharp(capa).extract({ left, top, width, height }).png().toBuffer();
    const input = await sharp(recorte)
        .ensureAlpha()
        .composite([{ input: mascara, raw: { width, height, channels: 4 }, blend: 'dest-in' }])
        .png()
        .toBuffer();
    return { input, left, top };
}

async function componerImagen(bufferAlta, bufferBaja) {
    const alta = sharp(bufferAlta);
    const { width: ancho, height: alto } = await alta.metadata();
    const horizontal = ancho > alto;
    const idAlto = Math.max(1, Math.round(alto * 0.06));
    const marcaAncho = Math.max(1, Math.round(ancho * (horizontal ? 0.60 : 0.95)));
    const regiones = [
        { x: 0, y: alto - idAlto, ancho: Math.max(1, Math.round(ancho * 0.25)), alto: idAlto },
        {
            x: ancho - marcaAncho,
            y: Math.round(alto * (horizontal ? 0.45 : 0.58)),
            ancho: marcaAncho,
            alto: Math.max(1, Math.round(alto * (horizontal ? 0.35 : 0.22)))
        }
    ];

    const capaEscalada = await sharp(bufferBaja)
        .resize(ancho, alto)
        .sharpen({ sigma: 1.1, m1: 0.2, m2: 1.4 })
        .png()
        .toBuffer();
    const transicion = Math.max(2, Math.round(Math.min(ancho, alto) * (horizontal ? 0.018 : 0.013)));
    const parches = await Promise.all(regiones.map(region =>
        prepararParche(capaEscalada, region, ancho, alto, transicion)
    ));

    return alta.composite(parches).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function procesarDesdeEnlaceWeb(enlace) {
    let url;
    try {
        if (typeof enlace === 'string') url = new URL(enlace.trim());
    } catch {
        throw new ErrorProcesamiento(400, 'Pega el enlace completo a la página de una imagen de Getty.');
    }
    const id = url?.pathname.match(/\/(\d+)\/?$/)?.[1];
    if (!url || !esPaginaGetty(url) || !url.pathname.startsWith('/detail/') || !id) {
        throw new ErrorProcesamiento(400, 'Pega el enlace completo a la página de una imagen de Getty.');
    }
    const { data: html, headers } = await obtenerRecurso(url, {
        validar: esPaginaGetty,
        accept: 'text/html',
        tipoRespuesta: 'text',
        limite: 8 * 1024 * 1024
    });
    if (!headers['content-type']?.startsWith('text/html')) {
        throw new ErrorProcesamiento(502, 'Getty devolvió una respuesta distinta a la página de la imagen.');
    }
    const urls = extraerUrls(html, id);
    const [alta, baja] = await Promise.all(urls.map(descargarImagen));
    return componerImagen(alta, baja);
}

module.exports = { ErrorProcesamiento, procesarDesdeEnlaceWeb };
