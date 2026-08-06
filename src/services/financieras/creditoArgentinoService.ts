import puppeteer from 'puppeteer';

export class CreditoArgentinoService {
    private baseUrl = "https://www.creditoargentino.com.ar";

    async getPreapproval(dni: string, gender: "F" | "M", username: string, pass: string): Promise<any> {
        console.log(`[dsi_service] [Crédito Argentino] 🚀 Iniciando evaluación Puppeteer para DNI ${dni}...`);

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
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            const loginUrl = `${this.baseUrl}/#login`;
            console.log(`[dsi_service] [Crédito Argentino] Conectando a portal: ${loginUrl}`);

            await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 20000 });

            // Esperar o forzar apertura de modal login
            const emailInput = await page.waitForSelector('#email, input[name="email"]', { visible: true, timeout: 8000 }).catch(async () => {
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('a, button, span, div'));
                    const target = btns.find(el => el.textContent?.trim().toUpperCase() === 'INGRESÁ');
                    if (target) (target as HTMLElement).click();
                });
                return await page.waitForSelector('#email, input[name="email"]', { visible: true, timeout: 8000 });
            });

            if (!emailInput) {
                return { approved: false, msg: "No se pudo cargar el formulario de acceso de Crédito Argentino." };
            }

            await page.type('#email, input[name="email"]', username);
            await page.type('#password, input[name="password"]', pass);

            await page.click('#login-button');

            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            // Si hay un formulario de búsqueda de DNI post-login
            const dniInput = await page.$('input[name="NumeroDocumentoCliente"], #NumeroDocumentoCliente, input[placeholder*="DNI"]');
            if (dniInput) {
                await dniInput.type(dni);
                const searchBtn = await page.$('button#btnBuscar, button.btn-buscar, button[type="submit"]');
                if (searchBtn) {
                    await searchBtn.click();
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                }
            }

            const bodyText = await page.evaluate(() => document.body.innerText);

            const matchMonto = bodyText.match(/(?:monto|disponible|límite|aprobado)\s*(?:de)?\s*\$\s*([\d.]+)/i)
                || bodyText.match(/\$\s*([\d.]+)/);

            if (matchMonto && matchMonto[1]) {
                const capitalMaximo = parseFloat(matchMonto[1].replace(/\./g, ''));
                if (capitalMaximo > 0) {
                    console.log(`[dsi_service] [Crédito Argentino] Preaprobación aprobada: $${capitalMaximo} para DNI: ${dni}`);
                    return {
                        approved: true,
                        capitalmax: capitalMaximo,
                    };
                }
            }

            if (bodyText.toLowerCase().includes("no califica") || bodyText.toLowerCase().includes("rechazad") || bodyText.toLowerCase().includes("sin oferta")) {
                return { approved: false, msg: "No tiene crédito disponible para financiar." };
            }

            return { approved: false, msg: "No tiene crédito disponible para financiar." };

        } catch (error: any) {
            console.error(`[dsi_service] [Crédito Argentino] Error en Puppeteer: ${error.message}`);
            return { approved: false, msg: "Error en la conexión con Crédito Argentino." };
        } finally {
            if (browser) await browser.close();
        }
    }
}

export default new CreditoArgentinoService();
