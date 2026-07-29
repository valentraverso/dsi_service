import puppeteer, { Browser, Page } from 'puppeteer';
import { NotificationService } from './notificationService';

const DSI_BASE = 'http://52.21.150.76/concesionario';
const DSI_LOGIN_URL = `${DSI_BASE}/index.aspx`;
const DSI_NOVEDADES_URL = `${DSI_BASE}/Novedades/frmNovedades.aspx`;
const DSI_VENTA_URL = `${DSI_BASE}/Productos/Venta/frmVentaA.aspx?origen=0`;

export interface ItemVenta {
    codigo: string;
    cantidad: number;
    precioUnitario?: number; // Si se envía, se intenta setear el precio antes de agregar al carrito
}

export interface ClienteVenta {
    documento: string;
    nombre: string;
    apellido?: string;
    email?: string;
    telefono?: string;
}

export interface VentaRepuestosData {
    mlOrderId?: string;        // ID de la orden de Mercado Libre (para tracking en notificaciones de vuelta al backend)
    cliente: ClienteVenta;
    items: ItemVenta[];
    formaPago?: string;        // '1' = Efectivo (default), '106' = Mercado Pago
    montoTotal?: number;       // Si se envía, se usa este valor como monto de pago (en vez de leerlo del server)
    pagoData?: {
        numero?: string;       // N° transacción
        fecha?: string;        // dd/mm/yyyy — default: hoy
        nombre?: string;
        apellido?: string;
    };
    sucursalId?: string;
}

export class PuppeteerService {
    /**
     * Procesa una venta de repuestos de mostrador en DSI usando Puppeteer.
     * Interactúa con el formulario ASP.NET exactamente como un usuario real,
     * evitando los problemas de ViewState / EVENTVALIDATION del enfoque HTTP.
     */
    public static async procesarVentaRepuestos(ventaData: VentaRepuestosData): Promise<{ status: boolean; msg: string }> {
        const startTime = Date.now();
        const orderId = ventaData.mlOrderId || ventaData.pagoData?.numero || "S/N";
        let lastAlertMessage: string | null = null;
        console.log('[DSI Service] Iniciando venta con Puppeteer:', JSON.stringify(ventaData, null, 2));

        // Notificar inicio de Puppeteer al backend central
        NotificationService.notifyBackend({
            processName: "DSI_PROCESAMIENTO_PUPPETEER",
            category: "DSI",
            status: "in_progress",
            input: { orderId, mlOrderId: ventaData.mlOrderId, cliente: ventaData.cliente, items: ventaData.items, montoTotal: ventaData.montoTotal }
        });

        const dsiUser = process.env.DSI_USER || '';
        const dsiPass = process.env.DSI_PASS || '';

        if (!dsiUser || !dsiPass) {
            const msg = 'Faltan DSI_USER y/o DSI_PASS en el .env del dsi_service';
            console.error('[DSI Service]', msg);
            return { status: false, msg };
        }

        const browser: Browser = await puppeteer.launch({
            headless: 'shell' as any,
            // Usar el Chromium embebido de Puppeteer — sin perfil de usuario, sin extensiones,
            // sin restricciones de Safe Browsing que bloqueen URLs con session tokens ASP.NET (S(...)).
            // (Chrome del sistema bloqueaba estas URLs vía ERR_BLOCKED_BY_CLIENT)
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process,SafeBrowsing'
            ],
        });

