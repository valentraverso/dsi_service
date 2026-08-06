import puppeteer from 'puppeteer';

export class CreditechService {
    private baseUrl = "https://loan.creditech.com.ar";

    async getPreapproval(dni: string, gender: "F" | "M", username: string, pass: string): Promise<any> {
        const cleanDni = (dni || "").toString().replace(/\D/g, "");
        console.log(`[dsi_service] [Creditech] 🚀 Iniciando evaluación Puppeteer para DNI ${cleanDni}...`);

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

            // 1. Ingreso a la pantalla de Login ASP.NET
            const loginUrl = `${this.baseUrl}/IndexIframe.aspx`;
            console.log(`[dsi_service] [Creditech] Conectando a portal ASP.NET: ${loginUrl}`);

            await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

            // 2. Esperar campos de formulario txtLogin y txtContrasenia
            await page.waitForSelector('#txtLogin, input[name="txtLogin"]', { visible: true, timeout: 8000 });
            await page.waitForSelector('#txtContrasenia, input[name="txtContrasenia"]', { visible: true, timeout: 8000 });

            await page.type('#txtLogin, input[name="txtLogin"]', username);
            await page.type('#txtContrasenia, input[name="txtContrasenia"]', pass);

            await page.waitForSelector('#btnIngresar, input[name="btnIngresar"]', { visible: true, timeout: 6000 });
            await page.click('#btnIngresar, input[name="btnIngresar"]');

            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});

            const postLoginUrl = page.url();
            console.log(`[dsi_service] [Creditech] URL post-login: ${postLoginUrl}`);

            if (postLoginUrl.includes("Login.aspx") && !postLoginUrl.includes("ReturnUrl")) {
                const errorMsg = await page.evaluate(() => {
                    const el = document.querySelector('.form-control-error, .alert, #lblMensaje');
                    return el ? el.textContent?.trim() : "Credenciales inválidas";
                });
                return { approved: false, msg: errorMsg || "Credenciales de Creditech inválidas." };
            }

            // 3. Navegar a SolicitudAltaPorPasos0.aspx conservando la sesión ASP.NET (S(session_id))
            const sessionBase = postLoginUrl.substring(0, postLoginUrl.lastIndexOf('/') + 1);
            const pasos0Url = `${sessionBase}SolicitudAltaPorPasos0.aspx`;
            console.log(`[dsi_service] [Creditech] Navegando a formulario por pasos: ${pasos0Url}`);

            await page.goto(pasos0Url, { waitUntil: 'domcontentloaded', timeout: 15000 });

            await page.waitForSelector('#intDocumento, input[name*="intDocumento"]', { visible: true, timeout: 8000 });

            // Cargar DNI, Género (2=Masculino, 3=Femenino) y teléfono genérico
            const sexoVal = gender === "F" ? "3" : "2";
            await page.evaluate((dniVal, genderVal) => {
                const docInput = document.getElementById('intDocumento') || document.querySelector('input[name*="intDocumento"]');
                if (docInput) {
                    (docInput as HTMLInputElement).value = dniVal;
                    docInput.dispatchEvent(new Event('input', { bubbles: true }));
                    docInput.dispatchEvent(new Event('change', { bubbles: true }));
                }

                const sexoSelect = document.getElementById('lstSexo') || document.querySelector('select[name*="lstSexo"]');
                if (sexoSelect) {
                    (sexoSelect as HTMLSelectElement).value = genderVal;
                    sexoSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }

                const codArea = document.getElementById('intTelefonoCodigoArea') || document.querySelector('input[name*="intTelefonoCodigoArea"]');
                if (codArea) {
                    (codArea as HTMLInputElement).value = '343';
                    codArea.dispatchEvent(new Event('change', { bubbles: true }));
                }

                const carac = document.getElementById('intTelefonoCaracteristica') || document.querySelector('input[name*="intTelefonoCaracteristica"]');
                if (carac) {
                    (carac as HTMLInputElement).value = '15';
                    carac.dispatchEvent(new Event('change', { bubbles: true }));
                }

                const num = document.getElementById('intTelefonoNumero') || document.querySelector('input[name*="intTelefonoNumero"]');
                if (num) {
                    (num as HTMLInputElement).value = '4123456';
                    num.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, cleanDni, sexoVal);

            await new Promise(r => setTimeout(r, 300));

            // 4. Click en Siguiente en Pasos0
            await page.evaluate(() => {
                const btn = document.getElementById('btnSiguiente') || document.querySelector('input[name*="btnSiguiente"]');
                if (btn) (btn as HTMLElement).click();
            });

            await new Promise(r => setTimeout(r, 1000));

            // Si aparece modal SweetAlert ("¿Desea continuar de todas formas?"), hacer click en Si
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
                const siBtn = buttons.find(b => b.textContent?.trim().toLowerCase() === 'si' || (b as HTMLInputElement).value?.trim().toLowerCase() === 'si');
                if (siBtn) (siBtn as HTMLElement).click();
            });

            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 500));

            console.log(`[dsi_service] [Creditech] URL en Pasos1: ${page.url()}`);

            // 5. Extraer nombre del cliente en Pasos1 si está disponible
            const clientInfo = await page.evaluate(() => {
                const getVal = (id: string) => {
                    const el = document.getElementById(id) || document.querySelector(`input[name*="${id}"]`);
                    return el ? (el as HTMLInputElement).value?.trim() : "";
                };

                const apellido = getVal('txtApellido');
                const nombre = getVal('txtNombre');
                const full = [nombre, apellido].filter(Boolean).join(' ');
                return full || undefined;
            });

            // 6. Click en Siguiente en Pasos1 para obtener el dictamen de evaluación
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
                page.evaluate(() => {
                    const btn = document.querySelector('#btnSiguiente, input[name*="btnSiguiente"], input[value="Siguiente"]');
                    if (btn) (btn as HTMLElement).click();
                })
            ]);

            await new Promise(r => setTimeout(r, 1000));

            let bodyText = await page.evaluate(() => document.body.innerText);
            console.log(`[dsi_service] [Creditech] Respuesta en vivo: ${bodyText.substring(0, 300)}`);

            // Manejo de modal "El cliente posee solicitudes pendientes" (hasta 3 reintentos si persiste)
            let modalAttempts = 0;
            while ((bodyText.toLowerCase().includes("solicitudes pendientes") || bodyText.toLowerCase().includes("posee solicitudes")) && modalAttempts < 3) {
                modalAttempts++;
                console.log(`[dsi_service] [Creditech] ⚠️ Detectado modal 'El cliente posee solicitudes pendientes' (Intento ${modalAttempts}). Cerrando modal y re-enviando Siguiente...`);

                await page.evaluate(() => {
                    const modalBtn = document.getElementById('aModalError') || document.querySelector('#aModalError, .modal-footer a, .modal-footer button');
                    if (modalBtn) {
                        (modalBtn as HTMLElement).click();
                    }
                    if (typeof (window as any).ocultarModalError === 'function') {
                        (window as any).ocultarModalError();
                    }
                });

                await new Promise(r => setTimeout(r, 600));

                await page.evaluate(() => {
                    const btn = document.querySelector('#btnSiguiente, input[name*="btnSiguiente"], input[value="Siguiente"]');
                    if (btn) (btn as HTMLElement).click();
                });

                await new Promise(r => setTimeout(r, 3000));
                bodyText = await page.evaluate(() => document.body.innerText);
                console.log(`[dsi_service] [Creditech] Respuesta tras Aceptar + Siguiente (${modalAttempts}): ${bodyText.substring(0, 300)}`);
            }

            // 7. Parsear resultado (Prioridad 1: Elemento HTML #dcbImporteAprobado)
            const importeDirecto = await page.evaluate(() => {
                const el = document.getElementById('dcbImporteAprobado') || document.querySelector('[id*="dcbImporteAprobado"]');
                if (el) {
                    const rawVal = (el as HTMLInputElement).value || el.innerText || el.textContent || "";
                    return rawVal.trim();
                }
                return null;
            });

            if (importeDirecto) {
                const num = parseFloat(importeDirecto.replace(/\$/g, '').replace(/\./g, '').replace(',', '.'));
                if (!isNaN(num) && num > 0) {
                    console.log(`[dsi_service] [Creditech] Preaprobación APROBADA desde #dcbImporteAprobado: $${num} para DNI ${cleanDni}`);
                    return {
                        approved: true,
                        capitalmax: num,
                        clientName: clientInfo,
                        msg: "Crédito preaprobado disponible."
                    };
                }
            }

            const matchImporteAprobado = bodyText.match(/IMPORTE APROBADO[\s\n:]*\$\s*([\d.]+)/i);
            if (matchImporteAprobado && matchImporteAprobado[1]) {
                const capitalMaximo = parseFloat(matchImporteAprobado[1].replace(/\./g, ''));
                if (capitalMaximo > 0) {
                    console.log(`[dsi_service] [Creditech] Preaprobación APROBADA por regex: $${capitalMaximo} para DNI ${cleanDni}`);
                    return {
                        approved: true,
                        capitalmax: capitalMaximo,
                        clientName: clientInfo,
                        msg: "Crédito preaprobado disponible."
                    };
                }
            }

            const matchMonto = bodyText.match(/(?:monto|disponible|límite|aprobado|capital)\s*(?:de)?[\s\n:]*\$\s*([\d.]+)/i)
                || bodyText.match(/\$\s*([\d.]+)/);

            if (matchMonto && matchMonto[1]) {
                const capitalMaximo = parseFloat(matchMonto[1].replace(/\./g, ''));
                if (capitalMaximo > 0) {
                    console.log(`[dsi_service] [Creditech] Preaprobación APROBADA: $${capitalMaximo} para DNI ${cleanDni}`);
                    return {
                        approved: true,
                        capitalmax: capitalMaximo,
                        clientName: clientInfo,
                        msg: "Crédito preaprobado disponible."
                    };
                }
            }

            if (bodyText.toLowerCase().includes("no cumple") || bodyText.toLowerCase().includes("no califica") || bodyText.toLowerCase().includes("rechazad")) {
                const reasonMatch = bodyText.match(/El cliente no cumple con [^\n.]+/i);
                const reason = reasonMatch ? reasonMatch[0] : "El cliente no cumple con las políticas crediticias.";
                console.log(`[dsi_service] [Creditech] Rechazado para DNI ${cleanDni}: ${reason}`);
                return {
                    approved: false,
                    clientName: clientInfo,
                    msg: reason
                };
            }

            return {
                approved: false,
                clientName: clientInfo,
                msg: "No tiene crédito disponible para financiar."
            };

        } catch (error: any) {
            console.error(`[dsi_service] [Creditech] Error en Puppeteer: ${error.message}`);
            return { approved: false, msg: "Error en la conexión con Creditech." };
        } finally {
            if (browser) await browser.close();
        }
    }
}

export default new CreditechService();
