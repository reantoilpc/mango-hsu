/**
 * mango-hsu Apps Script backend
 *
 * Deploy:
 *   1. Bind this script to the `mango-hsu-orders` Google Sheet
 *   2. Script Properties → add ORDER_TOKEN = <same value as PUBLIC_ORDER_TOKEN in frontend>
 *   3. Deploy → New deployment → Type: Web app
 *      Execute as: Me · Who has access: Anyone
 *   4. Copy the `/exec` URL into Cloudflare Pages env var PUBLIC_APPS_SCRIPT_URL
 *
 * Sheet schema (required):
 *   `settings` — key/value rows: accepting_dry, shipping_fee_twd,
 *     free_shipping_min_packages, eta_days_after_payment,
 *     bank_account_display, support_line_id,
 *     telegram_bot_token, telegram_chat_id
 *   `products` — header: sku | 品名 | 規格 | 單價 | available
 *   `orders`   — header: order_id | created_at | name | phone | address |
 *                items_json | subtotal | shipping | total | expected_memo |
 *                pdpa_accepted | paid | shipped | tracking_no | notes | idempotency_key
 *   `errors`   — header: timestamp | error_code | request_body_json | stack_trace
 */

const STATUS_URL_BASE = "https://mango-hsu.pages.dev/status";

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === "status") return respond(getSiteStatus());
    if (action === "order") return respond(getOrderStatus(e.parameter.id));
    return respond({ ok: false, error_code: "INVALID_INPUT" });
  } catch (err) {
    logError("GET_INTERNAL", JSON.stringify(e.parameter), err);
    return respond({ ok: false, error_code: "INTERNAL" });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (_) {
    return respond({ ok: false, error_code: "INVALID_INPUT" });
  }

  if (body.honeypot && body.honeypot !== "") {
    return respond({ ok: false, error_code: "INVALID_INPUT" });
  }

  const expectedToken = PropertiesService.getScriptProperties().getProperty("ORDER_TOKEN");
  if (!expectedToken || body.token !== expectedToken) {
    return respond({ ok: false, error_code: "INVALID_TOKEN" });
  }

  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return respond({ ok: false, error_code: "INVALID_INPUT" });
  }

  const validationError = validateOrderInput(body);
  if (validationError) return respond(validationError);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return respond({ ok: false, error_code: "LOCKED" });
  }

  try {
    const existing = findByIdempotencyKey(body.idempotency_key);
    if (existing) return respond(existing);

    const settings = readSettings();
    if (!settings.accepting_dry) {
      return respond({ ok: false, error_code: "SEASON_CLOSED" });
    }

    const products = readProducts();
    const productMap = {};
    products.forEach((p) => (productMap[p.sku] = p));

    let subtotal = 0;
    let totalQty = 0;
    for (const it of body.items) {
      const p = productMap[it.sku];
      if (!p) {
        return respond({ ok: false, error_code: "INVALID_INPUT" });
      }
      if (!p.available) {
        return respond({ ok: false, error_code: "SOLD_OUT", sold_out_sku: it.sku });
      }
      subtotal += p.price * it.qty;
      totalQty += it.qty;
    }

    const shipping =
      totalQty >= settings.free_shipping_min_packages ? 0 : settings.shipping_fee_twd;
    const total = subtotal + shipping;

    const orderId = nextOrderId();
    const expectedMemo = `${orderId}-${body.name}`;
    const createdAt = new Date().toISOString();

    const orderRow = {
      order_id: orderId,
      created_at: createdAt,
      name: body.name,
      phone: body.phone,
      address: body.address,
      items_json: JSON.stringify(body.items),
      subtotal: subtotal,
      shipping: shipping,
      total: total,
      expected_memo: expectedMemo,
      pdpa_accepted: body.pdpa_accepted === true,
      paid: false,
      shipped: false,
      tracking_no: "",
      notes: body.notes || "",
      idempotency_key: body.idempotency_key,
    };

    appendOrderRow(orderRow);

    const response = {
      ok: true,
      order_id: orderId,
      subtotal: subtotal,
      shipping: shipping,
      total: total,
      expected_memo: expectedMemo,
      bank_account_display: settings.bank_account_display,
      eta_days_after_payment: settings.eta_days_after_payment,
      status_url: `${STATUS_URL_BASE}?id=${encodeURIComponent(orderId)}`,
    };

    // Telegram notify — non-blocking: failure must not affect the order response.
    try {
      notifyTelegram(settings, orderRow, products);
    } catch (notifyErr) {
      logError("TELEGRAM_FAILED", JSON.stringify(orderRow), notifyErr);
    }

    return respond(response);
  } catch (err) {
    logError("POST_INTERNAL", e.postData ? e.postData.contents : "", err);
    return respond({ ok: false, error_code: "INTERNAL" });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function sheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function readSettings() {
  const s = sheet("settings");
  const values = s.getRange(1, 1, s.getLastRow(), 2).getValues();
  const out = {};
  values.forEach(([k, v]) => {
    if (k) out[k] = v;
  });
  const coerceBool = (v) => v === true || v === "TRUE" || v === "true";
  const coerceNum = (v) => Number(v);
  return {
    accepting_dry: coerceBool(out.accepting_dry),
    shipping_fee_twd: coerceNum(out.shipping_fee_twd),
    free_shipping_min_packages: coerceNum(out.free_shipping_min_packages),
    eta_days_after_payment: coerceNum(out.eta_days_after_payment),
    bank_account_display: String(out.bank_account_display || ""),
    support_line_id: String(out.support_line_id || ""),
    telegram_bot_token: String(out.telegram_bot_token || ""),
    telegram_chat_id: String(out.telegram_chat_id || ""),
  };
}

function readProducts() {
  const s = sheet("products");
  const values = s.getRange(2, 1, s.getLastRow() - 1, 5).getValues();
  return values
    .filter((r) => r[0])
    .map((r) => ({
      sku: String(r[0]),
      name: String(r[1]),
      variant: String(r[2]),
      price: Number(r[3]),
      available: r[4] === true || r[4] === "TRUE" || r[4] === "true",
    }));
}

function findByIdempotencyKey(key) {
  const s = sheet("orders");
  const lastRow = s.getLastRow();
  if (lastRow < 2) return null;
  const header = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  const idemIdx = header.indexOf("idempotency_key");
  if (idemIdx === -1) return null;
  const values = s.getRange(2, 1, lastRow - 1, s.getLastColumn()).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][idemIdx] === key) {
      const row = values[i];
      const settings = readSettings();
      return {
        ok: true,
        order_id: row[header.indexOf("order_id")],
        subtotal: row[header.indexOf("subtotal")],
        shipping: row[header.indexOf("shipping")],
        total: row[header.indexOf("total")],
        expected_memo: row[header.indexOf("expected_memo")],
        bank_account_display: settings.bank_account_display,
        eta_days_after_payment: settings.eta_days_after_payment,
        status_url: `${STATUS_URL_BASE}?id=${encodeURIComponent(row[header.indexOf("order_id")])}`,
      };
    }
  }
  return null;
}

