const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const { procesarDesdeEnlaceWeb } = require('./procesador');

const app = express();
app.use(cors());
app.use(express.json());

// 1. CONFIGURACIÓN DE SEGURIDAD (Basic Auth)
// Leemos el usuario y contraseña de las variables de entorno de Docker.
// Si no existen (desarrollo local), usa 'santiago' y 'nuggets2026' por defecto.
const USUARIO = process.env.AUTH_USER || 'santiago';
const PASSWORD = process.env.AUTH_PASS || 'nuggets2026';

app.use(basicAuth({
    users: { [USUARIO]: PASSWORD },
    challenge: true, // Fuerza al navegador a mostrar la ventana de login nativa
    unauthorizedResponse: 'Acceso denegado. Credenciales incorrectas o ausentes.'
}));

// 2. RUTAS PROTEGIDAS
// Al estar debajo de basicAuth, nadie puede ver la web ni usar la API sin login
app.use(express.static('public'));

app.post('/api/procesar', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL requerida' });
    }

    try {
        console.log(`Procesando solicitud para: ${url}`);
        const imagenBuffer = await procesarDesdeEnlaceWeb(url);
        
        res.set('Content-Type', 'image/jpeg');
        res.set('Content-Disposition', 'attachment; filename="imagen_limpia.jpg"');
        res.send(imagenBuffer);
        
    } catch (error) {
        console.error("Error en el pipeline:", error);
        res.status(500).json({ error: 'Fallo al procesar la imagen' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor montado en http://localhost:${PORT}`);
});