        try {
            const page: Page = await browser.newPage();
            page.setDefaultTimeout(30000);

            page.on('console', msg => {
                if (msg.type() === 'error') {
                    console.log('[DSI Browser Console Error]', msg.text());
                }
            });
            page.on('pageerror', (err: any) => {
                console.log('[DSI Browser Page Error]', err.message || err);
            });
            page.on('requestfailed', request => {
                console.log('[DSI Request Failed]', request.url(), request.failure()?.errorText || '');
            });
            page.on('response', response => {
                const status = response.status();
                if (status >= 400) {
                    console.log('[DSI HTTP Error]', response.url(), status);
                }
            });

            // Registrar manejador de dialogos (alert, confirm, prompt)
            page.on('dialog', async dialog => {
                const msg = dialog.message();
                console.log(`[DSI Dialog] Tipo: ${dialog.type()}, Mensaje: ${msg}`);
                lastAlertMessage = msg;
                await dialog.accept().catch(() => null);
            });

            // =============================================
            // 1. LOGIN
            // =============================================
            console.log('[DSI Service] Navegando a DSI...');
            // ASP.NET cookieless sessions embeden el token en la URL ej: (S(xxx))/index.aspx
            // Chromium puede bloquear ese redirect — usamos 'load' para capturar el primer response
            // y luego verificamos si el form de login está disponible independientemente.
            await page.goto(DSI_LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(async (err: Error) => {
                console.warn(`[DSI Service] Navigation warning (puede ser redirect ASP.NET): ${err.message}`);
                // Esperar un poco para que el browser resuelva la redirección
                await PuppeteerService.wait(3000);
            });

            // Verificar si el form de login está presente (a pesar del error de redirect)
            const loginInput = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 10000 }).catch(() => null);
            if (!loginInput) {
                // Intentar navegar directo al index.aspx limpio como fallback
                console.warn('[DSI Service] Form de login no encontrado, intentando index.aspx directo...');
                await page.goto('http://52.21.150.76/concesionario/index.aspx', { waitUntil: 'load', timeout: 20000 }).catch(() => null);
                await PuppeteerService.wait(2000);
                const loginInput2 = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 8000 }).catch(() => null);
                if (!loginInput2) {
                    throw new Error('No se pudo acceder al formulario de login de DSI — verificar conectividad con 52.21.150.76');
                }
            }

            console.log('[DSI Service] Formulario de login detectado. URL actual:', page.url());
            await page.type('input[name="txtUser"]', dsiUser, { delay: 50 });
            await page.type('input[name="txtPassword"]', dsiPass, { delay: 50 });

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
                page.click('input[name="btnIniciar"]'),
            ]);

            const currentUrl = page.url();
            if (currentUrl.includes('index.aspx') || currentUrl.toLowerCase().includes('login')) {
                throw new Error('Login fallido — credenciales incorrectas o timeout');
            }
            console.log('[DSI Service] ✅ Login exitoso. URL:', currentUrl);

            // Calentar sesión en Novedades
            await page.goto(DSI_NOVEDADES_URL, { waitUntil: 'networkidle2' });

            // =============================================
            // 2. ABRIR FORMULARIO DE VENTA
            // =============================================
            console.log('[DSI Service] Abriendo formulario de Alta de Venta...');
            await page.goto(DSI_VENTA_URL, { waitUntil: 'networkidle2' });

            // =============================================
            // 3. DATOS DEL CLIENTE
            // =============================================
            console.log('[DSI Service] Ingresando cliente:', ventaData.cliente.documento);

            await PuppeteerService.wait(2000);
            await page.waitForSelector('input[name="ctl00$ContentPlaceHolder1$txtNumDocumento"]', { visible: true });
            await PuppeteerService.wait(1000);

            if (ventaData.sucursalId) {
                await page.evaluate((suc: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$hfId_Sucursal"]');
                    if (el) el.value = suc;
                }, ventaData.sucursalId);
            }

            const DNI_SEL = 'input[name="ctl00$ContentPlaceHolder1$txtNumDocumento"]';
            await page.waitForSelector(DNI_SEL, { visible: true });
            await page.click(DNI_SEL, { count: 3 });
            await page.type(DNI_SEL, ventaData.cliente.documento, { delay: 60 });
            await PuppeteerService.wait(500);

            console.log('[DSI Service] Confirmando cliente con btnAceptar...');
            await page.click('input[name="ctl00$ContentPlaceHolder1$btnAceptar"]');
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => null);
            await PuppeteerService.wait(2000);

            // Nombre
            await page.evaluate((nombre: string) => {
                const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbDatosCliente$txtNombresComprador"]');
                if (el) { el.value = nombre; el.dispatchEvent(new Event('change', { bubbles: true })); }
            }, ventaData.cliente.nombre);

            // Apellido
            if (ventaData.cliente.apellido) {
                await page.evaluate((ap: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbDatosCliente$txtApellidoComprador"]');
                    if (el) { el.value = ap; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, ventaData.cliente.apellido);
            }

            // Email
            if (ventaData.cliente.email) {
                await page.evaluate((email: string) => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$wbDatosCliente$txtEmail"]');
                    if (el) { el.value = email; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, ventaData.cliente.email);
            }

            // =============================================
            // 4. CARGAR ÍTEMS
            // =============================================
            console.log('[DSI Service] Esperando que el formulario de ítems esté listo...');
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => null);
            await PuppeteerService.wait(2000);

            for (const item of ventaData.items) {
                console.log(`[DSI Service] Cargando ítem: ${item.codigo} x${item.cantidad}` +
                    (item.precioUnitario ? ` a $${item.precioUnitario}` : ''));

                // --- 4a. Ingresar código del artículo ---
                // txtCodigo puede estar oculto visualmente pero debe estar en el DOM
                const CODIGO_SEL = 'input[name="ctl00$ContentPlaceHolder1$txtCodigo"]';
                await page.waitForSelector(CODIGO_SEL, { timeout: 8000 });
                // Limpiar campo y escribir el código con interacción real
                await page.evaluate(() => {
                    const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtCodigo"]');
                    if (el) { el.value = ''; el.focus(); }
                });
                await PuppeteerService.wait(300);
                await page.keyboard.type(item.codigo.toUpperCase(), { delay: 60 });

                // Tab dispara la búsqueda AJAX del producto en DSI
                await page.keyboard.press('Tab');
                // Esperar a que el AJAX del producto se complete (networkidle es más confiable que un timeout fijo)
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => null);
                await PuppeteerService.wait(1000);

                // --- 4b. Verificar que el producto fue encontrado (btnPrecioVenta debe aparecer) ---
                const btnPrecio = await page.waitForSelector('input[name*="btnPrecioVenta"]', {
                    visible: true, timeout: 10000
                }).catch(() => null);

                if (!btnPrecio) {
                    throw new Error(`Producto ${item.codigo} no encontrado en inventario DSI`);
                }

                // --- 4c. Setear CANTIDAD con interacción real (click + triple-select + type) ---
                // Esto es crítico: evaluate+dispatchEvent no es suficiente porque ASP.NET lee
                // el valor del campo al hacer submit, y el motor de validación podría ignorar
                // valores seteados solo via JS sin foco/blur real.
                const CANT_SEL = 'input[name="ctl00$ContentPlaceHolder1$txtCantidadRepuesto"]';
                const cantField = await page.$(CANT_SEL);
                if (cantField) {
                    await cantField.click({ count: 3 }); // Seleccionar todo
                    await cantField.type(String(item.cantidad), { delay: 50 });
                    // Blur para confirmar el valor
                    await page.keyboard.press('Tab');
                    await PuppeteerService.wait(400);
                    // Volver el foco al campo de cantidad para asegurarse que ASP.NET lo registró
                    await cantField.click({ count: 3 });
                    await cantField.type(String(item.cantidad), { delay: 50 });
                    await PuppeteerService.wait(300);
                } else {
                    // Fallback: evaluate si el selector no está accesible por Puppeteer
                    console.warn(`[DSI Service] txtCantidadRepuesto no encontrado por selector directo para ${item.codigo}, usando evaluate`);
                    await page.evaluate((cant: string) => {
                        const el = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$txtCantidadRepuesto"]');
                        if (el) {
                            el.focus();
                            el.select();
                            el.value = cant;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    }, String(item.cantidad));
                    await PuppeteerService.wait(400);
                }

                // --- 4d. Setear PRECIO UNITARIO si se especificó ---
                // CRÍTICO: el precio debe quedar en el campo ANTES de clickear btnPrecioVenta,
                // de lo contrario el carrito registra el precio de lista del sistema y el pago
                // resultante no va a coincidir con el monto enviado → DSI rechaza la venta.
                if (item.precioUnitario !== undefined) {
                    const precioFormatted = item.precioUnitario.toFixed(2).replace('.', ',');

                    // Log diagnóstico: mostrar TODOS los inputs de precio disponibles en el DOM
                    const camposDiag = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
                            .filter(el => {
                                const n = (el.name + el.id).toLowerCase();
                                return n.includes('precio') || n.includes('importe') || n.includes('valor');
                            })
                            .map(el => ({
                                name: el.name,
                                id: el.id,
                                value: el.value,
                                type: el.type,
                                disabled: el.disabled,
                                readOnly: el.readOnly,
                                visible: el.offsetParent !== null,
                            }));
                    });
                    console.log(`[DSI Service] Campos de precio encontrados en DOM:`, JSON.stringify(camposDiag, null, 2));

                    // Selectores a intentar en orden de especificidad
                    const PRECIO_SELECTORS = [
                        'input[name="ctl00$ContentPlaceHolder1$txtPrecioVentaRepuesto"]',
                        'input[name="ctl00$ContentPlaceHolder1$txtPrecioVenta"]',
                        'input[name*="txtPrecioVentaRepuesto"]',
                        'input[name*="txtPrecioVenta"]',
                        'input[name*="txtPrecioUnitario"]',
                        'input[name*="txtImporte"]',
                        'input[id*="txtPrecioVentaRepuesto"]',
                        'input[id*="txtPrecioVenta"]',
                    ];

                    let precioSeteado = false;
                    for (const sel of PRECIO_SELECTORS) {
                        const el = await page.$(sel);
                        if (el) {
                            const state = await el.evaluate((node: Element) => {
                                const inp = node as HTMLInputElement;
                                return { disabled: inp.disabled, readOnly: inp.readOnly, value: inp.value, visible: inp.offsetParent !== null };
                            });
                            console.log(`[DSI Service] Probando selector "${sel}": ${JSON.stringify(state)}`);
                            if (!state.disabled && !state.readOnly) {
                                await el.click({ count: 3 });
                                await el.type(precioFormatted, { delay: 60 });
                                await page.keyboard.press('Tab');
                                await PuppeteerService.wait(500);

                                // Verificar que el valor quedó seteado
                                const valorFinal = await el.evaluate((node: Element) => (node as HTMLInputElement).value);
                                console.log(`[DSI Service] ✅ Precio seteado en "${sel}": esperado="${precioFormatted}" actual="${valorFinal}"`);
                                precioSeteado = true;
                                break;
                            }
                        }
                    }

                    if (!precioSeteado) {
                        // Fallback: buscar por texto en el DOM cualquier input habilitado con "precio"/"importe"
                        const fallbackResult = await page.evaluate((precio: string) => {
                            const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'))
                                .filter(el => {
                                    const n = (el.name + el.id).toLowerCase();
                                    return (n.includes('precio') || n.includes('importe') || n.includes('valor'))
                                        && !el.disabled && !el.readOnly;
                                });
                            if (candidates.length === 0) return { ok: false, tried: [] };
                            const target = candidates[candidates.length - 1];
                            target.focus();
                            target.select();
                            target.value = precio;
                            target.dispatchEvent(new Event('input', { bubbles: true }));
                            target.dispatchEvent(new Event('change', { bubbles: true }));
                            target.dispatchEvent(new Event('blur', { bubbles: true }));
                            return { ok: true, name: target.name, id: target.id, value: target.value };
                        }, precioFormatted);

                        if (fallbackResult.ok) {
                            console.log(`[DSI Service] ⚠ Precio seteado via fallback: ${JSON.stringify(fallbackResult)}`);
                            precioSeteado = true;
                        } else {
                            console.warn(`[DSI Service] ❌ No se encontró campo de precio editable para ${item.codigo}. El precio del sistema se usará y puede causar rechazo si no coincide con el monto de pago.`);
                        }
                        await PuppeteerService.wait(400);
                    }
                }

                // --- 4e. Click en "Precio Venta" correspondiente a nuestra sucursal activa ---
                const activeSucursalName = await page.evaluate(() => {
                    const headerEl = document.querySelector('.navbar, #header, .header, td[align="right"]');
                    if (headerEl) {
                        const text = headerEl.textContent || '';
                        const match = text.match(/\(([^)]+)\)/);
                        if (match) return match[1].trim();
                    }
                    const bodyText = document.body.textContent || '';
                    const match2 = bodyText.match(/Valentino Traverso \(([^)]+)\)/i);
                    return match2 ? match2[1].trim() : 'SANTA FE_HONDA';
                });
                console.log(`[DSI Service] Sucursal activa detectada para click: ${activeSucursalName}`);

                const clicked = await page.evaluate((sucName, itemCode) => {
                    const table = document.querySelector('table[id*="dgInventario"]');
                    if (!table) return false;
                    
                    const rows = Array.from(table.querySelectorAll('tr'));
                    const dataRows = rows.filter(r => r.querySelector('input[name*="btnPrecioVenta"]'));
                    
                    // Buscar fila que corresponda al código exacto y a la sucursal
                    let targetRow = dataRows.find(r => {
                        const text = r.textContent.toUpperCase();
                        if (!text.includes(sucName.toUpperCase())) return false;
                        
                        const tds = Array.from(r.querySelectorAll('td'));
                        return tds.some(td => {
                            const tdText = (td.textContent || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
                            const cleanCode = itemCode.toUpperCase().replace(/[^A-Z0-9-]/g, '');
                            return tdText === cleanCode;
                        });
                    });
                    
                    if (!targetRow && dataRows.length > 0) {
                        // Fallback: si no encontramos el código exacto con la sucursal, buscar al menos uno que coincida con la sucursal
                        targetRow = dataRows.find(r => {
                            const text = r.textContent.toUpperCase();
                            return text.includes(sucName.toUpperCase());
                        });
                    }
                    
                    if (!targetRow && dataRows.length > 0) {
                        targetRow = dataRows[0]; // fallback definitivo al primero
                    }
                    
                    if (targetRow) {
                        const btn = targetRow.querySelector<HTMLInputElement>('input[name*="btnPrecioVenta"]');
                        if (btn) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                }, activeSucursalName, item.codigo.toUpperCase());

                if (!clicked) {
                    console.warn(`[DSI Service] No se pudo hacer click en btnPrecioVenta de forma específica, intentando fallback...`);
                    try {
                        if (btnPrecio) await btnPrecio.click();
                    } catch {
                        await page.evaluate(() => {
                            const btn = document.querySelector<HTMLInputElement>('input[name*="btnPrecioVenta"]');
                            if (btn) btn.click();
                        });
                    }
                }

                // Esperar a que el AJAX de agregar ítem complete (actualiza el grid y saldos)
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
                await PuppeteerService.wait(1500);

                if (lastAlertMessage) {
                    const msg = lastAlertMessage;
                    lastAlertMessage = null; // reset
                    const lowerMsg = msg.toLowerCase();
                    if (lowerMsg.includes('stock') || lowerMsg.includes('insuficiente') || lowerMsg.includes('saldo') || lowerMsg.includes('cantidad') || lowerMsg.includes('no hay') || lowerMsg.includes('disponible')) {
                        throw new Error(`no hay stock en DSI: ${msg}`);
                    }
                    throw new Error(`Error en DSI: ${msg}`);
                }

                console.log(`[DSI Service] ✓ Ítem ${item.codigo} x${item.cantidad} agregado al carrito`);
            }

            // =============================================
            // 5. DOUBLE-PASS SAVE PATTERN (PASS 1: SAVE UNPAID)
            // =============================================
            console.log('[DSI Service] [PASS 1] Desmarcando cbFacturar para guardar venta impaga...');
            await page.evaluate(() => {
                const cb = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$cbFacturar"]');
                if (cb) {
                    cb.checked = false;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            await PuppeteerService.wait(500);

            console.log('[DSI Service] [PASS 1] Guardando venta impaga...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                page.click('input[name="ctl00$ContentPlaceHolder1$btnGuardar"]'),
            ]);

            const pass1Url = page.url();
            console.log(`[DSI Service] [PASS 1] URL post-guardado: ${pass1Url}`);

            // Verificar si hubo error en el primer guardado
            if (pass1Url.includes('frmVentaA.aspx')) {
                await page.screenshot({ path: "./screenshot_pass1_error.png", fullPage: true }).catch(() => null);
                const validationErrors = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll('span, div, label, td'));
                    return elements
                        .filter(el => {
                            const style = window.getComputedStyle(el);
                            const isRed = style.color === 'rgb(255, 0, 0)' || style.color === 'red' || el.getAttribute('color') === 'Red';
                            const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
                            return isRed && isVisible && el.textContent.trim().length > 0;
                        })
                        .map(el => el.textContent.trim().replace(/\s+/g, ' '));
                });
                const errMsg = validationErrors.length > 0 
                    ? `Error de validación DSI [PASS 1]: ${validationErrors.join(' | ')}`
                    : 'La venta impaga no se guardó (la página no redirigió)';
                throw new Error(errMsg);
            }

            const match = pass1Url.match(/numero_venta=(\d+)/);
            if (!match) {
                throw new Error(`[DSI Service] No se pudo obtener el número de venta del primer paso. URL final: ${pass1Url}`);
            }
            const saleId = match[1];
            console.log(`[DSI Service] [PASS 1] Venta impaga guardada con ID: ${saleId}`);

            // =============================================
            // 6. DOUBLE-PASS SAVE PATTERN (PASS 2: REGISTER PAYMENT)
            // =============================================
            console.log(`[DSI Service] [PASS 2] Abriendo venta ${saleId} en modo edición (origen=1)...`);
            await page.goto(`http://52.21.150.76/concesionario/Productos/Venta/frmVentaA.aspx?origen=1&id_venta=${saleId}`, { waitUntil: 'networkidle2' });
            await PuppeteerService.wait(2000);

            const formaPagoVal = ventaData.formaPago ?? '1';
            console.log(`[DSI Service] [PASS 2] Configurando forma de pago: ${formaPagoVal}`);

            // Seleccionar Forma de Pago
            const resolvedFormaPago = await page.evaluate((val: string) => {
                const sel = document.querySelector<HTMLSelectElement>('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago"]');
                if (!sel) return '1';
                const options = Array.from(sel.options);
                const hasValue = options.some(o => o.value === val);
                if (hasValue) return val;
                
                const mpOption = options.find(o => {
                    const t = o.text.toUpperCase();
                    return t.includes('MERCADO') || t.includes('PAGO') || t.includes('MP');
                });
                if (mpOption) return mpOption.value;

                const cardOption = options.find(o => {
                    const t = o.text.toUpperCase();
                    return t.includes('TARJETA') || t.includes('DEBITO') || t.includes('CREDITO');
                });
                if (cardOption) return cardOption.value;

                return '1';
            }, formaPagoVal);

            console.log(`[DSI Service] [PASS 2] Seleccionando forma de pago nativa: ${resolvedFormaPago}`);
            await page.select('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago"]', resolvedFormaPago);
            await PuppeteerService.wait(1000);
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
            await PuppeteerService.wait(1500);

            // Seleccionar Concepto si está disponible
            const hasConcepto = await page.evaluate(() => !!document.querySelector('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlConcepto"]'));
            if (hasConcepto) {
                await page.select('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlConcepto"]', '1');
                await PuppeteerService.wait(500);
            }

            // Seleccionar Tarjeta y Plazo si están presentes
            const resolvedTarjeta = await page.evaluate(() => {
                const ddlTarjeta = document.querySelector<HTMLSelectElement>('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlTarjeta"]');
                if (ddlTarjeta && ddlTarjeta.options.length > 1) {
                    const validOption = Array.from(ddlTarjeta.options).find(o => o.value !== '100' && o.value !== '');
                    return validOption ? validOption.value : null;
                }
                return null;
            });

            // Verificar si la forma de pago seleccionada es Mercado Pago (o similar) por su texto para no tocar la tarjeta
            const isMercadoPago = await page.evaluate((val: string) => {
                const sel = document.querySelector<HTMLSelectElement>('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago"]');
                if (!sel) return false;
                const opt = Array.from(sel.options).find(o => o.value === val);
                if (!opt) return false;
                const txt = opt.text.toUpperCase();
                return txt.includes('MERCADO') || txt.includes('PAGO') || txt.includes('MP') || val === '106';
            }, resolvedFormaPago);

            if (resolvedTarjeta && !isMercadoPago) {
                console.log(`[DSI Service] [PASS 2] Seleccionando tarjeta nativa: ${resolvedTarjeta}`);
                await page.select('select[name="ctl00$ContentPlaceHolder1$wbPagos$ddlTarjeta"]', resolvedTarjeta);
                await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
                await PuppeteerService.wait(1500);
            }

            // Rellenar datos adicionales del pago de forma robusta
            const pagoData = ventaData.pagoData ?? {};
            const today = new Date();
            const defaultDate = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
            const montoAPagar = ventaData.montoTotal ? ventaData.montoTotal.toFixed(2).replace('.', ',') : '0,00';

            console.log(`[DSI Service] [PASS 2] Completando campos de pago en el cliente (Monto: ${montoAPagar})...`);
            await page.evaluate((
                data: { numero?: string; fecha?: string; nombre?: string; apellido?: string },
                defDate: string,
                clienteNombre: string,
                clienteApellido: string,
                monto: string
            ) => {
                const setVal = (selector: string, val: string) => {
                    const el = document.querySelector<HTMLInputElement>(selector);
                    if (el) {
                        el.focus();
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                };
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtPlazo"]', '1');
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNumeroTarjeta"]', '1234');
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNumeroCupon"]', data.numero ?? '123456');
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNumTransaccion"]', data.numero ?? '000000');
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtFechaVencimiento"]', data.fecha ?? defDate);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtFechaPago"]', data.fecha ?? defDate);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNombre"]', data.nombre ?? clienteNombre);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtApellido"]', data.apellido ?? clienteApellido);
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtNro_Doc"]', '99999999');
                setVal('input[name="ctl00$ContentPlaceHolder1$wbPagos$txtMonto"]', monto);
            }, pagoData, defaultDate, ventaData.cliente.nombre, ventaData.cliente.apellido ?? '', montoAPagar);

            await PuppeteerService.wait(1000);

            // Clic en Agregar Pago
            console.log('[DSI Service] [PASS 2] Haciendo click en Agregar Pago...');
            try {
                await page.click('input[name="ctl00$ContentPlaceHolder1$btnAgregarPago"]');
            } catch {
                await page.evaluate(() => {
                    const btn = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$btnAgregarPago"]');
                    if (btn) btn.click();
                });
            }
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
            await PuppeteerService.wait(2000);

            // Verificar si el saldo se actualizó a 0
            const saldoFinal = await page.evaluate(() => {
                const el = document.querySelector('span[id*="lblSaldoA"]');
                return el ? el.textContent.trim() : 'no-saldo';
            });
            console.log(`[DSI Service] [PASS 2] Saldo post-pago: ${saldoFinal}`);

            // Guardar venta saldada clickeando btnModificar
            console.log('[DSI Service] [PASS 2] Guardando venta saldada...');
            try {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                    page.click('input[name="ctl00$ContentPlaceHolder1$btnModificar"]')
                ]);
            } catch {
                await page.evaluate(() => {
                    const btn = document.querySelector<HTMLInputElement>('input[name="ctl00$ContentPlaceHolder1$btnModificar"]');
                    if (btn) btn.click();
                });
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
            }

            const finalUrl = page.url();
            console.log(`[DSI Service] [PASS 2] URL final: ${finalUrl}`);

            if (finalUrl.includes('frmVentaA.aspx')) {
                await page.screenshot({ path: "./screenshot_pass2_error.png", fullPage: true }).catch(() => null);
                const validationErrors = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll('span, div, label, td'));
                    return elements
                        .filter(el => {
                            const style = window.getComputedStyle(el);
                            const isRed = style.color === 'rgb(255, 0, 0)' || style.color === 'red' || el.getAttribute('color') === 'Red';
                            const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
                            return isRed && isVisible && el.textContent.trim().length > 0;
                        })
                        .map(el => el.textContent.trim().replace(/\s+/g, ' '));
                });
                const errMsg = validationErrors.length > 0 
                    ? `Error de validación DSI [PASS 2]: ${validationErrors.join(' | ')}`
                    : 'La venta saldada no se guardó (la página no redirigió)';
                throw new Error(errMsg);
            }

            console.log('[DSI Service] ✅ Venta guardada y saldada exitosamente.');
            const successMsg = `Venta procesada correctamente. URL final: ${finalUrl}`;
            
            NotificationService.notifyBackend({
                processName: "DSI_PROCESAMIENTO_PUPPETEER",
                category: "DSI",
                status: "success",
                input: { orderId, mlOrderId: ventaData.mlOrderId },
                output: { msg: successMsg, finalUrl, dsiSaleId: saleId },
                durationMs: Date.now() - startTime
            });

            return { status: true, msg: successMsg };

        } catch (error: any) {
            console.error('[DSI Service] Error en Puppeteer:', error.message);
            const errorMsg = error.message ?? 'Error desconocido';

            NotificationService.notifyBackend({
                processName: "DSI_PROCESAMIENTO_PUPPETEER",
                category: "DSI",
                status: "failed",
                input: { orderId, mlOrderId: ventaData.mlOrderId, cliente: ventaData.cliente, items: ventaData.items, montoTotal: ventaData.montoTotal },
                error: errorMsg,
                durationMs: Date.now() - startTime
            });

            return { status: false, msg: errorMsg };
        } finally {
            await browser.close();
            console.log('[DSI Service] Navegador cerrado.');
        }
    }

    public static async getPaymentMethods(): Promise<any[]> {
        const dsiUser = process.env.DSI_USER || '';
        const dsiPass = process.env.DSI_PASS || '';

        const browser = await puppeteer.launch({
            headless: 'shell' as any,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process,SafeBrowsing'
            ],
        });

        let page: Page | null = null;
        try {
            page = await browser.newPage();
            page.setDefaultTimeout(30000);

            await page.goto(DSI_LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(async (err: Error) => {
                console.warn('[DSI Service] Error o timeout en page.goto a login, intentando recuperar...', err.message);
            });

            // Verificar si el form de login está presente (a pesar del error de redirect)
            const loginInput = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 10000 }).catch(() => null);
            if (!loginInput) {
                console.warn('[DSI Service] Form de login no encontrado, intentando index.aspx directo...');
                await page.goto(DSI_LOGIN_URL, { waitUntil: 'load', timeout: 8000 }).catch(() => null);
                const loginInput2 = await page.waitForSelector('input[name="txtUser"]', { visible: true, timeout: 8000 }).catch(() => null);
                if (!loginInput2) {
                    throw new Error('No se pudo acceder al formulario de login de DSI — verificar conectividad con 52.21.150.76');
                }
            }

            await page.type('input[name="txtUser"]', dsiUser);
            await page.type('input[name="txtPassword"]', dsiPass);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                page.click('input[name="btnIniciar"]'),
            ]);

            await page.goto(DSI_VENTA_URL, { waitUntil: 'networkidle2' });

            await page.waitForSelector('input[name="ctl00$ContentPlaceHolder1$txtNumDocumento"]', { visible: true });
            await page.type('input[name="ctl00$ContentPlaceHolder1$txtNumDocumento"]', "99999999");
            await page.keyboard.press('Tab');
            await PuppeteerService.wait(1000);

            await page.click('input[name="ctl00$ContentPlaceHolder1$btnAceptar"]');
            await page.waitForNetworkIdle({ idleTime: 800 }).catch(() => null);
            await PuppeteerService.wait(1500);

            const selectName = "ctl00$ContentPlaceHolder1$wbPagos$ddlFormaDePago";
            const options = await page.evaluate((name) => {
                const sel = document.querySelector(`select[name="${name}"]`) as HTMLSelectElement;
                if (!sel) return null;
                return Array.from(sel.options).map((o: HTMLOptionElement) => ({ value: o.value, text: o.text }));
            }, selectName);

            return options || [];
        } catch (error: any) {
            const currentUrl = page ? page.url() : 'N/A';
            if (page) {
                await page.screenshot({ path: "./screenshot_dsi_error.png", fullPage: true }).catch(() => null);
            }
            console.error('[DSI Service] Error en getPaymentMethods:', error.message);
            throw new Error(`[getPaymentMethods] Error en URL (${currentUrl}): ${error.message}`);
        } finally {
            await browser.close();
        }
    }

    private static wait(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
