import puppeteer from 'puppeteer';

export class CreditoDirectoService {
    private baseUrl = "https://minegocio.directo.com.ar";

    async getActionId(): Promise<string | null> {
        console.log("[dsi_service] [Directo] 🔍 Obteniendo Action ID vía HTTP del script chunk...");

        try {
            const res = await fetch(`${this.baseUrl}/login`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });

            if (res.ok) {
                const html = await res.text();
                const scriptMatch = html.match(/src="([^"]*(?:login\/page-[^"]*\.js))"/i)
                    || html.match(/src="([^"]*page-[a-f0-9]+\.js)"/i);

                if (scriptMatch && scriptMatch[1]) {
                    const scriptPath = scriptMatch[1];
                    const scriptUrl = scriptPath.startsWith('http')
                        ? scriptPath
                        : `${this.baseUrl}${scriptPath.startsWith('/') ? '' : '/'}${scriptPath}`;

                    const jsRes = await fetch(scriptUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });

                    if (jsRes.ok) {
                        const jsContent = await jsRes.text();
                        const actionRegex = /createServerReference\)\("([a-f0-9]{40,50})"[^)]*?"login"\)/;
                        const match = jsContent.match(actionRegex);

                        if (match && match[1]) {
                            console.log(`[dsi_service] [Directo] ✅ Nuevo Action ID extraído del chunk: ${match[1]}`);
                            return match[1];
                        }
                    }
                }
            }
            console.warn("[dsi_service] [Directo] ⚠️ No se pudo extraer el Action ID del script chunk.");
        } catch (error: any) {
            console.error(`[dsi_service] [Directo] Error en extractor HTTP de script chunk: ${error.message}`);
        }

        return "7f2939925dc7ec2ceca1c57964f31a968b95f1a377";
    }

    async consultarCredito(numeroCredito: string, customUser?: string, customPass?: string): Promise<{ success: boolean; data?: any; msg?: string }> {
        const username = (customUser || process.env.DIRECTO_ADMIN_USER || "").toLowerCase();
        const pass = customPass || process.env.DIRECTO_ADMIN_PSW || "";

        console.log(`[dsi_service] [Directo] Consultando crédito nro: ${numeroCredito} con usuario: ${username}...`);

        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            await page.goto(`${this.baseUrl}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 });

            await page.focus('input[name="username"]');
            await page.keyboard.type(username, { delay: 30 });

            await page.focus('input[name="password"]');
            await page.keyboard.type(pass, { delay: 30 });

            await page.click('button[type="submit"]');
            await new Promise(r => setTimeout(r, 6000));

            const currentUrl = page.url();
            if (currentUrl.includes('/login')) {
                const bodyText = await page.evaluate(() => document.body.innerText);
                if (bodyText.includes('incorrectos')) {
                    return { success: false, msg: 'Usuario o contraseña incorrectos en portal Crédito Directo.' };
                }
            }

            const targetUrl = `${this.baseUrl}/orders/completed?credit.numeroCredito=${encodeURIComponent(numeroCredito)}`;
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 4000));

            const scraped = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('tr')).map(r => {
                    return Array.from(r.querySelectorAll('td')).map(c => c.innerText.trim());
                }).filter(row => row.length > 0);

                if (rows.length === 0) return null;

                const firstRow = rows[0];
                return {
                    puntoVenta: firstRow[0] || '',
                    tipo: firstRow[1] || '',
                    fecha: firstRow[2] || '',
                    dni: firstRow[3] || '',
                    clienteNombre: firstRow[4] || '',
                    monto: firstRow[5] || '',
                    numeroCredito: firstRow[6] || '',
                    fechaDesembolso: firstRow[7] || '',
                    numeroLiquidacion: firstRow[8] || ''
                };
            });

            if (!scraped || !scraped.numeroCredito) {
                return { success: false, msg: `No se encontró información para el crédito ${numeroCredito}.` };
            }

            console.log(`[dsi_service] [Directo] ✅ Crédito ${numeroCredito} encontrado: ${scraped.clienteNombre} (${scraped.monto})`);

            return {
                success: true,
                data: scraped
            };

        } catch (error: any) {
            console.error(`[dsi_service] [Directo] ❌ Error en consultarCredito: ${error.message}`);
            return { success: false, msg: error.message };
        } finally {
            if (browser) await browser.close();
        }
    }
}

export default new CreditoDirectoService();