function nextOrderId() {
  const datePart = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd");
  const s = sheet("orders");
  const lastRow = s.getLastRow();
  let maxSeq = 0;
  if (lastRow >= 2) {
    const header = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
    const idIdx = header.indexOf("order_id");
    const ids = s.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
    ids.forEach(([id]) => {
      if (typeof id === "string" && id.indexOf(`M-${datePart}-`) === 0) {
        const seq = Number(id.substring(id.length - 3));
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    });
  }
  const next = String(maxSeq + 1).padStart(3, "0");
  return `M-${datePart}-${next}`;
}

function appendOrderRow(row) {
  const s = sheet("orders");
  const header = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  const r = header.map((h) => (row[h] === undefined ? "" : row[h]));
  s.appendRow(r);
}

function validateOrderInput(body) {
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 50) {
    return { ok: false, error_code: "INVALID_INPUT", message: "姓名格式錯誤" };
  }
  if (!/^09\d{8}$/.test(body.phone || "")) {
    return { ok: false, error_code: "INVALID_INPUT", message: "手機格式錯誤" };
  }
  if (typeof body.address !== "string" || body.address.trim().length < 5 || body.address.length > 200) {
    return { ok: false, error_code: "INVALID_INPUT", message: "地址格式錯誤" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, error_code: "INVALID_INPUT", message: "請至少選購一項" };
  }
  for (const it of body.items) {
    if (!it || typeof it.sku !== "string" || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) {
      return { ok: false, error_code: "INVALID_INPUT", message: "品項格式錯誤" };
    }
  }
  if (body.pdpa_accepted !== true) {
    return { ok: false, error_code: "INVALID_INPUT", message: "未同意個資告知" };
  }
  return null;
}

function getSiteStatus() {
  const settings = readSettings();
  const products = readProducts();
  return {
    accepting_dry: settings.accepting_dry,
    products: products,
    shipping_fee_twd: settings.shipping_fee_twd,
    free_shipping_min_packages: settings.free_shipping_min_packages,
    eta_days_after_payment: settings.eta_days_after_payment,
    bank_account_display: settings.bank_account_display,
    support_line_id: settings.support_line_id,
  };
}

