import puppeteer from 'puppeteer';

export class CreditoArgentinoService {
    private baseUrl = "https://www.creditoargentino.com.ar";

    /**
     * Evaluar solicitud o consultar crédito disponible por DNI en Crédito Argentino
     * Flujo Paso 1 (/AutorizacionCredito) -> Paso 2 (/AutorizacionCredito/DatosClienteOferta)
     */
    async getPreapproval(dni: string, gender: "F" | "M", username: string, pass: string, phone?: string): Promise<any> {
        const cleanDni = (dni || "").toString().replace(/\D/g, "");
        console.log(`[dsi_service] [Crédito Argentino] 🚀 Iniciando evaluación Puppeteer para DNI ${cleanDni}...`);

        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--disable-features=HttpsFirstBalancedModeAutoEnable'
                ]
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            // 1. Abrir Modal de Login
            console.log(`[dsi_service] [Crédito Argentino] 1. Conectando a portal e iniciando sesión...`);
            await page.goto(`${this.baseUrl}/#login`, { waitUntil: 'networkidle2', timeout: 25000 });

            await page.evaluate(() => {
                const globalJquery = (window as any).$;
                if (globalJquery && globalJquery('#login').length) {
                    globalJquery('#login').modal('show');
                }
            });

            await page.waitForSelector('#email', { visible: true, timeout: 10000 });
            await page.type('#email', username);
            await page.type('#password', pass);

            // Confirmar reCAPTCHA iframe si está presente
            const frames = page.frames();
            const recaptchaFrame = frames.find(f => f.url().includes('recaptcha/enterprise/anchor'));
            if (recaptchaFrame) {
                const checkbox = await recaptchaFrame.$('#recaptcha-anchor, .recaptcha-checkbox-border');
                if (checkbox) {
                    await checkbox.click();
                    await new Promise(r => setTimeout(r, 2500));
                }
            }

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
                page.click('#login-button')
            ]);

            await new Promise(r => setTimeout(r, 2000));
            console.log(`[dsi_service] [Crédito Argentino] URL post-login: ${page.url()}`);

            // 2. Paso 1: Formulario AutorizacionCredito
            if (!page.url().includes('AutorizacionCredito')) {
                console.log(`[dsi_service] [Crédito Argentino] Navegando a https://comercio.creditoargentino.com.ar/AutorizacionCredito ...`);
                await page.goto('https://comercio.creditoargentino.com.ar/AutorizacionCredito', { waitUntil: 'networkidle2', timeout: 20000 });
            }

            await page.waitForSelector('#NumeroDocumento', { visible: true, timeout: 15000 });

            // Parsear teléfono (CodArea + Número)
            let codArea = "3424";
            let numCelular = "302393";
            const cleanPhone = (phone || "").toString().replace(/\D/g, "");
            if (cleanPhone.length >= 10) {
                codArea = cleanPhone.substring(0, 4);
                numCelular = cleanPhone.substring(4);
            } else if (cleanPhone.length >= 7) {
                codArea = cleanPhone.substring(0, 3);
                numCelular = cleanPhone.substring(3);
            }

            const sexoVal = gender === "F" ? "F" : "M";

            console.log(`[dsi_service] [Crédito Argentino] Completando Paso 1: DNI=${cleanDni}, Sexo=${sexoVal}, Tel=${codArea}-${numCelular}`);

            await page.evaluate((dniVal, sexVal, areaVal, phoneVal) => {
                const setVal = (id: string, val: string) => {
                    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
                    if (el) {
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                };

                setVal('NumeroDocumento', dniVal);
                setVal('TipoSexo', sexVal);
                setVal('CodAreaCelular', areaVal);
                setVal('NumeroCelular', phoneVal);
            }, cleanDni, sexoVal, codArea, numCelular);

            await new Promise(r => setTimeout(r, 1000));

            // 3. Click en Buscar / Siguiente
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
                page.evaluate(() => {
                    const btn = document.getElementById('btnBuscarCliente') || document.getElementById('btnSiguiente');
                    if (btn) btn.click();
                })
            ]);

            await new Promise(r => setTimeout(r, 2000));

            const currentUrl = page.url();
            console.log(`[dsi_service] [Crédito Argentino] URL en Paso 2 / Dictamen: ${currentUrl}`);

            const bodyText = await page.evaluate(() => document.body.innerText);

            // 4. Paso 2: Parsear oferta (Disponible Aprobado) o Rechazo en DatosClienteOferta
            if (currentUrl.includes("Rechazo") || bodyText.toLowerCase().includes("no se pudo procesar") || bodyText.toLowerCase().includes("no califica") || bodyText.toLowerCase().includes("rechazad")) {
                console.log(`[dsi_service] [Crédito Argentino] Solicitud rechazada para DNI ${cleanDni}`);
                return {
                    approved: false,
                    msg: "El cliente no cuenta con crédito disponible para financiar."
                };
            }

            // Buscar el monto en el campo "Disponible aprobado"
            const matchDisponibleAprobado = bodyText.match(/disponible\s*aprobado[\s\n:]*\$\s*([\d.]+)/i)
                || bodyText.match(/(?:disponible|aprobado|monto|capital)\s*(?:de)?[\s\n:]*\$\s*([\d.]+)/i)
                || bodyText.match(/\$\s*([\d.]+)/);

            if (matchDisponibleAprobado && matchDisponibleAprobado[1]) {
                const capitalMaximo = parseFloat(matchDisponibleAprobado[1].replace(/\./g, ''));
                if (capitalMaximo > 0) {
                    console.log(`[dsi_service] [Crédito Argentino] Preaprobación APROBADA: $${capitalMaximo} para DNI ${cleanDni}`);
                    return {
                        approved: true,
                        capitalmax: capitalMaximo,
                        msg: "Crédito preaprobado disponible."
                    };
                }
            }

            return {
                approved: false,
                msg: "No tiene crédito disponible para financiar."
            };

        } catch (error: any) {
            console.error(`[dsi_service] [Crédito Argentino] Error en Puppeteer: ${error.message}`);
            return { approved: false, msg: "Error en la conexión con Crédito Argentino." };
        } finally {
            if (browser) await browser.close();
        }
    }
}

export default new CreditoArgentinoService();
