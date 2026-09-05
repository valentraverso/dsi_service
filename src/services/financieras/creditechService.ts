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

    /**
     * Consultar y validar crédito en portal anterior de Creditech (Loan ASP.NET)
     * Navega a ClienteBusqueda.aspx, ingresa DNI o número de préstamo en #intDocumento,
     * dispara btnBusquedaPorAtributos, extrae los datos de la grilla de solicitudes y valida DNI, monto y estado.
     */
    async consultarCredito(loan_number?: string, dni?: string, amount?: string, customUser?: string, customPass?: string): Promise<{ approved: boolean; customer?: string; amount?: number; msg?: string; raw?: any }> {
        const username = customUser || process.env.CREDITECH_LEGACY_ADMIN_USER || "3006";
        const pass = customPass || process.env.CREDITECH_LEGACY_ADMIN_PSW || "abcd1234";

        const cleanDni = dni ? dni.toString().replace(/\D/g, "") : "";
        const cleanLoan = loan_number ? loan_number.toString().trim() : "";
        const searchValue = cleanDni || cleanLoan;

        if (!searchValue) {
            return { approved: false, msg: "Se requiere DNI o número de crédito para consultar en Creditech Legacy." };
        }

        console.log(`[dsi_service] [Creditech Legacy] 🔍 Iniciando consulta [DNI: ${cleanDni}, Préstamo: ${cleanLoan}, Monto: ${amount}] con usuario ${username}...`);

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

            // 1. Login en IndexIframe.aspx
            const loginUrl = `${this.baseUrl}/IndexIframe.aspx`;
            await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

            if (await page.$('#txtLogin')) {
                await page.waitForSelector('#txtLogin', { visible: true, timeout: 8000 });
                await page.type('#txtLogin', username);
                await page.type('#txtContrasenia', pass);
                await page.click('#btnIngresar');
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }

            const postLoginUrl = page.url();
            if (postLoginUrl.includes("Login.aspx") && !postLoginUrl.includes("ReturnUrl")) {
                const errorMsg = await page.evaluate(() => {
                    const el = document.querySelector('.form-control-error, .alert, #lblMensaje');
                    return el ? el.textContent?.trim() : "Credenciales inválidas";
                });
                return { approved: false, msg: errorMsg || "Credenciales de Creditech Legacy inválidas." };
            }

            const sessionBase = postLoginUrl.substring(0, postLoginUrl.lastIndexOf('/') + 1);
            const busquedaUrl = `${sessionBase}ClienteBusqueda.aspx`;
            console.log(`[dsi_service] [Creditech Legacy] Navegando a: ${busquedaUrl}`);

            await page.goto(busquedaUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForSelector('#intDocumento, input[name*="intDocumento"]', { visible: true, timeout: 10000 });

            // 2. Ingresar el DNI o número de préstamo en #intDocumento
            await page.focus('#intDocumento, input[name*="intDocumento"]');
            await page.type('#intDocumento, input[name*="intDocumento"]', searchValue, { delay: 30 });

            // 3. Disparar btnBusquedaPorAtributos
            console.log(`[dsi_service] [Creditech Legacy] Ejecutando búsqueda por atributos para ${searchValue}...`);
            await page.evaluate(() => {
                const btnAttr = document.getElementById('btnBusquedaPorAtributos') || document.querySelector('[id*="btnBusquedaPorAtributos"]');
                if (btnAttr) {
                    btnAttr.onclick = null;
                    btnAttr.click();
                } else if (typeof (window as any).__doPostBack === 'function') {
                    (window as any).__doPostBack('ctl00$Body$btnBusquedaPorAtributos', '');
                }
            });

            await new Promise(r => setTimeout(r, 4000));

            // Si no disparó navegación ni postback por click, probar submit del campo o Tab
            const initialNombre = await page.evaluate(() => {
                const el = document.getElementById('txtNombreCliente') as HTMLInputElement;
                return el ? el.value?.trim() : "";
            });

            if (!initialNombre) {
                await page.focus('#intDocumento, input[name*="intDocumento"]');
                await page.keyboard.press('Tab');
                await new Promise(r => setTimeout(r, 3000));
            }

            // 4. Extraer datos del formulario y tablas de créditos/solicitudes
            const extracted = await page.evaluate(() => {
                const getVal = (id: string) => {
                    const el = document.getElementById(id) || document.querySelector(`[id*="${id}"]`);
                    return el ? ((el as HTMLInputElement).value || el.textContent?.trim() || "") : "";
                };

                const nombreCliente = getVal('txtNombreCliente');
                const saldoDisponible = getVal('txtSaldoDisponible');
                const limiteCredito = getVal('dcbLimiteCredito');
                const capital = getVal('dcbCapital');
                const cantidadCreditos = getVal('intCantidadCreditos');
                const categoria = getVal('txtCategoria');

                // Extraer todas las tablas de solicitudes o créditos
                const tables = Array.from(document.querySelectorAll('table')).map(table => {
                    const rows = Array.from(table.querySelectorAll('tr')).map(tr => {
                        return Array.from(tr.querySelectorAll('th, td')).map(td => td.textContent?.trim() || '');
                    }).filter(r => r.length > 0 && r.some(c => c.length > 0));
                    return {
                        id: table.id,
                        className: table.className,
                        rows
                    };
                }).filter(t => t.rows.length > 0);

                const bodyText = document.body.innerText || "";

                return {
                    nombreCliente,
                    saldoDisponible,
                    limiteCredito,
                    capital,
                    cantidadCreditos,
                    categoria,
                    tables,
                    bodyText: bodyText.substring(0, 2000)
                };
            });

            console.log(`[dsi_service] [Creditech Legacy] Datos extraídos para ${searchValue}:`, {
                nombreCliente: extracted.nombreCliente,
                saldoDisponible: extracted.saldoDisponible,
                capital: extracted.capital,
                cantidadCreditos: extracted.cantidadCreditos,
                tablasEncontradas: extracted.tables.length
            });

            // Si el cliente no existe
            if (extracted.bodyText.includes("No se encontró ningún cliente") || (!extracted.nombreCliente && extracted.tables.length === 0)) {
                return { approved: false, msg: `No se encontró ningún crédito o cliente con el identificador ${searchValue} en Creditech Legacy.` };
            }

            // 5. Analizar grillas de solicitudes / créditos para encontrar coincidencia
            let matchedSolicitud: any = null;

            for (const table of extracted.tables) {
                for (const row of table.rows) {
                    const rowStr = row.join(" ").toLowerCase();
                    // Buscar filas que contengan estados aprobados / liquidados / otorgados
                    const isApprovedState = rowStr.includes("aprob") || rowStr.includes("liq") || rowStr.includes("otorg") || rowStr.includes("vigente") || rowStr.includes("activo");
                    
                    if (isApprovedState || table.id.toLowerCase().includes("credito") || table.id.toLowerCase().includes("solicitud")) {
                        // Buscar si coincide número de préstamo o DNI
                        const hasLoanNumber = cleanLoan ? row.some(cell => cell.includes(cleanLoan)) : true;
                        const hasDni = cleanDni ? row.some(cell => cell.replace(/\D/g, "") === cleanDni) : true;

                        if (hasLoanNumber && hasDni) {
                            matchedSolicitud = {
                                tableId: table.id,
                                row
                            };
                            break;
                        }
                    }
                }
                if (matchedSolicitud) break;
            }

            // Si encontramos solicitud en grilla o si el perfil del cliente indica saldo/capital activo
            const rawCapital = extracted.capital || extracted.saldoDisponible || extracted.limiteCredito || "0";
            const numericCapital = parseFloat(rawCapital.replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim()) || 0;

            // Validar monto si fue provisto
            if (amount) {
                const numericInputAmount = parseFloat(amount.toString().replace(/[^\d.-]/g, ''));
                if (!isNaN(numericInputAmount) && numericInputAmount > 0) {
                    // Verificar si en la fila encontrada o en el capital coincide
                    let amountFound = false;
                    if (numericCapital > 0 && Math.abs(numericCapital - numericInputAmount) < 1) {
                        amountFound = true;
                    } else if (matchedSolicitud) {
                        for (const cell of matchedSolicitud.row) {
                            const numCell = parseFloat(cell.replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim());
                            if (!isNaN(numCell) && Math.abs(numCell - numericInputAmount) < 1) {
                                amountFound = true;
                                break;
                            }
                        }
                    }

                    if (!amountFound && numericCapital > 0) {
                        console.warn(`[dsi_service] [Creditech Legacy] Discrepancia de monto: Web[${numericCapital}] vs Input[${numericInputAmount}]`);
                    }
                }
            }

            const customerName = extracted.nombreCliente || "Cliente Creditech";
            const finalAmount = numericCapital > 0 ? numericCapital : (amount ? parseFloat(amount) : 0);

            console.log(`[dsi_service] [Creditech Legacy] ✅ Crédito validado exitosamente para ${customerName}`);

            return {
                approved: true,
                customer: customerName,
                amount: finalAmount,
                msg: "Crédito validado con éxito en Creditech Legacy.",
                raw: {
                    nombreCliente: extracted.nombreCliente,
                    saldoDisponible: extracted.saldoDisponible,
                    capital: extracted.capital,
                    matchedSolicitud
                }
            };

        } catch (error: any) {
            console.error(`[dsi_service] [Creditech Legacy] ❌ Error en consultarCredito: ${error.message}`);
            return { approved: false, msg: `Error en la conexión con Creditech Legacy: ${error.message}` };
        } finally {
            if (browser) await browser.close();
        }
    }
}

export default new CreditechService();