function getOrderStatus(id) {
  if (!id || typeof id !== "string" || !/^M-\d{8}-\d{3}$/.test(id)) {
    return { ok: false, error_code: "INVALID_INPUT" };
  }
  const s = sheet("orders");
  const lastRow = s.getLastRow();
  if (lastRow < 2) return { ok: false, error_code: "NOT_FOUND" };
  const header = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  const idIdx = header.indexOf("order_id");
  const values = s.getRange(2, 1, lastRow - 1, s.getLastColumn()).getValues();
  for (const row of values) {
    if (row[idIdx] === id) {
      const createdAt = row[header.indexOf("created_at")];
      const createdIso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
      return {
        ok: true,
        order_id: id,
        paid: row[header.indexOf("paid")] === true,
        shipped: row[header.indexOf("shipped")] === true,
        tracking_no: row[header.indexOf("tracking_no")] ? String(row[header.indexOf("tracking_no")]) : null,
        created_at: createdIso,
      };
    }
  }
  return { ok: false, error_code: "NOT_FOUND" };
}

function buildOrderMessage(order, products) {
  const productMap = {};
  products.forEach((p) => (productMap[p.sku] = p));
  const items = JSON.parse(order.items_json);
  const itemLines = items
    .map((it) => {
      const p = productMap[it.sku];
      const label = p ? `${p.name} ${p.variant}` : it.sku;
      return `• ${label} × ${it.qty}`;
    })
    .join("\n");
  const shippingLine = order.shipping === 0 ? "免運" : `$${order.shipping}`;
  const statusUrl = `${STATUS_URL_BASE}?id=${encodeURIComponent(order.order_id)}`;
  return [
    `🥭 新訂單 ${order.order_id}`,
    `${order.name}  ${order.phone}`,
    "",
    itemLines,
    "",
    `小計 $${order.subtotal} + 運費 ${shippingLine} = 總計 $${order.total}`,
    "",
    `預期備註：${order.expected_memo}`,
    `收件地址：${order.address}`,
    order.notes ? `客人備註：${order.notes}` : null,
    "",
    `🔗 ${statusUrl}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function notifyTelegram(settings, order, products) {
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;
  const url = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
  const text = buildOrderMessage(order, products);
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      chat_id: settings.telegram_chat_id,
      text: text,
      disable_web_page_preview: true,
    }),
    muteHttpExceptions: true,
  });
}

function logError(code, requestBody, err) {
  try {
    const s = sheet("errors");
    if (!s) return;
    s.appendRow([
      new Date().toISOString(),
      code,
      requestBody || "",
      err && err.stack ? String(err.stack) : String(err),
    ]);
  } catch (_) {
    // best-effort logging — if this fails too, nothing else to do
  }
}

/**
 * Run this manually once after setup to verify Telegram is wired up.
 * It will send a dummy message to your Telegram group.
 */
function testTelegram() {
  const settings = readSettings();
  const fakeOrder = {
    order_id: "M-TEST-001",
    name: "測試客人",
    phone: "0912345678",
    address: "測試地址",
    items_json: '[{"sku":"DRY-JH-1","qty":2}]',
    subtotal: 900,
    shipping: 80,
    total: 980,
    expected_memo: "M-TEST-001-測試客人",
    notes: "這是測試訊息",
  };
  notifyTelegram(settings, fakeOrder, readProducts());
  Logger.log("testTelegram sent");
}

/**
 * Time-driven trigger: run monthly to delete orders older than 6 months
 * (PDPA retention policy).
 * Set up: Apps Script Editor → Triggers → Add Trigger →
 *   purgeOldOrders · Time-driven · Month timer · 1st
 */
function purgeOldOrders() {
  const s = sheet("orders");
  const lastRow = s.getLastRow();
  if (lastRow < 2) return;
  const header = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  const createdIdx = header.indexOf("created_at");
  const values = s.getRange(2, 1, lastRow - 1, s.getLastColumn()).getValues();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const rowsToDelete = [];
  values.forEach((row, i) => {
    const created = row[createdIdx];
    const createdDate = created instanceof Date ? created : new Date(created);
    if (createdDate < sixMonthsAgo) {
      rowsToDelete.push(i + 2); // +2 because sheet is 1-indexed and header row
    }
  });

  // Delete from bottom to keep row indices stable
  rowsToDelete.sort((a, b) => b - a).forEach((r) => s.deleteRow(r));
}
